/** Direct typed RPC requests to a real browser-hosted Worker for acceptance scenarios. */
import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright'

/** Invoke one Remote without replacing the browser transport.
 * @param page Page containing the running Worker host.
 * @param method Registered Remote method.
 * @param args Method arguments keyed by parameter name.
 * @returns The actual decoded service result Remote failures reject.
 */
export async function workerRemote<T>(page: Page, method: string, args: object): Promise<T> {
  return page.evaluate(
    async ({ method, args, rpcId }) => {
      const root = globalThis as typeof globalThis & {
        __DSH_TRANSPORT__?: { fetch(input: string, init: RequestInit): Promise<Response> }
      }
      if (root.__DSH_TRANSPORT__ === undefined) throw new Error('Worker transport unavailable')
      const response = await root.__DSH_TRANSPORT__.fetch('/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      })
      const body = (await response.json()) as {
        result: { ok: true; value: T } | { ok: false; error: { message: string } }
      }
      if (!body.result.ok) throw new Error(method + ' ' + body.result.error.message)
      return body.result.value
    },
    { method, args, rpcId: randomUUID() },
  )
}
