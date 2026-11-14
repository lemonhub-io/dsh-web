/**
 * Built-in shim for browsers without explicit resource management symbols, such as Safari:
 * every Web page defines `Symbol.dispose` and `Symbol.asyncDispose` before its first script.
 * @module @deepseek-ai/dsh-host-dispose-shim
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DISPOSE_SYMBOLS_SCRIPT } from './install.ts'

export { DISPOSE_SYMBOLS_SCRIPT, installDisposeSymbols } from './install.ts'

/** Stable Cordis plugin name. */
export const name = 'dispose-shim'

/**
 * Put {@link DISPOSE_SYMBOLS_SCRIPT} in every index render as a head script row. The listener
 * is prepended, so the row precedes the rows of later-registered listeners, including the
 * client module table and bundle scripts. A served page runs it before any document script,
 * and a Worker-hosted page runs it before the shell entry.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: DISPOSE_SYMBOLS_SCRIPT })
  }, { prepend: true })
}
