---
kind: upgrade-guide
description: "插件社区的 GitHub 读取迁移到使用服务端认证的独立 Worker 后端。"
---

# 插件社区后端

[English](guide.md) | 中文

## 变更

插件社区将 GitHub 发现与源码请求发送到 `https://dsh-community.openhub.today` Worker 保存 GitHub 凭据并提供公开仓库数据。浏览器继续校验下载包与固定的 Git blob。

## 迁移

重新加载 DSH Web 以使用更新后的社区客户端。其他部署可在 `ui-plugin-manager` 条目通过 `communityBackendUrl` 选择其他 HTTPS Worker 并将部署来源加入该 Worker 的 `ALLOWED_ORIGINS` 默认允许 HTTP 本机开发来源。将可选的 `GITHUB_TOKEN` 配置为 Worker secret 即可认证 GitHub 请求。检查 `/health` 并打开插件社区确认发现功能 部署及凭据加载命令见[社区指南](../../../../apps/web/platform/plugin-community.zh.md#community-backend)。
