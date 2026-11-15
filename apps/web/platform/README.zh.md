# 部署 DSH Web

[English](README.md) | 中文

Cloudflare Workers 提供静态站点，包括运行时和 VFS 镜像。访问者的浏览器在专用 Web Worker 中运行 harness。构建客户端包和镜像时设置 `DSH_CLIENT_TITLE`。

```sh
export DSH_CLIENT_TITLE='DSH Web'
NODE_OPTIONS=--max-old-space-size=8192 pnpm run build:lib:client
pnpm --filter @deepseek-ai/dsh-web-frontend run build:site
npx --yes wrangler@4.145.0 deploy --config apps/web/platform/wrangler.jsonc
```

在仓库根目录运行 Wrangler，并通过 `CF_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 提供 Workers 部署令牌和账户 ID。每次推送到 `web-platform`，CI 都会构建和测试，`dist-site` 保留七天。可选的发布任务使用 `DSH_WEB_WORKERS_DEPLOY=true`、`DSH_WEB_WORKERS_TOKEN` 密钥和 `DSH_WEB_WORKERS_ACCOUNT_ID` 变量。

Worker 在 `/` 提供 `index.html`，Cloudflare 对缺失的文件返回 404。打包的 `_headers` 为 service worker、入口页面和 VFS 镜像设置缓存重新验证标头。镜像保留原始 gzip 字节和 `Content-Length`。

Service worker 中的每个文件都绑定了内容哈希。新版本只下载哈希发生变化的文件；如果托管服务返回的内容与哈希不符，新版本就不会安装，因此部署到一半的站点只会让更新等到下一次检查，而不会把用户固定在损坏的版本上。

新版本在当前版本旁边安装。应用运行时会弹出重新加载提示；选择“稍后”后，离开 15 分钟以上再回来会再次提示；设置页会显示下载进度、待更新版本和“立即更新”按钮。应用启动时如果有待更新版本，且没有其他窗口打开，新版本会在 harness 启动前直接接管，因此冷启动总是运行最新版本。每次切换版本都会先写入持久存储再重新加载。

安装提示在首次启动 45 秒后出现，之后最多再出现两次，每次间隔两周；拒绝浏览器自带的安装对话框也计为一次。在 iPhone 和 iPad 上会说明如何添加到主屏幕。页面会记住已安装，因此在浏览器标签页中打开已安装的应用时也会显示已安装，直到浏览器再次提供安装。

如需刷新安装对话框中的截图，请在构建后于 `apps/web` 目录运行 `pnpm exec tsx scripts/capture-site-screenshots.ts`，然后重新构建。

DSH Web 仅使用 API Key。Worker 镜像禁用账号登录、账号设置和账号模型路由；侧栏保留设置，首次使用的模型配置直接打开 API Key 编辑器。

Worker 提供 `https://dsh-web.mzhub.workers.dev`。要让 `dsh.openhub.today` 使用同一个部署，请使用具有 `openhub.today` Workers Routes Write 权限的凭据，将 `dsh.openhub.today/*` 路由绑定到 `dsh-web`。现有 DNS 记录保留。移除路由即可恢复通过隧道转发到 `127.0.0.1:3092` 的 Caddy。`dsh.daum.pw` 跳转到 `dsh.openhub.today`。
