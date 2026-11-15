/** The server credential only reads public allowlisted repository data. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import worker from '../gateway/worker.js'

it('authenticates public package reads and refuses a private repository before reading its blobs', async () => {
  const seen: { url: string; authorization: string | null; accept: string | null }[] = []
  const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (address, init) => {
    const url = String(address)
    const headers = new Headers(init?.headers)
    seen.push({ url, authorization: headers.get('authorization'), accept: headers.get('accept') })
    if (url.endsWith('/repos/owner/private')) return Response.json({ private: true, full_name: 'owner/private' })
    if (url.includes('/search/repositories')) return Response.json({ total_count: 30916, items: [
      {
        private: false, full_name: 'owner/public', default_branch: 'main', permissions: { admin: true },
        stargazers_count: 7, pushed_at: '2026-11-01T00:00:00Z', topics: ['dsh-plugin', 'tools'], license: { spdx_id: 'MIT', name: 'MIT License' },
      },
      { private: true, full_name: 'owner/private' },
    ] })
    if (url.includes('/git/blobs/')) return new Response('public source')
    return Response.json({ private: false, full_name: 'owner/public', default_branch: 'main' })
  })
  const env = { GITHUB_TOKEN: 'fixture-server-secret', ALLOWED_ORIGINS: 'https://dsh.openhub.today' }
  const context = { waitUntil: (_operation: Promise<unknown>): void => {} }
  const request = (path: string) => new Request('https://dsh-community.openhub.today/github/' + path, {
    headers: { origin: 'https://dsh.openhub.today' },
  })
  try {
    const found = await worker.fetch(request('search/repositories?q=topic%3Adsh-plugin&sort=stars&per_page=50&page=3'), env, context)
    const search = await found.text()
    const parsed = JSON.parse(search) as { total_count: number; items: object[] }
    expect(parsed.total_count).toBe(30916)
    expect(parsed.items[0]).toMatchObject({ stargazers_count: 7, pushed_at: '2026-11-01T00:00:00Z', topics: ['dsh-plugin', 'tools'], license: 'MIT' })
    const forwarded = new URL(seen[0]?.url ?? '').searchParams
    expect([forwarded.get('sort'), forwarded.get('per_page'), forwarded.get('page')]).toEqual(['stars', '50', '3'])
    expect((await worker.fetch(request('search/repositories?q=x&sort=forks'), env, context)).status).toBe(400)
    expect((await worker.fetch(request('search/repositories?q=x&per_page=50&page=21'), env, context)).status).toBe(400)
    expect(search).not.toContain('owner/private')
    expect(search).not.toContain('permissions')
    expect(search).not.toContain(env.GITHUB_TOKEN)
    expect(new URL(seen[0]?.url ?? '').searchParams.get('q')).toContain('is:public')
    const hash = 'a'.repeat(40)
    const publicBlob = await worker.fetch(request(`repos/owner/public/git/blobs/${hash}`), env, context)
    expect(await publicBlob.text()).toBe('public source')
    expect(seen.at(-1)?.accept).toBe('application/vnd.github.raw+json')
    const before = seen.length
    const privateBlob = await worker.fetch(request(`repos/owner/private/git/blobs/${hash}`), env, context)
    expect(privateBlob.status).toBe(404)
    expect(seen.slice(before).map(item => item.url)).toEqual(['https://api.github.com/repos/owner/private'])
    expect(seen.every(item => item.authorization === 'Bearer ' + env.GITHUB_TOKEN)).toBe(true)
    const arbitrary = await worker.fetch(request('user'), env, context)
    expect(arbitrary.status).toBe(403)
    expect(seen.length).toBe(before + 1)
  } finally {
    upstream.mockRestore()
  }
})

it('serves a repository snapshot and verified blob batches, proxies GitHub file hosts and falls back to its last good copy', async () => {
  const sha1 = (text: string): string => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
  const manifest = '{"name":"plugin","dsh":{"bundle":{}}}'
  const code = 'export const apply = () => {}'
  const commit = '1'.repeat(40), tree = '2'.repeat(40)
  let outage = false, flaky = 1
  const seen: { url: string; authorization: string | null }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (address, init) => {
    const url = address instanceof Request ? address.url : address instanceof URL ? address.href : address
    seen.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    if (outage) return new Response(null, { status: 503 })
    if (url.endsWith('/repos/owner/public')) return Response.json({ private: false, full_name: 'owner/public', default_branch: 'main' })
    if (url.endsWith('/commits/main')) return Response.json({ sha: commit, commit: { tree: { sha: tree } } })
    if (url.includes(`/git/trees/${tree}`)) return Response.json({ truncated: false, tree: [
      { type: 'blob', path: 'plugin/package.json', sha: sha1(manifest), size: manifest.length, mode: '100644' },
      { type: 'blob', path: 'plugin/index.js', sha: sha1(code), size: code.length, mode: '100644' },
      { type: 'blob', path: 'other/readme.md', sha: '3'.repeat(40), size: 1, mode: '100644' },
    ] })
    if (url.endsWith('/git/blobs/' + sha1(manifest))) return new Response(manifest)
    if (url.endsWith('/git/blobs/' + sha1(code))) {
      flaky -= 1
      return flaky >= 0 ? new Response(null, { status: 502 }) : new Response(code)
    }
    if (url === 'https://github.com/owner/public/releases/download/v1/plugin.tgz')
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } })
    if (url === 'https://release-assets.githubusercontent.com/asset') return new Response('archive')
    return new Response(null, { status: 404 })
  })
  const store = new Map<string, Response>()
  vi.stubGlobal('caches', { default: {
    match: async (key: Request) => store.get(key.url)?.clone(),
    put: async (key: Request, value: Response) => { store.set(key.url, value) },
  } })
  const pending: Promise<unknown>[] = []
  const env = { GITHUB_TOKEN: 'fixture-server-secret', CACHE_SECONDS: '1' }
  const context = { waitUntil: (operation: Promise<unknown>): void => { pending.push(operation) } }
  const get = (path: string) => worker.fetch(new Request('https://dsh-community.openhub.today/' + path), env, context)
  try {
    const snapshot = await (await get('github/repos/owner/public/packages?ref=main&directory=plugin')).json() as {
      commit: string
      files: { path: string }[]
      manifests: { path: string; data: string }[]
    }
    expect(snapshot.commit).toBe(commit)
    expect(snapshot.files.map(file => file.path)).toEqual(['plugin/package.json', 'plugin/index.js'])
    expect(snapshot.manifests).toEqual([{ path: 'plugin/package.json', data: Buffer.from(manifest).toString('base64') }])
    const batch = await get(`github/repos/owner/public/blobs?sha=${sha1(manifest)},${sha1(code)}`)
    expect(await batch.text()).toBe(manifest + code)
    expect((await get('github/repos/owner/public/blobs?sha=' + 'a'.repeat(40) + ',' + 'a'.repeat(40))).status).toBe(400)
    const file = await get('fetch?url=' + encodeURIComponent('https://github.com/owner/public/releases/download/v1/plugin.tgz'))
    expect(await file.text()).toBe('archive')
    expect(seen.filter(item => !item.url.startsWith('https://api.github.com/')).every(item => item.authorization === null)).toBe(true)
    expect((await get('fetch?url=' + encodeURIComponent('https://example.com/plugin.tgz'))).status).toBe(403)
    await Promise.all(pending)
    outage = true
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10000)
    const stale = await get('github/repos/owner/public/packages?ref=main&directory=plugin')
    expect(stale.headers.get('x-dsh-stale')).toBe('1')
    expect((await stale.json() as { commit: string }).commit).toBe(commit)
    expect((await get('github/repos/owner/public/packages?ref=other')).status).toBe(503)
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
