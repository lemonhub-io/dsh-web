# DSH Web 插件社区

[English](plugin-community.md) | 中文

插件社区发现 GitHub 公开仓库并直接从已提交的构建文件安装普通 DSH Cordis 组合包。已安装清单、启停、配置层与移除都由现有插件管理器负责。作者使用既有的 `Context`、服务、工具、事件和副作用清理机制，没有独立的浏览器插件 SDK 或执行引擎。

## 安装插件

打开插件社区即可发现带有 `dsh-web-plugin` 主题的仓库。按关键词搜索或粘贴 `owner/repository`、GitHub 仓库地址或 `https://github.com/owner/repository/tree/ref/package-directory` 目录链接。选择查看插件后可下载 npm 归档或检查并安装。每次选择固定一个提交并按 Git blob 标识校验所有下载文件。高级区域仍接受现有 HTTPS 市场目录、插件包链接和本地 `.tgz` 文件。社区校验包身份、发行摘要、DSH 和 Node 版本要求、Worker 包装代数、支持的 Node 能力及可解析依赖。用户必须先确认信任来源。安装先记录为停用的 profile 依赖 再通过社区或普通插件页启用。刷新浏览器后安装包与启用选择保留在浏览器的常规 DSH 主目录存储中。

Cordis 插件拥有与内置插件相同的浏览器宿主权限，包括工作区、会话、设置和凭据访问。仅安装可信发布者的插件，Node 兼容层不会隔离各个 Cordis 插件。兼容性预检不证明行为无害，也不能保证动态导入与每个 Node 操作都能成功。激活失败由 Cordis 的常规生命周期报告。

通过任一管理界面停用和卸载，两者使用相同配置与生命周期。管理器撤销贡献后才删除包文件。Web 宿主不调用 pnpm，也不执行包安装脚本。准备后的发行版更新沿用现有的停用、卸载、重新安装流程，不增加独立的升级数据库或恢复引擎。安装清单在包文件通过浏览器持久化屏障后发布，存储失败时需要刷新清单确认实际结果。

## 在 GitHub 发布

将已构建插件 JavaScript、package.json、Cordis 补丁和必要资源提交到公开仓库。声明 `dsh.bundle.patch` 并添加 `dsh-web-plugin` 主题即可被发现。单仓库可包含多个组合包 目录直链将发现范围限定到该子目录。存在 npm `files` 列表时按其选择发行文件。Git 子模块和符号链接不能提供包内容。不支持私有仓库与 GitHub 登录。

浏览器直接读取 GitHub 搜索、提交、递归树及原始 blob REST 端点 无需代理或 GitHub 令牌。搜索最多显示 24 个仓库 检查最多读取 24 个包清单。截断或过大的树会被拒绝。文件按四个一批传输 并遵守当前宿主归档限制。搜索限时 15 秒 仓库检查 60 秒 完整包传输 120 秒。触发额度限制时保留已有结果并提示稍后重试。

安装不使用 GitHub release 下载链接 因为资源宿主未提供此流程需要的浏览器跨域访问。下载会从与安装相同的不可变源文件生成普通 npm 归档。检查时 Worker 使用现有模块转换器处理已构建 JavaScript 而不执行代码。TypeScript 仍需作者构建 外部依赖必须捆绑或由宿主提供。

## 准备普通组合包

[hello 示例](../plugin-examples/hello/README.md)是普通 Cordis 插件，通过 `ctx.tools.register` 提供 `community_echo`。其 `package.json` 声明既有的 `dsh.bundle.patch`、`engines.dsh` 与 peer 依赖，补丁插入普通包入口。准备 Web 发行文件前先编译 TypeScript 并捆绑私有 npm 依赖，宿主提供的依赖可保留为 peer。

```sh
node --import tsx/esm scripts/pack-web-plugin.ts --src apps/web/plugin-examples/hello --out /tmp/hello-1.0.0.tgz
```

作者工具与 Worker 按需准备复用 Node 兼容层的 `lowerModuleSource`，将既有包装器代际写入 `package.json.dsh.web.lowered`，在 `dsh.web.modules` 记录静态模块请求，并在 `dsh.web.requires` 记录必需的 Node 代理。Client 工厂包保持既有 `window.__ModuleLoader__` 注册。产物是 gzip 压缩的 ustar 归档，包含普通 npm `package/` 根目录、清单、组合包补丁、编译后的 JavaScript 与资源。它是同一 Cordis 插件的 Web 构建，不引入新插件 API，原始源代码仍供正常 Node 发行使用。

原生扩展、未编译 TypeScript、加密或链接归档条目、不安全路径、重复名称和不兼容包装器代际会被拒绝。依赖必须已经捆绑，或由宿主提供兼容版本。`plugin-manager` 默认限制为 `webPackageArchiveBytes: 2097152`、`webPackageExpandedBytes: 33554432` 和 `webPackageFiles: 1024`。检查只解析导入，不执行包 JavaScript。来源批准后，配置表达式保持既有组合包加载语义。

## 发布目录

使用既有[市场索引格式 1](../../../packages/util/plugin-market-index/README.zh.md)。每个版本保留普通 npm 或固定 Git 提交的 `source`，并可增加 `web: { "url": "hello-1.0.0.tgz", "sha256": "<lowercase SHA-256>" }`。Web 地址相对索引地址解析，除同源开发外必须使用 HTTPS。原生客户端保留原安装来源。[内置索引](../public/plugin-community/cordis/index.json)提供可用 Web 示例，并非已填充的第三方目录。

请求不带凭据且拒绝重定向。社区将索引限制为 512 KiB 与 100 个包，下载期限为 15 秒。检查实际包前，发行版元数据仅供参考。SHA-256 建立与所选索引的一致性，不代表发布者身份。浏览器内不安装 npm 依赖解析器或编译器。

## 旧版页面插件

折叠的旧版页面插件区域保留版本 1 JSON 读取器与浏览器本地清单。页面仍使用 `sandbox="allow-scripts"` iframe，不获得 Cordis 服务或会话访问，也不会自动转换为可信 Cordis 组合包。[页面示例](../public/plugin-community/text-toolbox.dsh-plugin.json)及其[索引](../public/plugin-community/index.json)继续可用。
