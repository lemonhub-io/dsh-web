# Deploying DSH Web

English | [中文](README.zh.md)

Cloudflare Workers serves the static site, including the runtime and VFS image. The visitor's browser runs the harness in a dedicated Web Worker. Set `DSH_CLIENT_TITLE` when building the client bundles and image.

```sh
export DSH_CLIENT_TITLE='DSH Web'
NODE_OPTIONS=--max-old-space-size=8192 pnpm run build:lib:client
pnpm --filter @deepseek-ai/dsh-web-frontend run build:site
npx --yes wrangler@4.145.0 deploy --config apps/web/platform/wrangler.jsonc
```

Run Wrangler from the repository root with the Workers deployment token and account ID available as `CF_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. CI builds and tests every push to `web-platform` and keeps `dist-site` for seven days. The optional publish job uses `DSH_WEB_WORKERS_DEPLOY=true`, the `DSH_WEB_WORKERS_TOKEN` secret and the `DSH_WEB_WORKERS_ACCOUNT_ID` variable.

The Worker serves `index.html` at `/` and Cloudflare returns 404 for missing files. The packaged `_headers` gives the service worker, entry page and VFS image revalidation headers. The image retains its gzip bytes and `Content-Length`.

Each file in the service worker is pinned to a content hash. A version downloads only files whose hash changed, and it refuses to install while the host serves anything else, so a half-finished deployment waits for the next update check instead of pinning a broken version.

A new version installs beside the running one. While the app runs, a notice offers to reload; Later brings the notice back after the person has been away for 15 minutes, and Settings shows the download, the waiting version, and an Update now action. When the app starts with a version waiting and no other window open, that version takes over before the harness starts, so a cold start always runs the newest version. Every switch writes durable storage before the reload.

The install offer appears 45 seconds after the first start, then at most twice more, two weeks apart; declining the browser's own dialog counts as an offer. On iPhone and iPad it explains Add to Home Screen. The page remembers an install, so a browser tab of an installed app says so, until the browser offers the install again.

To refresh the screenshots in the install dialog, run `pnpm exec tsx scripts/capture-site-screenshots.ts` from `apps/web` after a build, then build again.

DSH Web uses API keys only. Account login, account settings, and the account model route are disabled in the Worker image; the sidebar keeps Settings, and first-use model setup opens the API-key editor directly.

The Worker serves `https://dsh-web.mzhub.workers.dev`. To serve the same deployment on `dsh.openhub.today`, bind the `dsh.openhub.today/*` route to `dsh-web` using a credential with Workers Routes Write on `openhub.today`. The existing DNS record stays in place. Removing the route restores the tunnel to Caddy on `127.0.0.1:3092`. The address `dsh.daum.pw` redirects to `dsh.openhub.today`.
