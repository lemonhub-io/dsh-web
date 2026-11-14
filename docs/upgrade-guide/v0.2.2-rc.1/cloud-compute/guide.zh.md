---
kind: upgrade-guide
description: "云原生开发任务改由 AI 工具控制 并要求会话来源记录 连接只保留运行仓库选择。"
---

# AI 控制的云计算

[English](guide.md) | 中文

## 变更

云原生开发现在仅提供连接和活动监控。手动提交命令及取回结果改由 `cloud_run` 与 `cloud_job` 完成 后者默认等待并收集 需要非阻塞查询时使用 `action: status`。AI 控制会校验创建任务的会话和工作区。

面板只保留运行仓库选择。网关地址移到插件的 `gatewayUrl` 配置 工作流文件固定为 `dsh-cloud-run.yml`。`configure` 与 `setup` Remote 方法由 `connect` 和 `disconnect` 取代 前者先校验令牌并准备运行仓库 成功后才保存。`status` 报告单个 `problem` 以及账号和运行仓库 取代分开的令牌、网关、仓库与工作流字段。

## 迁移

保留已有 GitHub 凭据和运行仓库。已保存的网关地址或工作流名称会被忽略 自定义网关请在 cordis.yml 的 `cloud-dev` 条目下设置 `gatewayUrl`。集成以 `{ token?, repository }` 调用 `connect` 取代先 `configure` 后 `setup`。在对话中要求 AI 执行计算任务。运行仓库留空时自动准备账号所属私有仓库。没有会话来源记录的既有任务仍可在 GitHub 查看 在工作会话中新建任务即可自动取回结果。显式认证 Remote 集成保留原有方法。
