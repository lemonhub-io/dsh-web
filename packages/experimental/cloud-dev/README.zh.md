---
description: "经由无状态 Cloudflare Worker 网关把工作区命令交给 GitHub Actions 运行并取回结果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cloud-dev

[English](README.md) | 中文

## 概述

云原生开发把编译和运行交给 GitHub Actions：DSH Web 作为无状态交互层，Cloudflare Worker 作为无状态网关转发请求，运行仓库提供弹性算力。侧栏的**云原生开发**面板与 `cloud_run`、`cloud_job` 两个智能体工具共用同一个 Host 服务。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

1. 部署网关：`CF_WORKERS_TOKEN=... pnpm --filter @deepseek-ai/dsh-experimental-cloud-dev run deploy:gateway`。令牌需要 Workers Scripts 编辑权限。设置 `DSH_GATEWAY_HOSTNAME` 可绑定自定义域名，`DSH_GATEWAY_ORIGINS` 列出允许调用它的 Web 来源。在 `gateway/` 下运行 `wrangler dev` 可在本地跑同一个 Worker。
2. 新建一个私有运行仓库，默认分支上至少要有一次提交。
3. 在面板中填写网关地址、`owner/name` 形式的仓库，以及带 `repo` 和 `workflow` 权限的 GitHub 令牌。令牌保存为 `DSH_CLOUD_GITHUB_TOKEN` 凭据，不写进设置文件。
4. 选择**初始化运行仓库**，安装 `.github/workflows/dsh-cloud-run.yml`。
5. 输入命令并选择**提交到云端**。任务结束后，**取回结果**会把日志、退出码和取回的文件写入 `<目录>/.dsh-cloud/<任务>/`。

智能体调用 `cloud_run` 时传入命令，可选 `include`、`outputs` 和 `workdir`。默认会等待并返回结果；传 `wait: false` 时返回任务 id，之后用 `cloud_job` 查询。

<a id="understand-the-implementation"></a>
## 了解实现

- `src/engine.ts` 把快照提交到 `dsh-cloud/<任务>` 分支，在该分支上触发工作流，再按分支找到对应的运行。所有任务状态都在 GitHub 上，Host 和 Worker 都不保存状态。
- `gateway/worker.js` 只转发引擎用到的 GitHub REST 路径，透传调用方的令牌，跟随产物下载跳转前会去掉令牌。
- `src/runner-workflow.ts` 定义工作流：运行命令，记录输出、退出码和耗时，收集 `outputs` 匹配的文件，打包上传为一个 `dsh-cloud-result` 产物。
- `src/zip.ts` 用平台自带的 `DecompressionStream` 解压该产物，并拒绝不安全的路径。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 快照会跳过 `.git`、`node_modules`、虚拟环境和构建缓存。上限是 2000 个文件，总计 40 MiB，单个文件 10 MiB。
- 日志在任务结束后一次性返回，不支持流式输出。
- 产物保留 3 天。
