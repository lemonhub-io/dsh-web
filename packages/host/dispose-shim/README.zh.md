---
description: "面向 Safari 等缺少显式资源管理符号的引擎的内置兼容层：在每个 Web 页面和 Web Worker 宿主执行任何脚本前定义 Symbol.dispose 与 Symbol.asyncDispose。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-dispose-shim

[English](README.md) | 中文

## 概述

让 Web 界面在缺少 `Symbol.dispose` 和 `Symbol.asyncDispose` 的浏览器中运行，包括所有 Apple 设备上的 Safari。编译后的 DSH 代码在模块求值时就用这两个符号作为释放方法的键，TypeScript 的 `using` 辅助函数在缺少它们时会抛错。该插件在 Web 组合包中默认启用，在每个页面的第一个页面脚本之前定义这两个符号。已经具备它们的引擎保留自己的符号。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

[`dsh-web-app`](../../bundle/web-app/README.zh.md) 组合包以 `dispose-shim` 行挂载该插件，因此 `dsh web` 与 DSH Web 无需任何配置。它没有配置字段。不使用该组合包、但通过 [`dsh-host-webserver`](../webserver/README.zh.md) 提供 Web 壳的组合需要自行添加这一行：

```yaml
- id: dispose-shim
  name: '@deepseek-ai/dsh-host-dispose-shim'
```

只有当引擎没有自有的 `Symbol.dispose` 或 `Symbol.asyncDispose` 属性时，兼容层才添加对应符号。添加的是注册表符号 `Symbol.for('Symbol.dispose')` 或 `Symbol.for('Symbol.asyncDispose')`，也就是 Babel、oxc 和 esbuild 降级辅助函数已经使用的回退键，因此经这些工具降级的第三方代码与 DSH 代码一致。该属性只读、不可枚举且不可配置，与原生属性相同。禁用这一行后，此类浏览器中的页面没有这两个符号，第一个 `using` 声明会抛出 `Symbol.dispose is not defined`。

在任何页面脚本之前运行于另一个 JavaScript realm 的代码，应先调用本包的 `installDisposeSymbols()`。DSH Web 的 worker 运行时在第一个导入中这样做，因此 Worker 宿主及其 shell 进程在两个符号都已定义的情况下求值宿主模块树。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

| 文件 | 职责 |
|---|---|
| [`src/install.ts`](src/install.ts) | `installDisposeSymbols()` 与 `DISPOSE_SYMBOLS_SCRIPT`，后者是在求值它的 realm 中运行同一函数的经典脚本文本 |
| [`src/index.ts`](src/index.ts) | 插件本身：一个前置的 `webserver/index-inject` 监听器，把该脚本作为 head 行加入 |

该函数不读取任何模块绑定，因此它的源码文本就是脚本，逻辑没有第二份副本。head 行紧接在 `<head>` 之后插入，在服务端渲染的页面中先于所有文档脚本。由 Worker 托管的页面在 shell 入口之前按表顺序执行这些行。前置监听器让这一行排在之后注册的监听器的行之前，包括客户端模块表和 bundle 脚本。

</details>

<a id="model-experience"></a>
## 模型体验

无。该包只向 Web 页面添加一段浏览器脚本，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只提供这两个符号**——不定义 `DisposableStack`、`AsyncDisposableStack` 和 `SuppressedError`。DSH 代码不使用这两个栈类，TypeScript 的降级辅助函数在引擎缺少 `SuppressedError` 时会自行构造。
- **注入表之前运行的页面代码不在覆盖范围内**——在 DSH Web 中，平台自己的启动页在 Worker 送达注入表之前运行。该页面在此之前没有对释放符号求值的代码。

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
