/**
 * DSH Cloud gateway: a stateless Cloudflare Worker between DSH Web and the GitHub API.
 *
 * It stores nothing and holds no secret. Each request carries the caller's own GitHub token, which is
 * forwarded only to api.github.com. The Worker exists for three reasons the browser cannot cover:
 * it restricts traffic to the small set of GitHub endpoints cloud development needs, it answers CORS
 * only for allowed DSH origins, and it follows log and artifact redirects to signed storage that does
 * not allow cross-origin reads, without sending the token there.
 */

const GITHUB_API = 'https://api.github.com'
const VERSION = '1'
const REPO = String.raw`repos/[\w.-]+/[\w.-]+`

/** GitHub REST paths the gateway forwards; everything else is refused. */
export const ALLOWED_PATHS = [
  /^user$/,
  new RegExp(`^${REPO}$`),
  new RegExp(`^${REPO}/git/(?:trees|commits|blobs|refs)(?:/[\\w./-]+)?$`),
  new RegExp(`^${REPO}/git/ref/heads/[\\w./-]+$`),
  new RegExp(`^${REPO}/contents/[\\w./-]+$`),
  new RegExp(`^${REPO}/actions/workflows/[\\w.-]+(?:/dispatches|/runs)?$`),
  new RegExp(`^${REPO}/actions/runs(?:/\\d+(?:/(?:artifacts|jobs|cancel|logs))?)?$`),
  new RegExp(`^${REPO}/actions/artifacts/\\d+/zip$`),
]

/** Redirect targets for log and artifact downloads. */
const STORAGE_HOST = /(?:^|\.)(?:blob\.core\.windows\.net|actions\.githubusercontent\.com|githubusercontent\.com)$/

/**
 * Decide whether a browser origin may read responses.
 * @param {string | null} origin - request Origin header.
 * @param {Record<string, string | undefined>} env - Worker variables.
 * @returns {string | null} the origin to echo, or null when it is not allowed.
 */
export function allowedOrigin(origin, env) {
  if (origin === null || origin === '') return null
  const list = (env.ALLOWED_ORIGINS ?? 'https://dsh.daum.pw').split(',').map(item => item.trim()).filter(Boolean)
  if (list.includes('*') || list.includes(origin)) return origin
  if (env.ALLOW_LOCALHOST !== 'false' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) return origin
  return null
}

function corsHeaders(origin) {
  const headers = { vary: 'origin', 'cache-control': 'no-store' }
  if (origin === null) return headers
  return {
    ...headers,
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, accept, x-github-api-version',
    'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-reset, link',
    'access-control-max-age': '86400',
  }
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json' } })
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, string | undefined>} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url)
    const requestOrigin = request.headers.get('origin')
    const origin = allowedOrigin(requestOrigin, env)
    const cors = corsHeaders(origin)
    if (requestOrigin !== null && origin === null) return json(403, { error: 'origin not allowed' }, cors)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (url.pathname === '/' || url.pathname === '/health') {
      return json(200, { service: 'dsh-cloud-gateway', version: VERSION, stateless: true }, cors)
    }
    if (!url.pathname.startsWith('/github/')) return json(404, { error: 'not found' }, cors)
    const path = url.pathname.slice('/github/'.length)
    if (path.includes('..') || !ALLOWED_PATHS.some(pattern => pattern.test(path))) {
      return json(403, { error: 'path not allowed' }, cors)
    }
    const authorization = request.headers.get('authorization') ?? ''
    if (!/^(?:Bearer|token) [\w.-]+$/.test(authorization)) return json(401, { error: 'GitHub token required' }, cors)

    const headers = new Headers({
      authorization,
      accept: request.headers.get('accept') ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-cloud-gateway',
    })
    const contentType = request.headers.get('content-type')
    if (contentType !== null) headers.set('content-type', contentType)
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    let upstream = await fetch(`${GITHUB_API}/${path}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    })
    const location = upstream.headers.get('location')
    if (upstream.status >= 300 && upstream.status < 400 && location !== null) {
      const target = new URL(location)
      if (target.protocol !== 'https:' || !STORAGE_HOST.test(target.hostname)) {
        return json(502, { error: 'unexpected redirect' }, cors)
      }
      // Signed storage URLs authorize themselves; the GitHub token never leaves api.github.com.
      upstream = await fetch(target, { headers: { 'user-agent': 'dsh-cloud-gateway' } })
    }
    const out = new Headers(cors)
    for (const name of ['content-type', 'content-length', 'etag', 'link', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      const value = upstream.headers.get(name)
      if (value !== null) out.set(name, value)
    }
    return new Response(upstream.body, { status: upstream.status, headers: out })
  },
}
