# Ordinary Cordis plugin example

English | [中文](README.zh.md)

The source uses the existing Cordis `apply(ctx)` entry and DSH tool registry. Enable it to add `community_echo`; disabling or uninstalling it releases that registration. `cordis.patch.yml` and `package.json.dsh.bundle` use the normal bundle format.

Prepare the Web distribution from the repository root with `node --import tsx/esm scripts/pack-web-plugin.ts --src apps/web/plugin-examples/hello --out /tmp/hello-1.0.0.tgz`. The tool uses the existing Node compatibility transform without introducing an SDK. See the [community guide](../../platform/plugin-community.md) for publishing and compatibility checks.
