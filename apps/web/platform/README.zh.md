# 部署 DSH Web

[English](README.md) | 中文

构建并发布静态站点。站点显示的名称在构建时确定，所以构建客户端包和镜像时环境中要有 `DSH_CLIENT_TITLE`。

```sh
export DSH_CLIENT_TITLE='DSH Web'
NODE_OPTIONS=--max-old-space-size=8192 pnpm run build:lib:client
pnpm --filter @deepseek-ai/dsh-web-frontend run build:site
rsync -a --delete apps/web/dist-site/ /www/daum/dsh-web-site/
```

CI 在每次推送到 `web-platform` 时构建同一份站点（`.github/workflows/dsh-web.yml`），并运行已安装应用与 web-platform 端到端测试。`dist-site` 构建产物作为工作流 artifact 保留七天。只有仓库变量 `DSH_WEB_SSH_DEPLOY` 为 `true` 时，发布任务才会把该产物复制到服务器，因为它需要的服务器密钥尚未配置。在此之前，请下载产物并执行上面的 `rsync` 命令。

托管服务必须以 `Cache-Control: no-cache` 提供 `sw.js` 和 `index.html`，因为过期的 service worker 会把用户固定在旧版本上。文件要按原样提供，不使用重写规则：不存在的文件必须返回 404。`vfs-image.tar.gz` 必须保留 `Content-Length`，并且不能再次压缩。

Service worker 中的每个文件都绑定了内容哈希。新版本只下载哈希发生变化的文件；如果托管服务返回的内容与哈希不符，新版本就不会安装，因此部署到一半的站点只会让更新等到下一次检查，而不会把用户固定在损坏的版本上。

如需刷新安装对话框中的截图，请在构建后于 `apps/web` 目录运行 `pnpm exec tsx scripts/capture-site-screenshots.ts`，然后重新构建。

DSH Web 仅使用 API Key。Worker 镜像禁用账号登录、账号设置和账号模型路由；侧栏保留设置，首次使用的模型配置直接打开 API Key 编辑器。

线上站点是 `dsh.openhub.today`。`dsh-openhub` Cloudflare 隧道把它转发到本机 `127.0.0.1:3092` 的 Caddy 监听，配置位于 `/etc/caddy/Caddyfile` 的对应区块。旧地址 `dsh.daum.pw` 会跳转到这里。
