---
kind: upgrade-guide
description: "Plugin community GitHub reads move to a dedicated Worker backend with server-side authentication."
---

# Plugin community backend

English | [中文](guide.zh.md)

## Change

Plugin community sends GitHub discovery and source requests to `https://dsh-community.openhub.today`. The Worker holds the GitHub credential and serves public repository data. Browser clients validate downloaded packages and pinned Git blobs as before.

## Migration

Reload DSH Web to load the updated community client. Deployments can select another HTTPS Worker using `communityBackendUrl` on the `ui-plugin-manager` entry. Add the deployment origin to that Worker's `ALLOWED_ORIGINS`. HTTP localhost development origins are enabled by default. Provision the optional `GITHUB_TOKEN` as a Worker secret to authenticate GitHub requests. Check `/health` and open Plugin community to confirm discovery. Deployment and credential-loading commands are in the [community guide](../../../../apps/web/platform/plugin-community.md#community-backend).
