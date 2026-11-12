# DSH Web plugin community

English | [中文](plugin-community.zh.md)

Plugin community discovers public GitHub repositories and installs ordinary DSH Cordis bundles directly from their committed built files. The installed inventory, enablement, configuration layers and removal belong to the existing Plugin Manager. Authors use the existing `Context`, services, tools, events and effect cleanup. There is no separate browser plugin SDK or execution engine.

## Install a plugin

Open Plugin community to discover repositories tagged `dsh-web-plugin`. Search by keyword or paste `owner/repository`, a GitHub repository URL, or a `https://github.com/owner/repository/tree/ref/package-directory` link. Choose View plugins, then download an npm archive or choose Review and install. Each selection pins one commit and verifies every downloaded file against its Git blob identity. The advanced section also accepts the existing HTTPS market indexes, package URLs and local `.tgz` files. The community checks package identity, release SHA-256, DSH and Node requirements, Worker wrapper generation, supported Node capabilities and resolvable dependencies. Approval of the source is required. Install first records a disabled profile dependency; enable it through the community or the ordinary Plugins page. Refreshing the browser retains installed packages and selection in the browser's normal DSH home storage.

Cordis plugins have the same browser-host authority as shipped plugins, including workspace, Session, settings and credential access. Install only trusted publishers. The Node compatibility layer does not isolate one Cordis plugin from another. Compatibility preflight does not establish harmless behavior or prove that dynamic imports and every Node operation will succeed. Cordis reports activation failures through its normal lifecycle.

Disable and uninstall through either management view. Both use the same profile and lifecycle; package files are removed only after the manager withdraws their contributions. The Web host does not invoke pnpm or execute package installation scripts. Updating a prepared distribution uses the existing stop, uninstall and reinstall workflow; no independent upgrade database or recovery engine is added. The install manifest is published after package files reach the browser persistence barrier; a storage failure requires refreshing the inventory to determine its outcome.

## Publish on GitHub

Commit the built plugin JavaScript, package.json, Cordis patch and required resources to a public repository. Declare `dsh.bundle.patch` and add the `dsh-web-plugin` topic for discovery. A monorepo can contain several bundle packages; direct directory links restrict discovery to that subtree. The npm `files` list selects distributable files when present. Git submodules and symlink files cannot supply package content. Private repositories and GitHub authentication are not supported.

The browser reads GitHub search, commit, recursive-tree and raw-blob REST endpoints directly without a proxy or a GitHub token. Search shows up to 24 repositories and inspection reads at most 24 package manifests. Truncated or oversized trees are refused. File transfers run in batches of four and enforce the current host archive limits. Search has a 15 second deadline, repository inspection 60 seconds and complete package transfer 120 seconds. Rate-limit errors retain existing results and ask the user to retry later.

GitHub release download URLs are not used for installation because the asset hosts do not provide the browser access this flow requires. Download creates a normal npm archive from the same immutable source files used by installation. During inspection the Worker prepares built JavaScript with the existing module transform without evaluating it. TypeScript still requires an author build and external dependencies must be bundled or host-provided.

## Prepare an ordinary bundle

The [hello example](../plugin-examples/hello/README.md) is a normal Cordis plugin that contributes `community_echo` through `ctx.tools.register`. Its `package.json` declares the existing `dsh.bundle.patch`, `engines.dsh` and peer dependencies. Its patch inserts its normal package entry. Build TypeScript and bundle private npm dependencies before preparing a Web distribution; host-provided dependencies can remain peers.

```sh
node --import tsx/esm scripts/pack-web-plugin.ts --src apps/web/plugin-examples/hello --out /tmp/hello-1.0.0.tgz
```

The author tool and on-demand Worker preparation reuse `lowerModuleSource` from the Node compatibility layer and write its existing wrapper generation to `package.json.dsh.web.lowered`. It records static module requests in `dsh.web.modules` and required Node proxies in `dsh.web.requires`. Client factory bundles keep their existing `window.__ModuleLoader__` registration. The result is a gzip-compressed ustar archive with the ordinary npm `package/` root, package manifest, bundle patch, built JavaScript and resources. It is a Web build of the same Cordis plugin rather than a new plugin API. The original source remains usable for the normal Node distribution.

Native addons, uncompiled TypeScript, encrypted or linked archive entries, unsafe paths, duplicate names and incompatible wrapper generations are refused. Dependencies must be bundled or supplied at a compatible version by the host. The default limits on `plugin-manager` are `webPackageArchiveBytes: 2097152`, `webPackageExpandedBytes: 33554432` and `webPackageFiles: 1024`. Inspection resolves imports without evaluating package JavaScript. Configuration expressions retain the existing bundle loader semantics after source approval.

## Publish a catalog

Use the existing [market index format 1](../../../packages/util/plugin-market-index/README.md). A version keeps its normal npm or pinned Git `source` and can add `web: { "url": "hello-1.0.0.tgz", "sha256": "<lowercase SHA-256>" }`. The Web URL resolves against the index URL and requires HTTPS except same-origin development. Native clients keep their original install source. The [bundled index](../public/plugin-community/cordis/index.json) provides the working Web example; it is not a populated third-party directory.

Requests omit credentials and reject redirects. The community bounds indexes to 512 KiB and 100 packages and uses a 15 second download deadline. Release metadata is advisory until inspection verifies the actual package. SHA-256 establishes consistency with the chosen index, not publisher identity. No npm dependency resolver or TypeScript compiler is installed in the browser.

## Legacy page plugins

The collapsed Legacy page plugins section retains the version 1 JSON reader and browser-local inventory. Those pages keep their `sandbox="allow-scripts"` iframe without Cordis services or Session access. They are not converted into trusted Cordis bundles automatically. The [page example](../public/plugin-community/text-toolbox.dsh-plugin.json) and its [index](../public/plugin-community/index.json) remain available.
