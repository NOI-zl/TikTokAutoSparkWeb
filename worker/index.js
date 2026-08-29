/**
 * TikTokAutoSparkWeb - Cloudflare Workers 版后端
 * 按原 Python/Selenium 项目逻辑用 @cloudflare/puppeteer 1:1 移植：
 * - 所有抖音操作都走浏览器 DOM（XPath），不调用任何第三方现成接口
 * - 每日名言使用本地语录轮换，不请求外部 API
 * - 管理端认证、Cookie、任务通过 KV 持久化
 */

import puppeteer from '@cloudflare/puppeteer'

// ---------------------------------------------------------------------------
// 浏览器会话（与原项目单进程 Selenium 一致：模块级单例）
// ---------------------------------------------------------------------------
let browser = null
let page = null
let browserStarted = false
let workerStartTime = new Date().toISOString()

const DOUYIN_CHAT_URL = 'https://www.douyin.com/chat?isPopup=1'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.5481.177 Safari/537.36'

// 本地备用语录（替换原 xxapi 的每日名言调用，避免访问外部现成接口）
const LOCAL_QUOTES = [
  '早上好呀，记得吃早餐~',
  '今天也要元气满满哦！',
  '别忘了喝水，注意休息。',
  '新的一天，一起加油！',
  '晚安，早点睡哦~',
  '今天过得怎么样？',
  '记得保持好心情~',
  '努力的人最可爱！',
  '周末快乐，放松一下~',
  '今天星星很亮，要开心。',
]

function localQuote(date = new Date()) {
  const key = date.toISOString().slice(0, 10)
  let h = 0
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return LOCAL_QUOTES[h % LOCAL_QUOTES.length]
}

// 由浏览器会话时间生成简短 ID，方便 KV key
function shortId(prefix) {
  const rand = crypto.getRandomValues(new Uint8Array(6))
  let s = ''
  for (const b of rand) s += b.toString(16).padStart(2, '0')
  return `${prefix}_${Date.now().toString(36)}_${s}`
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    },
  })
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function genToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1'
  )
}

async function getState(env, key, fallback = null) {
  const v = await env.STATE.get(key)
  return v === null ? fallback : v
}

// ---------------------------------------------------------------------------
// 管理端认证（默认 admin / 123456，与原项目一致）
// ---------------------------------------------------------------------------
async function adminPasswordHash(env) {
  return getState(env, 'admin_hash', await sha256Hex('123456'))
}

async function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || ''
  if (!auth.startsWith('Bearer ')) {
    return { error: jsonResponse({ code: 401, data: '未授权' }, 200) }
  }
  const token = auth.slice(7)
  const exists = await env.STATE.get(`token:${token}`)
  if (!exists) {
    return { error: jsonResponse({ code: 401, data: '未授权' }, 200) }
  }
  return { token }
}

function getBearer(request) {
  const auth = request.headers.get('Authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : null
}

// ---------------------------------------------------------------------------
// Cookie 处理
// ---------------------------------------------------------------------------
function normalizeCookies(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && (c.name || c.key) && (c.value || c.cookieValue !== undefined))
    .map((c) => ({
      name: c.name || c.key,
      value: c.value ?? c.cookieValue,
      domain: c.domain || '.douyin.com',
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'Lax',
    }))
}

function decodeBase64(s) {
  const clean = String(s).replace(/\s+/g, '')
  try {
    const bin = atob(clean)
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    return bytes
  } catch {
    return null
  }
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes)
}

