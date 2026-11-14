# Deploying DSH Web

English | [中文](README.zh.md)

Build and publish the static site. The build sets the visible name, so client bundles and the image must be built with `DSH_CLIENT_TITLE` in the environment.

```sh
export DSH_CLIENT_TITLE='DSH Web'
NODE_OPTIONS=--max-old-space-size=8192 pnpm run build:lib:client
pnpm --filter @deepseek-ai/dsh-web-frontend run build:site
rsync -a --delete apps/web/dist-site/ /www/daum/dsh-web-site/
```

CI builds the same site on every push to `web-platform` (`.github/workflows/dsh-web.yml`) and runs the installed-app and web-platform end-to-end tests. The `dist-site` build is kept as a workflow artifact for seven days. The publish job copies that artifact to the server only while the repository variable `DSH_WEB_SSH_DEPLOY` is `true`, because it needs a server key that is not yet provisioned. Until then, download the artifact and run the `rsync` above.

The host must serve `sw.js` and `index.html` with `Cache-Control: no-cache`, because a stale service worker pins an old version. Serve files as stored, without rewrite rules: a missing file has to be a 404. `vfs-image.tar.gz` must keep its `Content-Length` and must not be compressed again.

Each file in the service worker is pinned to a content hash. A version downloads only files whose hash changed, and it refuses to install while the host serves anything else, so a half-finished deployment waits for the next update check instead of pinning a broken version.

To refresh the screenshots in the install dialog, run `pnpm exec tsx scripts/capture-site-screenshots.ts` from `apps/web` after a build, then build again.

DSH Web uses API keys only. Account login, account settings, and the account model route are disabled in the Worker image; the sidebar keeps Settings, and first-use model setup opens the API-key editor directly.

The live site is `dsh.openhub.today`. The `dsh-openhub` Cloudflare tunnel forwards it to a loopback Caddy listener on `127.0.0.1:3092`, a block in `/etc/caddy/Caddyfile`. The old address `dsh.daum.pw` redirects there.
