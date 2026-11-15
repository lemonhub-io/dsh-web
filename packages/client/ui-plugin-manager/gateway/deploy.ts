/** Deploy the community Worker and custom domain using credentials supplied outside the repository. */
import { readFile } from 'node:fs/promises'

const API = 'https://api.cloudflare.com/client/v4'
const token = process.env.CF_WORKERS_TOKEN
const account = process.env.CF_ACCOUNT_ID
const zone = process.env.CF_ZONE_ID
if (!token || !account || !zone) throw new Error('Set CF_WORKERS_TOKEN CF_ACCOUNT_ID and CF_ZONE_ID')
const name = 'dsh-plugin-community'
const hostname = process.env.DSH_COMMUNITY_HOSTNAME ?? 'dsh-community.openhub.today'

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(API + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(30000),
  })
  const body = await response.json() as { success: boolean; result: T; errors: { message: string }[] }
  if (!body.success) throw new Error(`${path} ${body.errors.map(error => error.message).join(' ')}`)
  return body.result
}

const domains = await call<{ hostname: string; service: string }[]>(`/accounts/${account}/workers/domains`)
if (domains.some(domain => domain.hostname === hostname && domain.service !== name))
  throw new Error('The hostname belongs to a different Worker')

const bindings: object[] = [
  { type: 'plain_text', name: 'ALLOWED_ORIGINS', text: process.env.DSH_COMMUNITY_ORIGINS ?? 'https://dsh.openhub.today' },
  { type: 'plain_text', name: 'CACHE_SECONDS', text: '60' },
  { type: 'plain_text', name: 'IMMUTABLE_CACHE_SECONDS', text: '3600' },
  { type: 'plain_text', name: 'MAX_RESPONSE_BYTES', text: '33554432' },
]
if (process.env.GITHUB_TOKEN) bindings.push({ type: 'secret_text', name: 'GITHUB_TOKEN', text: process.env.GITHUB_TOKEN })
const form = new FormData()
form.set('metadata', new Blob([JSON.stringify({
  main_module: 'worker.js',
  compatibility_date: '2026-11-15',
  bindings,
  keep_bindings: ['secret_text'],
})], { type: 'application/json' }))
form.set('worker.js', new Blob([await readFile(new URL('worker.js', import.meta.url))], {
  type: 'application/javascript+module',
}), 'worker.js')
await call(`/accounts/${account}/workers/scripts/${name}`, { method: 'PUT', body: form })
await call(`/accounts/${account}/workers/domains`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ hostname, service: name, zone_id: zone, environment: 'production' }),
})
console.log(`Deployed ${name} at https://${hostname}`)
