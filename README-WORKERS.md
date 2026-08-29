# TikTokAutoSparkWeb 纯 Cloudflare Workers 版

默认管理端账号密码不变：**admin / 123456**

## 与原项目的区别

原项目 = Vue 前端 + Python FastAPI + 本机 Edge/Selenium 浏览器。
本版本 = Vue 前端 + Cloudflare Workers（Node/JS 运行环境）+ Cloudflare Browser Rendering（云端 Chromium），**不依赖任何第三方现成接口**。

- 所有抖音操作仍然走**浏览器页面 DOM / XPath**，逻辑按原 `抖音自动续火花-后端.py` 移植。
- 每日名言改为**本地语录轮换**，不再请求 `v2.xxapi.cn`。
- 管理端密码、Token、登录 Cookie、定时任务存储在 **KV**。

## 部署步骤

### 1. 创建 KV

```bash
wrangler kv namespace create STATE
```

把输出的 `id` 填到 `wrangler.toml` 的 `kv_namespaces.id` 和 `preview_id`。

### 2. 安装依赖并构建前端

```bash
npm install
npm run build
```

这会生成 `dist/`，Worker 会把它作为静态站点服务。

### 3. 本地调试

```bash
npx wrangler dev
```

浏览器打开 `http://localhost:8787/login`，用 `admin / 123456` 登录。

### 4. 部署

```bash
npx wrangler deploy
```

部署后访问你的 `workers.dev` 域名（或你自己的路由域名）。

## 浏览器 Render 绑定说明

`wrangler.toml` 中的 `browser = { binding = "MYBROWSER" }` 需要你的 Cloudflare 账号开启 **Workers Browser Rendering**（Workers Paid 套餐能力）。没有该绑定时，管理端登录、密码修改、任务管理仍可用，但“登录抖音 / 好友 / 发消息 / 截图”等浏览器相关功能会报 `未配置 Browser Rendering 绑定`。

## 抖音登录方式

本版本支持：

1. **手动登录**（推荐）：在设置页选择“手动登录”，粘贴 `Base64Cookie`。
2. **扫码登录**：浏览器会话缓存有效时可使用；若长时间未点击，可能因 Worker isolate 回收而失效，请重新刷新页面后扫码。
3. 获取 Cookie、强制退出、截图、好友列表、发消息、定时任务均按原接口路径实现。

## 注意事项

- 密码修改后保存在 KV，重启 Worker 不会恢复默认密码（与原 Python 内存态不同）。
- 定时任务每分钟 Cron 检查一次，按 `TIMEZONE_OFFSET` 所设时区执行，每个任务每天只执行一次。
- 本站点只做前端 + 自动化调度，不调用任何抖音 HTTP API，所有操作均在云端浏览器页面上模拟。