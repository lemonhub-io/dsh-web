/** Public GitHub package discovery and immutable downloads with a server-owned credential. */
const API = 'https://api.github.com/'
const REPOSITORY = /^repos\/([\w.-]+\/[\w.-]+)(?:\/(commits\/[^/]+|git\/(?:trees|blobs)\/[a-f0-9]{40}))?$/

const SORTS = new Set(['updated', 'stars'])

function publicRepository(info) {
  return {
    full_name: info.full_name,
    description: info.description,
    default_branch: info.default_branch,
    private: false,
    stargazers_count: Number.isSafeInteger(info.stargazers_count) ? info.stargazers_count : 0,
    pushed_at: typeof info.pushed_at === 'string' ? info.pushed_at : null,
    topics: Array.isArray(info.topics) ? info.topics.filter(topic => typeof topic === 'string').slice(0, 20) : [],
    license: typeof info.license?.spdx_id === 'string' && info.license.spdx_id !== 'NOASSERTION' ? info.license.spdx_id : null,
  }
}

function json(status, value) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function cors(response, origin) {
  const headers = new Headers(response.headers)
  headers.set('vary', 'origin')
  headers.set('access-control-allow-origin', origin ?? '*')
  headers.set('access-control-allow-methods', 'GET, OPTIONS')
  headers.set('access-control-allow-headers', 'accept')
  headers.set('access-control-expose-headers', 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after')
  headers.set('access-control-max-age', '86400')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(response.body, { status: response.status, headers })
}

async function bounded(response, limit) {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new RangeError('response too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/** Cloudflare module Worker entry point Only allowlisted public GitHub reads reach the upstream API. */
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    const allowed = (env.ALLOWED_ORIGINS ?? 'https://dsh.openhub.today').split(',').map(value => value.trim())
    if (origin !== null && !allowed.includes(origin) &&
      !(env.ALLOW_LOCALHOST !== 'false' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)))
      return json(403, { error: 'origin not allowed' })
    const reply = response => cors(response, origin)
    if (request.method === 'OPTIONS') return reply(new Response(null, { status: 204 }))
    if (request.method !== 'GET') return reply(json(405, { error: 'read-only service' }))
    if (url.pathname === '/' || url.pathname === '/health')
      return reply(json(200, { service: 'dsh-plugin-community', version: '1', githubTokenConfigured: Boolean(env.GITHUB_TOKEN) }))
    if (!url.pathname.startsWith('/github/')) return reply(json(404, { error: 'not found' }))
    const path = url.pathname.slice('/github/'.length)
    const repository = REPOSITORY.exec(path)
    const search = path === 'search/repositories'
    let decoded
    try {
      decoded = decodeURIComponent(path)
    } catch (_invalidPathEncoding) {
      return reply(json(400, { error: 'invalid path encoding' }))
    }
    if ((!repository && !search) || path.length > 512 || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded))
      return reply(json(403, { error: 'path not allowed' }))
    const upstream = new URL(path, API)
    const limit = Number(env.MAX_RESPONSE_BYTES ?? 33554432)
    const mutableTtl = Number(env.CACHE_SECONDS ?? 60)
    const immutableTtl = Number(env.IMMUTABLE_CACHE_SECONDS ?? 3600)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 33554432 ||
      [mutableTtl, immutableTtl].some(value => !Number.isSafeInteger(value) || value < 0 || value > 86400))
      return reply(json(503, { error: 'invalid Worker configuration' }))
    if (search) {
      const query = url.searchParams.get('q') ?? ''
      if (query.length > 256) return reply(json(400, { error: 'query too long' }))
      const sort = url.searchParams.get('sort') ?? 'updated'
      if (!SORTS.has(sort)) return reply(json(400, { error: 'unsupported sort' }))
      upstream.search = new URLSearchParams({ q: `${query} is:public`, per_page: '24', sort }).toString()
    } else if (repository?.[2]?.startsWith('git/trees/')) upstream.search = 'recursive=1'
    const headers = new Headers({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-plugin-community',
    })
    if (env.GITHUB_TOKEN) headers.set('authorization', `Bearer ${env.GITHUB_TOKEN}`)
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)])
    const read = async (address, raw = false) => {
      const requestHeaders = new Headers(headers)
      if (raw) requestHeaders.set('accept', 'application/vnd.github.raw+json')
      const response = await fetch(address, { headers: requestHeaders, signal, redirect: 'manual' })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new Error('GitHub redirect refused')
      }
      return response
    }
    const cache = globalThis.caches?.default
    const key = new Request(url.origin + '/cache/' + upstream.pathname + upstream.search)
    try {
      const cached = await cache?.match(key)
      if (cached) return reply(cached)
      let response
      if (repository) {
        const metadata = await read(API + 'repos/' + repository[1])
        if (!metadata.ok) {
          await metadata.body?.cancel()
          return reply(new Response(null, { status: metadata.status, headers: publicHeaders(metadata) }))
        }
        const bytes = await bounded(metadata, 1024 * 1024)
        const info = JSON.parse(new TextDecoder().decode(bytes))
        if (info.private !== false) return reply(json(404, { error: 'public repository not found' }))
        response = repository[2] === undefined
          ? Response.json(publicRepository(info), { headers: publicHeaders(metadata) })
          : await read(upstream.href, path.includes('/git/blobs/'))
      } else response = await read(upstream.href)
      const publicResponseHeaders = publicHeaders(response)
      if (!response.ok) {
        await response.body?.cancel()
        return reply(new Response(null, { status: response.status, headers: publicResponseHeaders }))
      }
      let bytes = await bounded(response, limit)
      if (search) {
        const value = JSON.parse(new TextDecoder().decode(bytes))
        if (!Array.isArray(value.items)) throw new Error('invalid search result')
        const items = value.items.filter(item => item.private === false).slice(0, 24).map(publicRepository)
        bytes = new TextEncoder().encode(JSON.stringify({ items }))
      }
      const immutable = /\/git\/(?:trees|blobs)\//.test(path)
      const ttl = immutable ? immutableTtl : mutableTtl
      publicResponseHeaders.set('cache-control', `public, max-age=${ttl}`)
      const result = new Response(bytes, { headers: publicResponseHeaders })
      if (cache && ttl > 0) context.waitUntil(cache.put(key, result.clone()))
      return reply(result)
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown failure'
      console.error('Community upstream failure', env.GITHUB_TOKEN ? detail.replaceAll(env.GITHUB_TOKEN, '[redacted]') : detail)
      return reply(json(error instanceof RangeError ? 413 : 502, { error: error instanceof RangeError ? 'response too large' : 'GitHub request failed' }))
    }
  },
}

function publicHeaders(response) {
  const headers = new Headers({ 'cache-control': 'no-store' })
  for (const name of ['content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
    const value = response.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}
