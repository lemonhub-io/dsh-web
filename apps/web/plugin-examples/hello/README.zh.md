# 普通 Cordis 插件示例

[English](README.md) | 中文

源码使用现有的 Cordis `apply(ctx)` 入口和 DSH 工具注册表。启用后会添加 `community_echo`；停用或卸载时会释放这项注册。`cordis.patch.yml` 与 `package.json.dsh.bundle` 使用普通组合包格式。

在仓库根目录用 `node --import tsx/esm scripts/pack-web-plugin.ts --src apps/web/plugin-examples/hello --out /tmp/hello-1.0.0.tgz` 准备 Web 发行包。该工具使用现有的 Node 兼容转换，不引入 SDK。发布与兼容性检查见[社区指南](../../platform/plugin-community.zh.md)。
