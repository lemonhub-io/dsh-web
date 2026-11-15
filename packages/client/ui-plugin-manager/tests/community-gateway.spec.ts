/** The server credential only reads public allowlisted repository data. */
import { expect, it, vi } from 'vitest'
import worker from '../gateway/worker.js'

it('authenticates public package reads and refuses a private repository before reading its blobs', async () => {
  const seen: { url: string; authorization: string | null; accept: string | null }[] = []
  const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (address, init) => {
    const url = String(address)
    const headers = new Headers(init?.headers)
    seen.push({ url, authorization: headers.get('authorization'), accept: headers.get('accept') })
    if (url.endsWith('/repos/owner/private')) return Response.json({ private: true, full_name: 'owner/private' })
    if (url.includes('/search/repositories')) return Response.json({ items: [
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
    const found = await worker.fetch(request('search/repositories?q=topic%3Adsh-plugin&sort=stars'), env, context)
    const search = await found.text()
    expect((JSON.parse(search) as { items: object[] }).items[0]).toMatchObject({ stargazers_count: 7, pushed_at: '2026-11-01T00:00:00Z', topics: ['dsh-plugin', 'tools'], license: 'MIT' })
    expect(new URL(seen[0]?.url ?? '').searchParams.get('sort')).toBe('stars')
    expect((await worker.fetch(request('search/repositories?q=x&sort=forks'), env, context)).status).toBe(400)
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
