/** Public GitHub plugin discovery, inspection and downloads proxied with a server-owned credential. */
const API = 'https://api.github.com/'
const REPOSITORY = /^repos\/([\w.-]+\/[\w.-]+)(?:\/(commits\/[^/]+|git\/(?:trees|blobs)\/[a-f0-9]{40}|packages|blobs))?$/
const SHA = /^[a-f0-9]{40}$/
const SEGMENT = /^[A-Za-z0-9_.@+-]+$/
const SORTS = new Set(['updated', 'stars'])
const MANIFESTS = 24
const MANIFEST_BYTES = 256 * 1024
const BATCH = 24
const FILE_HOSTS = new Set(['raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const RELEASE_PATH = /^\/[\w.-]+\/[\w.-]+\/(?:releases\/download|raw)\//
const REDIRECT_REFUSED = 'GitHub redirect refused'

/** A non-success upstream status relayed to the browser with its public headers. */
class Upstream extends Error {
  constructor(status, headers) {
    super(`GitHub responded ${status}`)
    this.status = status
    this.headers = headers
  }
}

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
  headers.set('access-control-expose-headers', 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after, x-dsh-stale')
  headers.set('access-control-max-age', '86400')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(response.body, { status: response.status, headers })
}

function publicHeaders(response) {
  const headers = new Headers({ 'cache-control': 'no-store' })
  for (const name of ['content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
    const value = response.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

function concat(chunks, size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)) {
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
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
  return concat(chunks, size)
}

/** Read a successful upstream body within `limit` bytes, or relay its failure status. */
async function body(response, limit) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Upstream(response.status, publicHeaders(response))
  }
  return bounded(response, limit)
}

function parse(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes))
}

function base64(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

async function gitBlobSha(bytes) {
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', concat([prefix, bytes])))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function pool(items, width, task) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index])
    }
  }))
  return results
}

/** GitHub failures that a cached copy may stand in for: outages, rate limits and transport errors. */
function transient(error) {
  if (error instanceof Upstream) return error.status >= 500 || error.status === 429 || error.headers.get('x-ratelimit-remaining') === '0'
  return !(error instanceof RangeError)
}

