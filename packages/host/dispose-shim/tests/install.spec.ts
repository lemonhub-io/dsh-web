/** The shim defines missing dispose symbols in a realm and leaves engine symbols alone. */
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { DISPOSE_SYMBOLS_SCRIPT, installDisposeSymbols } from '../src/index.ts'

/** Replaces a realm's `Symbol` with a constructor that has no dispose symbols, as current WebKit ships. */
const REMOVE_ENGINE_SYMBOLS = `{
  const Engine = Symbol
  const Shimless = function Symbol(description) { return Engine(description) }
  Shimless.for = Engine.for
  globalThis.Symbol = Shimless
}`

interface RealmReport {
  first: symbol[]
  again: symbol[]
  descriptor: PropertyDescriptor | undefined
}

describe('the dispose symbol shim', () => {
  it('defines registry symbols with the native attributes in a realm that lacks them', () => {
    const report = runInNewContext(`${REMOVE_ENGINE_SYMBOLS}
${DISPOSE_SYMBOLS_SCRIPT};
const first = [Symbol.dispose, Symbol.asyncDispose];
${DISPOSE_SYMBOLS_SCRIPT};
({ first, again: [Symbol.dispose, Symbol.asyncDispose], descriptor: Object.getOwnPropertyDescriptor(Symbol, 'asyncDispose') })`) as RealmReport
    expect(report.first).toEqual([Symbol.for('Symbol.dispose'), Symbol.for('Symbol.asyncDispose')])
    expect(report.again).toEqual(report.first)
    expect(report.descriptor).toEqual({ value: Symbol.for('Symbol.asyncDispose'), writable: false, enumerable: false, configurable: false })
  })

  it('keeps the engine symbols where they exist', () => {
    const engine = [Symbol.dispose, Symbol.asyncDispose]
    installDisposeSymbols()
    expect([Symbol.dispose, Symbol.asyncDispose]).toEqual(engine)
    expect(Symbol.dispose).not.toBe(Symbol.for('Symbol.dispose'))
  })
})
