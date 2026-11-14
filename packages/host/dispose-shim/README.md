---
description: "Built-in shim for Safari and other engines without explicit resource management symbols: defines Symbol.dispose and Symbol.asyncDispose in every Web page and the Web Worker host before any script evaluates."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-dispose-shim

English | [中文](README.zh.md)

## Summary

Run the Web UI in browsers that lack `Symbol.dispose` and `Symbol.asyncDispose`, which includes Safari on every Apple device. Compiled DSH code keys dispose methods with these symbols when its modules evaluate, and TypeScript's `using` helper throws without them. This plugin is on by default in the Web bundle and defines both symbols in every page before the first page script. Engines that already have them keep their own symbols.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The [`dsh-web-app`](../../bundle/web-app/README.md) bundle mounts this plugin as the `dispose-shim` row, so `dsh web` and DSH Web need no configuration. It has no config fields. A composition that serves the Web shell through [`dsh-host-webserver`](../webserver/README.md) without that bundle adds the row itself:

```yaml
- id: dispose-shim
  name: '@deepseek-ai/dsh-host-dispose-shim'
```

The shim adds each symbol only when the engine has no own `Symbol.dispose` or `Symbol.asyncDispose` property. The added symbol is the registry symbol `Symbol.for('Symbol.dispose')` or `Symbol.for('Symbol.asyncDispose')`, the fallback key that Babel, oxc and esbuild lowering helpers already use, so third-party code lowered by those tools agrees with DSH code. The property is read-only, non-enumerable and non-configurable, like the native one. Disabling the row leaves pages in such browsers without the symbols, and the first `using` declaration there throws `Symbol.dispose is not defined`.

Code that runs in another JavaScript realm before any page script calls `installDisposeSymbols()` from this package first. The DSH Web worker runtime does this in its first import, so the Worker host and its shell processes evaluate the host tree with both symbols defined.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| [`src/install.ts`](src/install.ts) | `installDisposeSymbols()` and `DISPOSE_SYMBOLS_SCRIPT`, the classic-script text that runs the same function in the realm that evaluates it |
| [`src/index.ts`](src/index.ts) | The plugin: a prepended `webserver/index-inject` listener that adds the script as a head row |

The function reads no module binding, so its source text is the script; there is no second copy of the logic. Head rows are spliced right after `<head>`, ahead of every document script in a served page. A Worker-hosted page runs the rows in table order before the shell entry. The prepended listener keeps the row ahead of rows from listeners registered later, including the client module table and bundle scripts.

</details>

<a id="model-experience"></a>
## Model Experience

None, as this package only adds a browser script to the Web page and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only the two symbols are provided** — `DisposableStack`, `AsyncDisposableStack` and `SuppressedError` are not defined. DSH code does not use the stack classes, and TypeScript's lowering helper builds its own `SuppressedError` when the engine has none.
- **Page code that runs before the injection table is not covered** — on DSH Web, the platform's own boot page runs before the Worker delivers the table. That page has no code that evaluates the dispose symbols before then.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
