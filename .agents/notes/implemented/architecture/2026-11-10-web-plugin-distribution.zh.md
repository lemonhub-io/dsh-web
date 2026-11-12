# Agent Note: Cordis Web 插件分发

Status: implemented

[English](2026-11-10-web-plugin-distribution.md) | 中文

## Problem

浏览器已通过 Node 兼容层运行 Cordis 树，但无法使用包管理器子进程，模块加载器也只接受预转换代码。社区安装需要保留现有插件 API 和生命周期归属的分发路径。

## Decision

Web 发行文件是普通 npm Cordis 组合包的预构建产物。作者工具与 Worker 按需准备复用现有模块转换器，在 `dsh.web` 记录其代际与静态需求。市场索引保留格式 1 和原生来源，每个版本可附加 Web 文件地址与摘要。[社区指南](../../../../apps/web/platform/plugin-community.zh.md)负责作者及用户说明。

现有插件管理器负责检查、配置依赖、启用、移除和变更通知。Worker 提供的适配器负责受限归档解码、静态解析、模块缓存失效与持久化。包文件位于浏览器存储支撑的正常配置 node_modules 树中。安装记录停用的依赖，启用使用现有组合包配置和 Cordis 副作用机制。移除先等待贡献停止，再删除文件及缓存模块。

## Alternatives considered

**独立 QuickJS SDK 与安装数据库：** 需要既有 Cordis 插件采用另一套 API，还会重复生命周期、清单与持久化归属，因此被拒绝。[独立 SDK 提案](../../rejected/architecture/2026-11-08-dsh-web-plugin-system.zh.md)记录该备选方案。

**在兼容层中运行 pnpm：** 当前宿主既没有完整包管理器进程环境，也没有 TypeScript 编译器。准备后的发行文件复用现有 JavaScript 转换器，不把浏览器扩展为完整 Node 安装服务。

## Consequences

Cordis 插件获得宿主权限，需要明确信任来源。本分发路径提供兼容性检查，不提供逐插件安全隔离。原生扩展和不支持的 Node 能力会被拒绝，动态请求仍可能在常规激活期间失败。代码、依赖和启用选择通过现有平台存储保留到刷新后。升级沿用现有停用、移除和重新安装流程，不引入另一套迁移或恢复系统。
