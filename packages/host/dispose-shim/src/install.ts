/**
 * Explicit resource management symbols for JavaScript realms whose engine lacks them.
 * @module @deepseek-ai/dsh-host-dispose-shim/install
 */

/**
 * Define `Symbol.dispose` and `Symbol.asyncDispose` in the calling realm when its engine has
 * no own property of that name. Each missing symbol becomes the registry symbol
 * `Symbol.for('Symbol.dispose')` or `Symbol.for('Symbol.asyncDispose')`, the same fallback
 * key that Babel, oxc and esbuild lowering helpers use. The property is read-only,
 * non-enumerable and non-configurable, like the native one. A symbol that the engine or an
 * earlier call defined stays unchanged, so repeated calls are harmless. The function reads no module
 * binding, so {@link DISPOSE_SYMBOLS_SCRIPT} can run its source text in another realm.
 */
export function installDisposeSymbols(): void {
  for (const name of ['dispose', 'asyncDispose']) {
    if (!Object.hasOwn(Symbol, name)) Object.defineProperty(Symbol, name, { value: Symbol.for(`Symbol.${name}`) })
  }
}

/** Classic-script source text that runs {@link installDisposeSymbols} in the realm that evaluates it. */
export const DISPOSE_SYMBOLS_SCRIPT = `(${installDisposeSymbols.toString()})()`
