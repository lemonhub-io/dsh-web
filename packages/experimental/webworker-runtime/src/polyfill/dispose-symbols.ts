/**
 * Defines `Symbol.dispose` and `Symbol.asyncDispose` in a Worker realm whose engine lacks them.
 * The worker entry imports this module first: compiled classes key their dispose methods with
 * these symbols when their modules evaluate, and TypeScript's `using` helper throws without them.
 */
import { installDisposeSymbols } from '@deepseek-ai/dsh-host-dispose-shim'

installDisposeSymbols()