/** Cloudflare module Worker entry point Only allowlisted public GitHub reads reach upstream services. */
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
      return reply(json(200, { service: 'dsh-plugin-community', version: '2', githubTokenConfigured: Boolean(env.GITHUB_TOKEN) }))
    const limit = Number(env.MAX_RESPONSE_BYTES ?? 33554432)
    const mutableTtl = Number(env.CACHE_SECONDS ?? 60)
    const immutableTtl = Number(env.IMMUTABLE_CACHE_SECONDS ?? 3600)
    const staleTtl = Number(env.STALE_SECONDS ?? 604800)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 33554432 ||
      [mutableTtl, immutableTtl].some(value => !Number.isSafeInteger(value) || value < 0 || value > 86400) ||
      !Number.isSafeInteger(staleTtl) || staleTtl < 0 || staleTtl > 2592000)
      return reply(json(503, { error: 'invalid Worker configuration' }))

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)])
    const github = new Headers({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-plugin-community',
    })
    if (env.GITHUB_TOKEN) github.set('authorization', `Bearer ${env.GITHUB_TOKEN}`)
    // One retry absorbs a transient GitHub outage; redirects and client errors are final.
    const read = async (address, headers) => {
      for (let attempt = 0; ; attempt += 1) {
        let response
        try {
          response = await fetch(address, { headers, signal, redirect: 'manual' })
        } catch (error) {
          if (attempt > 0 || signal.aborted) throw error
          await new Promise(resolve => setTimeout(resolve, 400))
          continue
        }
        if (response.status >= 500 && attempt === 0) {
          await response.body?.cancel()
          await new Promise(resolve => setTimeout(resolve, 400))
          continue
        }
        return response
      }
    }
    const api = async (path, raw = false) => {
      const headers = new Headers(github)
      if (raw) headers.set('accept', 'application/vnd.github.raw+json')
      const response = await read(API + path, headers)
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new Error(REDIRECT_REFUSED)
      }
      return response
    }
    const visible = async (repository) => {
      const info = parse(await body(await api('repos/' + repository), 1024 * 1024))
      if (info.private !== false) throw new Upstream(404, new Headers({ 'cache-control': 'no-store' }))
      return info
    }
    const blob = async (repository, sha, room) => {
      const bytes = await body(await api(`repos/${repository}/git/blobs/${sha}`, true), room)
      if (await gitBlobSha(bytes) !== sha) throw new Error('GitHub blob identity mismatch')
      return bytes
    }

    let produce
    let ttl = mutableTtl
    let type = 'application/json'
    if (url.pathname === '/fetch') {
      let target
      try {
        target = new URL(url.searchParams.get('url') ?? '')
      } catch (_invalidTarget) {
        return reply(json(400, { error: 'invalid url' }))
      }
      const permitted = address => address.protocol === 'https:' && address.username === '' && address.password === '' &&
        address.port === '' && (FILE_HOSTS.has(address.hostname) || (address.hostname === 'github.com' && RELEASE_PATH.test(address.pathname)))
      if (!permitted(target)) return reply(json(403, { error: 'only public GitHub file hosts are proxied' }))
      type = 'application/octet-stream'
      produce = async () => {
        let address = target
        // Release and raw links redirect between GitHub file hosts; the credential is never sent to them.
        for (let hop = 0; hop < 4; hop += 1) {
          const response = await read(address.href, new Headers({ 'user-agent': 'dsh-plugin-community' }))
          if (response.status < 300 || response.status >= 400) return { bytes: await body(response, limit), headers: publicHeaders(response) }
          await response.body?.cancel()
          address = new URL(response.headers.get('location') ?? '', address)
          if (!permitted(address)) throw new Error(REDIRECT_REFUSED)
        }
        throw new Error(REDIRECT_REFUSED)
      }
    } else if (url.pathname.startsWith('/github/')) {
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
      if (search) {
        const query = url.searchParams.get('q') ?? ''
        if (query.length > 256) return reply(json(400, { error: 'query too long' }))
        const sort = url.searchParams.get('sort') ?? 'updated'
        if (!SORTS.has(sort)) return reply(json(400, { error: 'unsupported sort' }))
        const perPage = Number(url.searchParams.get('per_page') ?? 24)
        const page = Number(url.searchParams.get('page') ?? 1)
        if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100 || !Number.isSafeInteger(page) || page < 1 || page * perPage > 1000)
          return reply(json(400, { error: 'unsupported page' }))
        const upstream = new URLSearchParams({ q: `${query} is:public`, per_page: String(perPage), page: String(page), sort })
        produce = async () => {
          const response = await api('search/repositories?' + upstream.toString())
          const value = parse(await body(response, limit))
          if (!Array.isArray(value.items)) throw new Error('invalid search result')
          const items = value.items.filter(item => item.private === false).slice(0, perPage).map(publicRepository)
          const total = Number.isSafeInteger(value.total_count) ? value.total_count : items.length
          return { bytes: new TextEncoder().encode(JSON.stringify({ total_count: total, items })), headers: publicHeaders(response) }
        }
      } else {
        const [, name, detail] = repository
        if (detail === undefined) {
          produce = async () => ({ bytes: new TextEncoder().encode(JSON.stringify(publicRepository(await visible(name)))), headers: new Headers() })
        } else if (detail === 'packages') {
          const ref = url.searchParams.get('ref') ?? ''
          const directory = url.searchParams.get('directory') ?? ''
          if (ref === '' || ref.length > 255 || ref.split('/').some(part => part === '' || part === '.' || part === '..') ||
            (directory !== '' && directory.split('/').some(part => !SEGMENT.test(part) || part === '.' || part === '..')))
            return reply(json(400, { error: 'invalid ref or directory' }))
          if (SHA.test(ref)) ttl = immutableTtl
          produce = async () => {
            await visible(name)
            const commit = parse(await body(await api(`repos/${name}/commits/${encodeURIComponent(ref)}`), 1024 * 1024))
            const tree = commit.commit?.tree?.sha
            if (!SHA.test(commit.sha ?? '') || !SHA.test(tree ?? '')) throw new Error('invalid commit')
            const listing = parse(await body(await api(`repos/${name}/git/trees/${tree}?recursive=1`), limit))
            if (listing.truncated !== false || !Array.isArray(listing.tree)) throw new RangeError('tree truncated')
            const prefix = directory === '' ? '' : directory + '/'
            const files = listing.tree
              .filter(entry => entry.type === 'blob' && typeof entry.path === 'string' && entry.path.startsWith(prefix))
              .map(entry => ({ path: entry.path, sha: entry.sha, size: entry.size, mode: entry.mode }))
            const manifests = files.filter(file => /(?:^|\/)package\.json$/.test(file.path) &&
              !file.path.split('/').some(part => part === 'node_modules' || part.startsWith('.')))
            if (manifests.length > MANIFESTS || manifests.some(file => !(file.size <= MANIFEST_BYTES)))
              throw new RangeError('too many or oversized manifests')
            if (manifests.some(file => !SHA.test(file.sha ?? ''))) throw new Error('invalid tree')
            const contents = await pool(manifests, 8, file => blob(name, file.sha, MANIFEST_BYTES))
            const result = {
              commit: commit.sha,
              files,
              manifests: manifests.map((file, index) => ({ path: file.path, data: base64(contents[index]) })),
            }
            return { bytes: new TextEncoder().encode(JSON.stringify(result)), headers: new Headers() }
          }
        } else if (detail === 'blobs') {
          const shas = (url.searchParams.get('sha') ?? '').split(',')
          if (shas.length > BATCH || shas.some(sha => !SHA.test(sha)) || new Set(shas).size !== shas.length)
            return reply(json(400, { error: `request 1 to ${BATCH} distinct blob identities` }))
          ttl = immutableTtl
          type = 'application/octet-stream'
          produce = async () => {
            await visible(name)
            const bytes = concat(await pool(shas, 6, sha => blob(name, sha, limit)))
            if (bytes.length > limit) throw new RangeError('response too large')
            return { bytes, headers: new Headers() }
          }
        } else {
          if (detail.startsWith('git/')) ttl = immutableTtl
          produce = async () => {
            await visible(name)
            const response = await api(`repos/${name}/${detail}${detail.startsWith('git/trees/') ? '?recursive=1' : ''}`, detail.startsWith('git/blobs/'))
            return { bytes: await body(response, limit), headers: publicHeaders(response) }
          }
        }
      }
    } else return reply(json(404, { error: 'not found' }))

    const cache = globalThis.caches?.default
    const key = new Request(url.origin + '/cache' + url.pathname + url.search)
    const cached = ttl > 0 ? await cache?.match(key) : undefined
    const respond = (stored, stale) => {
      const headers = new Headers(stored.headers)
      headers.delete('x-dsh-fetched-at')
      headers.set('cache-control', `public, max-age=${ttl}`)
      if (stale) headers.set('x-dsh-stale', '1')
      return reply(new Response(stored.body, { status: 200, headers }))
    }
    if (cached && Date.now() - Number(cached.headers.get('x-dsh-fetched-at')) < ttl * 1000) return respond(cached, false)
    try {
      const { bytes, headers } = await produce()
      if (!headers.has('content-type')) headers.set('content-type', type)
      headers.set('x-dsh-fetched-at', String(Date.now()))
      // The stored copy outlives its freshness so it can answer while GitHub is failing.
      headers.set('cache-control', `public, max-age=${Math.max(ttl, staleTtl)}`)
      const stored = new Response(bytes, { headers })
      if (cache && ttl > 0) context.waitUntil(cache.put(key, stored.clone()))
      return respond(stored, false)
    } catch (error) {
      if (cached && transient(error)) return respond(cached, true)
      if (error instanceof Upstream) return reply(new Response(null, { status: error.status, headers: error.headers }))
      const detail = error instanceof Error ? error.message : 'unknown failure'
      console.error('Community upstream failure', env.GITHUB_TOKEN ? detail.replaceAll(env.GITHUB_TOKEN, '[redacted]') : detail)
      return reply(json(error instanceof RangeError ? 413 : 502, { error: error instanceof RangeError ? 'response too large' : 'GitHub request failed' }))
    }
  },
}
