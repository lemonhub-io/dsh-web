---
kind: upgrade-guide
description: "云原生开发任务改由 AI 工具控制 并要求会话来源记录 连接管理运行仓库和可见性选择。"
---

# AI 控制的云计算

[English](guide.md) | 中文

## 变更

云原生开发现在仅提供连接和活动监控。手动提交命令及取回结果改由 `cloud_run` 与 `cloud_job` 完成 后者默认等待并收集 需要非阻塞查询时使用 `action: status`。AI 控制会校验创建任务的会话和工作区。

面板保存运行仓库和所选可见性。网关地址移到插件的 `gatewayUrl` 配置 工作流文件固定为 `dsh-cloud-run.yml`。`configure` 与 `setup` Remote 方法由 `connect` 和 `disconnect` 取代 前者先校验令牌并准备运行仓库 成功后才保存。`status` 报告单个 `problem` 以及账号和运行仓库 取代分开的令牌、网关、仓库与工作流字段。

## 迁移

连接支持可选的 `visibility` 值 `private` 或 `public` 显式传入时会应用到所选已有仓库及新仓库。省略时使用已有 GitHub 可见性 新建仓库则选择私有。设置表单发送所选可见性 并在确认更新后保存连接设置。更新可见性需要仓库管理权限及组织策略允许。未确认的更新可再次保存 保存前会先读取当前值。状态响应包含实际 `visibility` 仓库尚不可读时为 null。

`cloud-dev` 条目新增的 `workspace` 配置默认为 `local` 保留宿主 shell；DSH Web 镜像设为 `browser` 此时智能体在本地完成文件操作 所有安装、编译、检查及计算均通过云端工具执行。将依赖与工具链准备放入 `cloud_run.setup` 导出的变量和 PATH 变更会在单次全新任务内保留至任务执行。`cloud_status` 返回 `problem` 代码 并将暂时性服务故障报告为 `failed`。

保留已有 GitHub 凭据和运行仓库。已保存的网关地址或工作流名称会被忽略 自定义网关请在 cordis.yml 的 `cloud-dev` 条目下设置 `gatewayUrl`。集成以 `{ token?, repository }` 调用 `connect` 取代先 `configure` 后 `setup`。在对话中要求 AI 执行计算任务。运行仓库留空时按所选创建可见性准备账号所属仓库。没有会话来源记录的既有任务仍可在 GitHub 查看 在工作会话中新建任务即可自动取回结果。显式认证 Remote 集成保留原有方法。
