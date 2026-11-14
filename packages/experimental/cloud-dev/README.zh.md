---
description: "为浏览器编程任务提供 AI 控制的云算力 后端自动准备运行环境并收集结果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cloud-dev

[English](README.md) | 中文

## 概述

云原生开发为 AI 提供浏览器中缺失的计算能力。AI 在本地编辑和检查项目 自主选择云端任务与环境 并根据返回的诊断和产物继续编程。GitHub Actions 提供算力 无状态网关支持二进制产物取回。侧栏仅负责一次性连接和活动监控 任务执行由 AI 控制。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

打开云原生开发 一次性连接 GitHub。面板链接到已预选 `repo` 与 `workflow` 权限的 GitHub 令牌页面 粘贴令牌后选择连接即可。连接会先校验令牌及其权限、准备运行仓库并安装工作流 全部成功后才保存 因此输错或权限不足的令牌不会替换可用的令牌。令牌以 `DSH_CLOUD_GITHUB_TOKEN` 保存在凭据存储中 从不放入模型请求或运行器输入。未指定仓库时 连接会在令牌所属账号创建已初始化的私有 `dsh-cloud-runner` 仓库 更换令牌时跟随新账号。使用已有仓库接受 owner/name、仓库链接或 SSH 远程地址。网关地址是插件在 cordis.yml 中的 `gatewayUrl` 配置 不向用户展示 工作流文件固定为 `dsh-cloud-run.yml`。

在对话中描述编程目标。AI 使用 `cloud_run` 执行依赖安装、构建、测试、原生程序及浏览器无法完成的计算 根据项目选择 `command`、可选的 `setup`、输入与输出 glob 和 Node/Python 版本。默认工具链为 Node 24 与 Python 3.12。服务在提交任务前自动安装或更新运行工作流 用户无需初始化工作流或输入执行命令。

普通调用会等待完成 并将日志、退出码与产物收集到 `<workspace>/.dsh-cloud/<job>/`。返回文件位于 `files/` 下 AI 使用普通工作区工具读取后继续编程。后台调用与等待预算耗尽时返回任务 id `cloud_job` 默认等待并收集 也支持显式状态查询和取消。尚在运行的任务不会报告为成功完成。

连接后 面板显示 GitHub 账号、运行仓库和由新到旧的任务历史 每个任务链接到对应的 GitHub 运行。令牌被拒绝或缺少权限、网关无法访问、运行仓库不可用时分别显示具体提示 修改会重新打开连接表单 其中的断开连接会删除已保存的令牌。有任务排队或运行时历史每 5 秒刷新 否则每 30 秒刷新 标签页在后台时暂停。面板不提供手动提交命令或取回结果的控件 在对话中要求 AI 继续或取消任务即可。已认证集成使用 `status`、`connect`、`disconnect`、`jobs`、`start`、`cancel` 和 `collect` Remote 方法。

<a id="understand-the-implementation"></a>
## 理解实现

- `src/index.ts` 提供会被记录的编程指导 以及 `cloud_status`、`cloud_run` 和 `cloud_job` 工具。状态按顺序报告第一个阻塞问题 缺少令牌、令牌被拒绝、经典令牌缺少权限、网关、运行仓库。准备操作在每个服务内串行化 连接变更会等待进行中的准备结束。活跃操作合并调用方与插件取消信号 并在卸载时等待结束。
- `src/engine.ts` 将会话工作目录快照提交到 `dsh-cloud/<job>` 分支并派发工作流。不可变来源记录将快照绑定到所属会话及工作区 AI 取回结果和取消操作必须先校验该记录 不会按其他会话的当前目录写入结果。
- `src/snapshot.ts` 始终排除 DSH 应用数据主目录 即使它位于工作区内部 同时排除依赖缓存、既有结果、`.ssh`、`.credentials`、私有 `.env` 变体及 PEM/key 文件 允许上传环境示例和模板。限制为 2000 个文件、总计 40 MiB、单文件 10 MiB。
- `src/runner-workflow.ts` 准备工具链 在任务前执行 setup 在命令失败时停止 捕获日志和输出并上传结果归档。缺少结果归档时自动取回工作流日志供 AI 诊断 失败或无法验证的任务返回失败状态。
- `src/github.ts` 使用 GitHub 原生浏览器 API 管理账号和仓库 `gateway/worker.js` 处理二进制下载。跟随归档和日志重定向时不向存储域转发个人令牌。`gatewayUrl` 配置默认为 `https://dsh-gw.openhub.today` `gateway/deploy.ts` 使用配置的 Worker 凭据部署。`DSH_GATEWAY_HOSTNAME` 与 `DSH_GATEWAY_ORIGINS` 配置域名及允许来源。
- 派发传输失败时保留任务分支并明确报告未知结果 不会静默再提交任务。已确认的工作流缺失拒绝会有限重试等待注册。取消活跃等待会请求远端取消 无法确认取消时报告任务 id。

<a id="model-experience"></a>
## 模型体验

提示要求 AI 在本地持续编辑 在本地能力不足时选择云端执行 检查退出码和产物 并在重跑前诊断失败。静态指导与工具 schema 增加提示 token 云端结果以 JSON 记录 明确包含任务状态、任务 id、已知退出码、产物路径及有界日志尾部。完整日志保留在工作区中供定向读取 不增加隐藏模型请求或付费模型重试循环。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 受 GitHub Actions 冷启动与排队时间影响 提供的是任务计算而非交互终端。日志在完成后返回 不实时流式传输。
- 产物保留三天。明确留在后台的任务会在远端继续运行 直到完成或取消。
- AI 控制要求创建会话写入来源记录。重构前未携带该记录的任务仍可在 GitHub 查看 但不能由其他会话认领。
- 结果收集到任务目录。AI 将选中的文件集成到项目 插件不覆盖无关的本地编辑。
