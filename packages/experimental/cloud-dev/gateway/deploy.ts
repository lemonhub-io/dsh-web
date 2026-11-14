/**
 * Publish the stateless gateway Worker through the Cloudflare REST API.
 *
 * Reads `CF_WORKERS_TOKEN` (Workers Scripts edit, plus Workers Routes edit for a custom domain) and the
 * optional `CF_ACCOUNT_ID`, `DSH_GATEWAY_HOSTNAME` and `DSH_GATEWAY_ORIGINS` from the environment.
 * Without a hostname the Worker is served from its workers.dev subdomain.
 */
import { readFile } from 'node:fs/promises'

const API = 'https://api.cloudflare.com/client/v4'
const token = process.env.CF_WORKERS_TOKEN
if (token === undefined || token === '') throw new Error('CF_WORKERS_TOKEN is not set')
const name = 'dsh-cloud-gateway'
const hostname = process.env.DSH_GATEWAY_HOSTNAME
const origins = process.env.DSH_GATEWAY_ORIGINS ?? 'https://dsh.daum.pw'

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(API + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })
  const body = await response.json() as { success: boolean; result: T; errors: { message: string }[] }
  if (!body.success) throw new Error(`${path}: ${body.errors.map(error => error.message).join('; ')}`)
  return body.result
}

async function accountId(): Promise<string> {
  if (process.env.CF_ACCOUNT_ID) return process.env.CF_ACCOUNT_ID
  const accounts = await call<{ id: string }[]>('/accounts')
  if (accounts[0] === undefined) throw new Error('The token cannot see any account; set CF_ACCOUNT_ID')
  return accounts[0].id
}

const account = await accountId()
const form = new FormData()
form.set('metadata', new Blob([JSON.stringify({
  main_module: 'worker.js',
  compatibility_date: '2026-10-01',
  bindings: [{ type: 'plain_text', name: 'ALLOWED_ORIGINS', text: origins }],
})], { type: 'application/json' }))
form.set('worker.js', new Blob([await readFile(new URL('worker.js', import.meta.url))], { type: 'application/javascript+module' }), 'worker.js')
await call(`/accounts/${account}/workers/scripts/${name}`, { method: 'PUT', body: form })
console.log(`uploaded ${name}`)

if (hostname !== undefined && hostname !== '') {
  const zoneName = hostname.split('.').slice(-2).join('.')
  const zones = await call<{ id: string }[]>(`/zones?name=${zoneName}`)
  if (zones[0] === undefined) throw new Error(`zone ${zoneName} is not visible to the token`)
  await call(`/accounts/${account}/workers/domains`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname, service: name, zone_id: zones[0].id, environment: 'production' }),
  })
  console.log(`https://${hostname}`)
} else {
  await call(`/accounts/${account}/workers/scripts/${name}/subdomain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  const subdomain = await call<{ subdomain: string }>(`/accounts/${account}/workers/subdomain`)
  console.log(`https://${name}.${subdomain.subdomain}.workers.dev`)
}
