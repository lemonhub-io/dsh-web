/** The shipped Web composition renders the dispose symbol shim ahead of every page script. */
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as DisposeShim from '@deepseek-ai/dsh-host-dispose-shim'
import { renderIndexInjections, type IndexInjection, type WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'

/** The Peer an index render speaks for; these listeners read no field of it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

it('renders the shim as the first head script, before rows of listeners registered earlier', async () => {
  const rows = loadOverlayPatches('dispose-shim', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'dispose-shim')
  expect(rows.map(row => [row.name, row.disabled])).toEqual([['@deepseek-ai/dsh-host-dispose-shim', undefined]])
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  // Stands in for the client module table, whose listener can activate first.
  ctx.on('webserver/index-inject', (table) => { table.push({ kind: 'script-src', placement: 'head', src: 'plugins/shell.js' }) })
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins['dispose-shim'] = DisposeShim
  await ctx.loader.root.update([{ ...rows[0]!, name: 'cordis:dispose-shim' }])
  await ctx.loader.await()
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table, PAGE_PEER)
  expect(table[0]).toEqual({ kind: 'script', placement: 'head', text: DisposeShim.DISPOSE_SYMBOLS_SCRIPT })
  const html = renderIndexInjections('<html><head><script type="module" src="./index.js"></script></head><body></body></html>', table)
  expect(/<head><script>([^<]*)<\/script>/.exec(html)?.[1]).toBe(DisposeShim.DISPOSE_SYMBOLS_SCRIPT)
})