function bytesToBase64(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function gunzip(bytes) {
  try {
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')))
    const buf = await stream.arrayBuffer()
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

function jsonParseLoose(text) {
  try {
    return JSON.parse(text)
  } catch {
    try {
      const py = text.replace(/False/g, 'false').replace(/True/g, 'true').replace(/None/g, 'null')
      return JSON.parse(py)
    } catch {
      return null
    }
  }
}

async function parseCookiePayload(env, body) {
  let cooke = body?.cooke || body?.cookie || null
  let gzipFlag = !!(body?.gzip_flag || body?.gzipFlag)
  // 兼容 FormData
  if (!cooke) return null
  if (typeof cooke === 'string') {
    // 1) base64 或 gzip+base64
    let bytes = decodeBase64(cooke)
    if (!bytes) {
      // 2) 直接把 JSON 字符串塞进来了
      const direct = jsonParseLoose(cooke)
      return direct ? normalizeCookies(direct) : null
    }
    if (gzipFlag) {
      const un = await gunzip(bytes)
      if (!un) return null
      bytes = un
    }
    let text = bytesToText(bytes)
    // 3) 解压/解码后可能还是一个 JSON 字符串或 base64 字符串
    let parsed = jsonParseLoose(text)
    if (!parsed) {
      const inner = decodeBase64(text)
      if (inner) {
        text = bytesToText(inner)
        parsed = jsonParseLoose(text)
      }
    }
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'string') {
      const innerBytes = decodeBase64(parsed)
      if (innerBytes) {
        const innerText = bytesToText(innerBytes)
        const innerParsed = jsonParseLoose(innerText)
        if (innerParsed) parsed = innerParsed
      } else {
        const inner = jsonParseLoose(parsed)
        if (inner) parsed = inner
      }
    }
    if (Array.isArray(parsed)) return normalizeCookies(parsed)
    if (parsed && parsed.cookies) return normalizeCookies(parsed.cookies)
    return null
  }
  if (Array.isArray(cooke)) return normalizeCookies(cooke)
  return null
}

// ---------------------------------------------------------------------------
// 浏览器 / 抖音页面操作（按原 Selenium 逻辑移植）
// ---------------------------------------------------------------------------
async function getPage(env) {
  if (!env.MYBROWSER) throw new Error('未配置 Browser Rendering 绑定')
  if (!browser) {
    browser = await puppeteer.launch(env.MYBROWSER)
  }
  if (!page || page.isClosed()) {
    page = await browser.newPage()
    await page.setUserAgent(UA)
    // 原项目: driver.set_window_size(1400, 3200)
    await page.setViewport({ width: 1400, height: 3200 })
  }
  browserStarted = true
  return page
}

async function applyCookiesToPage(env, p = null) {
  const target = p || page
  if (!target) return
  const cookies = normalizeCookies(await getStoredCookies(env))
  if (cookies.length) {
    try {
      await target.setCookie(...cookies)
    } catch (e) {
      console.warn('setCookie failed:', e?.message || e)
    }
  }
}

async function getStoredCookies(env) {
  const raw = await getState(env, 'douyin_cookies', '[]')
  return jsonParseLoose(raw) || []
}

async function storeCookies(env, cookies) {
  await env.STATE.put('douyin_cookies', JSON.stringify(normalizeCookies(cookies)))
}

async function keepLoginCookies(env, freshCookies) {
  // 合并页面里的新 cookie 到 KV（保留最新登录态），不让旧 cookie 覆盖掉新值
  const current = await getStoredCookies(env)
  const map = new Map()
  for (const c of [...current, ...normalizeCookies(freshCookies)]) {
    map.set(c.name, { ...map.get(c.name), ...c })
  }
  const merged = [...map.values()]
  await storeCookies(env, merged)
  return merged
}

async function gotoChat(p) {
  const current = p.url()
  if (!current.startsWith('https://www.douyin.com')) {
    await p.goto(DOUYIN_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  } else {
    try {
      await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
    } catch {
      await p.goto(DOUYIN_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    }
  }
  await p.waitForTimeout(1500)
}

async function evalXPath(p, xpath) {
  return p.evaluate((xp) => {
    try {
      const node = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        .singleNodeValue
      return node ? node.textContent.trim() : ''
    } catch {
      return ''
    }
  }, xpath)
}

async function waitXPath(p, xpath, timeout = 15000) {
  await p
    .waitForFunction(
      (xp) => {
        const node = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
          .singleNodeValue
        return !!node
      },
      { timeout },
      xpath
    )
    .catch(() => {})
}

async function clickXPath(p, xpath) {
  return p.evaluate((xp) => {
    try {
      const node = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        .singleNodeValue
      if (node) {
        node.scrollIntoView({ block: 'center' })
        node.click()
        return true
      }
      return false
    } catch {
      return false
    }
  }, xpath)
}

const LOGIN_PANEL_XPATH = '//*[@id="douyin_login_comp_flat_panel"]'

async function isDouyinLoggedIn(p) {
  // 原实现：如果还能找到登录面板，说明未登录
  const found = await p.evaluate((xp) => {
    const node = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
      .singleNodeValue
    return !!node
  }, LOGIN_PANEL_XPATH)
  return !found
}

async function douyinLoginInit(p) {
  // 原实现 LoginInit: 点击登录面板里的登录入口
  const xpath =
    '//*[@id="douyin_login_comp_flat_panel"]/div/div[2]/div/div[4]/p'
  try {
    await waitXPath(p, LOGIN_PANEL_XPATH, 10000)
    await clickXPath(p, xpath)
    await p.waitForTimeout(1200)
  } catch (e) {
    console.warn('LoginInit:', e?.message || e)
  }
}

async function getDouyinFriends(p) {
  // 原实现 Updara_FrinderList 的 XPath 逻辑 1:1 移植
  await waitXPath(p, '//div[contains(@class,"conversationConversationListwrapper")]', 20000)
  return p.evaluate(() => {
    const wrapperX = '//div[contains(@class,"conversationConversationListwrapper")]'
    const doc = document
    const snap = (xp, attr) => {
      try {
        const node = doc.evaluate(xp, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
          .singleNodeValue
        if (!node) return ''
        return attr ? node.getAttribute(attr) || '' : node.textContent.trim()
      } catch {
        return ''
      }
    }
    const countNode = doc.evaluate(
      `count(${wrapperX}/div/div/div)`,
      doc,
      null,
      XPathResult.NUMBER_TYPE,
      null
    )
    const total = Math.min(Number(countNode.numberValue) || 0, 80)
    const out = []
    for (let msgLen = 1; msgLen <= total; msgLen++) {
      const idx = msgLen + 1
      const name = snap(`${wrapperX}/div/div[${idx}]/div[1]/div[2]/div[1]/div[1]`)
      let avatar = snap(`${wrapperX}/div/div[${idx}]/div[1]/div[1]/div/span/img`, 'src')
      if (!avatar) avatar = snap(`${wrapperX}/div/div[${idx}]/div/div/img`, 'src')
      let fire = snap(`${wrapperX}/div/div[${idx}]/div[1]/div[2]/div[1]/div[2]/div[1]/div/div`)
      if (name) out.push({ name, avatar, fire })
    }
    return out
  })
}

async function findFriendPage(p, name) {
  // 查找会话列表里与 name 文本匹配的节点，返回其 XPath index（按原 Send_Frinder 逻辑）
  return p.evaluate((targetName) => {
    const wrapperX = '//div[contains(@class,"conversationConversationListwrapper")]'
    const doc = document
    const snapText = (xp) => {
      try {
        const node = doc.evaluate(xp, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
          .singleNodeValue
        return node ? node.textContent.trim() : ''
      } catch {
        return ''
      }
    }
    const countNode = doc.evaluate(
      `count(${wrapperX}/div/div/div)`,
      doc,
      null,
      XPathResult.NUMBER_TYPE,
      null
    )
    const total = Math.min(Number(countNode.numberValue) || 0, 80)
    for (let msgLen = 1; msgLen <= total; msgLen++) {
      const idx = msgLen + 1
      const xp = `${wrapperX}/div/div[${idx}]/div[1]/div[2]/div[1]/div[1]`
      if (snapText(xp) === targetName) return xp
    }
    return null
  }, name)
}

async function sendDouyinFriendMessage(p, name, text) {
  const friendX = await findFriendPage(p, name)
  if (!friendX) throw new Error(`未找到好友: ${name}`)
  // 原实现: click friend -> sleep 1.5s -> 点击输入区 -> send_keys + ENTER
  await clickXPath(p, friendX)
  await p.waitForTimeout(1500)
  const editorX =
    '//div[contains(@class,"messageEditorimChatEditorContainer")]/div/div'
  await waitXPath(p, '//div[contains(@class,"messageEditorimChatEditorContainer")]', 15000)
  await clickXPath(p, editorX)
  await p.waitForTimeout(300)
  await p.keyboard.type(text, { delay: 30 })
  await p.keyboard.press('Enter')
  await p.waitForTimeout(500)
}

async function getDouyinUsername(p) {
  const content = await p.content()
  const m = content.match(/\\?"nickname\\?":\\?"([^"\\]+)\\?"/)
  if (m && m[1]) return m[1]
  const m2 = content.match(/<title[^>]*>([^<]*)<\/title>/)
  return m2 ? m2[1].trim() : '抖音用户'
}

async function openChatReady(env) {
  const p = await getPage(env)
  await applyCookiesToPage(env, p)
  await gotoChat(p)
  return p
}

// ---------------------------------------------------------------------------
// 任务处理
// ---------------------------------------------------------------------------
async function readTasks(env) {
  const raw = await getState(env, 'tasks', '[]')
  const list = jsonParseLoose(raw)
  return Array.isArray(list) ? list : []
}

async function writeTasks(env, tasks) {
  await env.STATE.put('tasks', JSON.stringify(tasks))
}

function formatTime(timeStr) {
  const s = String(timeStr || '').replace('：', ':').trim() || '22:00'
  const parts = s.split(':')
  if (parts.length !== 2) return '22:00'
  const h = Number(parts[0])
  const m = Number(parts[1])
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return '22:00'
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------
async function handleApi(request, env, ctx) {
  const url = new URL(request.url)
  let path = url.pathname
  if (path.startsWith('/api')) path = path.slice(4)
  if (!path.startsWith('/')) path = '/' + path
  const method = request.method.toUpperCase()
  const q = url.searchParams

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: jsonResponse({}).headers })
  }

  // —— 管理端登录（不做管理员鉴权）——
  if (method === 'GET' && path === '/Api/Login/Admin') {
    const username = q.get('username') || ''
    const password = q.get('password') || ''
    if (username === 'admin' && (await sha256Hex(password)) === (await adminPasswordHash(env))) {
      await env.STATE.put('last_login_ip', clientIp(request))
      if (!(await env.STATE.get('worker_start_time'))) {
        await env.STATE.put('worker_start_time', workerStartTime)
      }
      const token = await genToken()
      await env.STATE.put(`token:${token}`, '1', { expirationTtl: 7 * 24 * 3600 })
      return jsonResponse({ code: 200, data: token })
    }
    return jsonResponse({ code: 400, data: '登录失败' })
  }

  const admin = await requireAdmin(request, env)
  if (admin.error) return admin.error

  try {
    // —— 基础状态 ——
    if (method === 'GET' && path === '/Home') {
      const t = await getState(env, 'worker_start_time', workerStartTime)
      return jsonResponse({ time: t })
    }

    if (method === 'GET' && path === '/Api/GetLastLoginIP') {
      return jsonResponse({ code: 200, data: await getState(env, 'last_login_ip', '无') })
    }

    if (method === 'GET' && path === '/Api/logout') {
      const token = getBearer(request)
      if (token) await env.STATE.delete(`token:${token}`)
      return jsonResponse({ code: 200, data: '已退出登录' })
    }

    if (method === 'GET' && path === '/Api/ChangePassword') {
      const oldPwd = q.get('old_password') || ''
      const newPwd = q.get('new_password') || ''
      if ((await sha256Hex(oldPwd)) !== (await adminPasswordHash(env))) {
        return jsonResponse({ code: 400, data: '原密码错误' })
      }
      if (!newPwd) return jsonResponse({ code: 400, data: '新密码不能为空' })
      await env.STATE.put('admin_hash', await sha256Hex(newPwd))
      return jsonResponse({ code: 200, data: '密码修改成功' })
    }

    // —— 浏览器初始化 / 状态（对应 Python 的 init / GetInit）——
    if (method === 'GET' && path === '/Api/Init') {
      browserStarted = false
      const p = await getPage(env)
      await applyCookiesToPage(env, p)
      await gotoChat(p)
      browserStarted = true
      return jsonResponse({ code: 200, data: 'success' })
    }

    if (method === 'GET' && path === '/Api/GetInit') {
      return jsonResponse({ code: 200, data: browserStarted ? 'Yes' : 'No' })
    }

    if (method === 'GET' && path === '/Api/GetLogin') {
      const flag = await getState(env, 'douyin_login', 'No')
      return jsonResponse({ code: 200, data: flag })
    }

    if (method === 'GET' && path === '/Api/LoginDebug') {
      await env.STATE.put('douyin_login', 'Yes')
      return jsonResponse({ code: 200, data: 'OK' })
    }

    // —— 手动 Cookie 登录（原 POST /Api/login，含 gzip）——
    if (method === 'POST' && path === '/Api/login') {
      let body = {}
      try {
        if (request.headers.get('content-type')?.includes('application/json')) {
          body = await request.json()
        } else {
          const form = await request.formData()
          for (const [k, v] of form.entries()) body[k] = v
        }
      } catch {
        body = {}
      }

      const cookies = await parseCookiePayload(env, body)
      if (!cookies || cookies.length === 0) {
        return jsonResponse({ code: '404', data: 'login-error-cookie parse error' })
      }

      const p = await getPage(env)
      try {
        await p.setCookie(...cookies)
        await gotoChat(p)
        const logged = await isDouyinLoggedIn(p)
        if (logged) {
          await env.STATE.put('douyin_login', 'Yes')
          await storeCookies(env, cookies)
          return jsonResponse({ code: 200, data: 'ok' })
        }
        const debug = env.DOUYIN_SKIP_VERIFY === 'true'
        if (debug) {
          // 调试态允许存储 cookie 而不做页面校验
          await env.STATE.put('douyin_login', 'Yes')
          await storeCookies(env, cookies)
          return jsonResponse({ code: 200, data: 'ok' })
        }
        return jsonResponse({ code: '404', data: 'login-error-cooker cant login' })
      } finally {
        ctx.waitUntil(p.close().catch(() => {}).then(() => (page = null)))
      }
    }

    // —— 获取 Base64Cookie（原 GetCooker）——
    if (method === 'GET' && path === '/Api/login/Init/GetCooker') {
      const password = q.get('password') || ''
      if (!password || (await sha256Hex(password)) !== (await adminPasswordHash(env))) {
        return jsonResponse({ code: 400, data: '密码错误' })
      }
      if ((await getState(env, 'douyin_login', 'No')) !== 'Yes') {
        return jsonResponse({ code: 400, data: '未登录' })
      }
      const cookies = await getStoredCookies(env)
      const cookieJson = JSON.stringify(cookies)
      const b64 = bytesToBase64(new TextEncoder().encode(cookieJson))
      return jsonResponse({ code: 200, data: { cooke: b64 } })
    }

    // —— 强制退出登录 ——
    if (method === 'GET' && path === '/Api/DieLogin') {
      try {
        const p = await getPage(env)
        await p.deleteCookie(...(await getStoredCookies(env)))
      } catch {}
      await env.STATE.put('douyin_login', 'No')
      await storeCookies(env, [])
      return jsonResponse({ code: 200, data: '已清除Cooke' })
    }

    // —— 好友列表 ——
    if (method === 'GET' && path === '/Api/GetFriendsList') {
      const p = await openChatReady(env)
      try {
        if (!(await isDouyinLoggedIn(p))) {
          await env.STATE.put('douyin_login', 'No')
          return jsonResponse({ code: 404, data: '未登录抖音' })
        }
        const list = await getDouyinFriends(p)
        if (!list || list.length === 0) {
          return jsonResponse({ code: 404, data: '暂无好友或页面未加载' })
        }
        const dict = {}
        for (const v of list) dict[v.name] = [v.avatar, v.fire]
        return jsonResponse({ code: 200, data: { count: list.length, list: dict } })
      } catch (e) {
        return jsonResponse({ code: 404, data: e?.message || String(e) })
      }
    }

    // —— 发送消息 ——
    if (method === 'GET' && path === '/Api/Send') {
      const name = q.get('name') || ''
      const text = q.get('text') || ''
      if (!name || !text) return jsonResponse({ code: 404, data: '参数错误' })
      const p = await openChatReady(env)
      try {
        if (!(await isDouyinLoggedIn(p))) {
          await env.STATE.put('douyin_login', 'No')
          return jsonResponse({ code: 404, data: '未登录抖音' })
        }
        await sendDouyinFriendMessage(p, name, text)
        return jsonResponse({ code: 200, data: 'Send successfully' })
      } catch (e) {
        return jsonResponse({ code: 404, data: e?.message || String(e) })
      }
    }

    // —— 用户名 ——
    if (method === 'GET' && path === '/Api/GetUsername') {
      if ((await getState(env, 'douyin_login', 'No')) !== 'Yes') {
        return jsonResponse({ code: 400, data: '未登录' })
      }
      const p = await openChatReady(env)
      try {
        if (!(await isDouyinLoggedIn(p))) return jsonResponse({ code: 400, data: '未登录' })
        return jsonResponse({ code: 200, data: await getDouyinUsername(p) })
      } catch (e) {
        return jsonResponse({ code: 400, data: e?.message || String(e) })
      }
    }

    // —— 截图 ——
    if (method === 'GET' && path === '/Api/GetScrlk') {
      const p = await openChatReady(env)
      try {
        const shot = await p.screenshot({ encoding: 'base64' })
        return jsonResponse({ code: 200, data: shot })
      } catch (e) {
        return jsonResponse({ code: 400, data: `截图错误:${e?.message || e}` })
      }
    }

    // —— 扫码登录（保留原接口，浏览器会话有效时可用）——
    if (method === 'GET' && path === '/Api/Pnglogin') {
      const p = await getPage(env)
      try {
        const fresh = await p.cookies()
        if (fresh && fresh.length) await keepLoginCookies(env, fresh)
        await gotoChat(p)
        if (!(await isDouyinLoggedIn(p))) {
          return jsonResponse({ code: '404', data: '系统繁忙,请稍后重新登录' })
        }
        await env.STATE.put('douyin_login', 'Yes')
        await keepLoginCookies(env, await p.cookies())
        return jsonResponse({ code: 200, data: 'ok' })
      } catch (e) {
        return jsonResponse({ code: '404', data: e?.message || String(e) })
      }
    }

    if (method === 'GET' && path === '/Api/login/Init/GetLoginPng') {
      const p = await getPage(env)
      try {
        await applyCookiesToPage(env, p)
        await gotoChat(p)
        await douyinLoginInit(p)
        const refreshX = '//*[@id="animate_qrcode_container"]/div[2]/div'
        try {
          await waitXPath(p, refreshX, 8000)
          await clickXPath(p, refreshX)
          await p.waitForTimeout(5000)
        } catch {}
        const imgX = '//*[@id="animate_qrcode_container"]/div[2]/img'
        await waitXPath(p, imgX, 15000)
        const src = await p.evaluate((xp) => {
          const node = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
            .singleNodeValue
          return node ? node.getAttribute('src') || node.src || '' : ''
        }, imgX)
        if (!src) return jsonResponse({ code: 404, data: 'cant find LoginPng src attribute' })
        return jsonResponse({ code: 200, data: src })
      } catch (e) {
        return jsonResponse({ code: 404, data: e?.message || String(e) })
      }
    }

    // 手机验证码登录在 Workers 无持久会话时不稳定，返回原版说明；后续如需可继续用浏览器页操作移植
    if (method === 'GET' && path === '/Api/LoginPhone') {
      return jsonResponse({ code: 400, data: 'Workers版暂未开启手机验证码，请使用手动登录' })
    }
    if (method === 'GET' && path === '/Api/LoginPhoneInput') {
      return jsonResponse({ code: 400, data: 'Workers版暂未开启手机验证码，请使用手动登录' })
    }

    // —— 定时任务（结构与原项目一致）——
    if (method === 'GET' && path === '/Time/add') {
      const time = formatTime(q.get('time'))
      const name = q.get('name') || ''
      const text = q.get('text') || null
      if (!name) return jsonResponse({ code: 400, data: '缺少好友名' })
      const tasks = await readTasks(env)
      if (tasks.some((t) => t.name === name)) {
        return jsonResponse({ code: 400, data: `好友 ${name} 已有定时任务，请先删除或修改` })
      }
      const taskId = `${time}_${name}`
      tasks.push({
        task_id: taskId,
        time,
        name,
        text: text || '',
        next_run: null,
        last_run_date: '',
      })
      await writeTasks(env, tasks)
      return jsonResponse({ code: 200, data: `已添加定时任务: ${time}`, task_id: taskId })
    }

    if (method === 'GET' && path === '/Time/del') {
      const taskId = q.get('task_id') || ''
      const tasks = await readTasks(env)
      const next = tasks.filter((t) => t.task_id !== taskId)
      if (next.length === tasks.length) {
        return jsonResponse({ code: 404, data: '任务ID不存在' })
      }
      await writeTasks(env, next)
      return jsonResponse({ code: 200, data: `已删除任务: ${taskId}` })
    }

    if (method === 'GET' && path === '/Time/edit') {
      const name = q.get('name') || ''
      const newTime = formatTime(q.get('new_time'))
      const tasks = await readTasks(env)
      const task = tasks.find((t) => t.name === name)
      if (!task) return jsonResponse({ code: 404, data: `好友 ${name} 没有定时任务` })
      const oldTime = task.time
      task.time = newTime
      task.task_id = `${newTime}_${name}`
      await writeTasks(env, tasks)
      return jsonResponse({
        code: 200,
        data: `已将 ${name} 的定时任务从 ${oldTime} 修改为 ${newTime}`,
        old_time: oldTime,
        new_time: newTime,
        task_id: task.task_id,
      })
    }

    if (method === 'GET' && path === '/Time/getlist') {
      const tasks = await readTasks(env)
      return jsonResponse({ code: 200, data: { count: tasks.length, tasks } })
    }

    return jsonResponse({ code: 404, data: `未知接口: ${path}` })
  } catch (e) {
    return jsonResponse({ code: 500, data: e?.message || String(e) })
  }
}

// ---------------------------------------------------------------------------
// 静态站点
// ---------------------------------------------------------------------------
async function serveStatic(request, env) {
  try {
    return await env.ASSETS.fetch(request)
  } catch (e) {
    const url = new URL(request.url)
    url.pathname = '/index.html'
    try {
      return await env.ASSETS.fetch(new Request(url.toString(), request))
    } catch {
      return jsonResponse({ code: 500, data: '静态资源未构建，请先运行 npm run build' }, 500)
    }
  }
}

// 定时执行任务（每分钟触发，早上只发一次）
async function runScheduled(env, ctx) {
  const offsetHours = Number(env.TIMEZONE_OFFSET || '8')
  const now = new Date(Date.now() + offsetHours * 3600 * 1000)
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
  const today = now.toISOString().slice(0, 10)

  const tasks = await readTasks(env)
  for (const task of tasks) {
    if (task.time !== hhmm) continue
    if (task.last_run_date === today) continue
    const lockKey = `cron_lock:${task.task_id}`
    const locked = await env.STATE.get(lockKey)
    if (locked) continue
    await env.STATE.put(lockKey, '1', { expirationTtl: 120 })

    // 异步执行，不阻塞其他任务
    ctx.waitUntil(
      (async () => {
        try {
          const p = await openChatReady(env)
          if (!(await isDouyinLoggedIn(p))) {
            await env.STATE.put('douyin_login', 'No')
            return
          }
          const text = task.text || localQuote(now)
          await sendDouyinFriendMessage(p, task.name, text)
          await env.STATE.put('douyin_login', 'Yes')
          task.last_run_date = today
          task.next_run = null
          await writeTasks(env, tasks)
        } catch (e) {
          console.warn(`task ${task.task_id} failed:`, e?.message || e)
        } finally {
          await env.STATE.delete(lockKey).catch(() => {})
        }
      })()
    )
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api')) {
      return handleApi(request, env, ctx)
    }
    return serveStatic(request, env)
  },

  async scheduled(event, env, ctx) {
    return runScheduled(env, ctx)
  },
}