---
kind: upgrade-guide
description: "Cloud development task control moves to AI tools and requires a Session origin record, and the connection keeps only the runner choice."
---

# AI-controlled cloud computing

English | [中文](guide.zh.md)

## Change

Cloud development provides a connection and activity panel. AI submits commands and collects results through `cloud_run` and `cloud_job`. The latter waits and collects by default. Use `action: status` for a nonblocking query. AI controls verify the task's creating Session and workspace.

The panel keeps only the runner repository choice. The gateway URL moves to the plugin's `gatewayUrl` configuration, and the workflow file is always `dsh-cloud-run.yml`. The `configure` and `setup` Remote methods are replaced by `connect`, which verifies the token and prepares the runner before storing either, and `disconnect`. `status` reports one `problem` with the account and runner instead of separate token, gateway, repository and workflow fields.

## Migration

Keep the existing GitHub credential and runner repository. A saved gateway URL or workflow name is ignored: set a custom gateway as `gatewayUrl` under the `cloud-dev` entry in cordis.yml. Integrations call `connect` with `{ token?, repository }` in place of `configure` followed by `setup`. Ask the AI to execute computing tasks in the conversation. An empty runner repository is prepared automatically as a private account-owned repository. Existing jobs without Session origin records remain viewable on GitHub. Start new tasks in the working Session for automatic collection. Explicit authenticated Remote integrations retain their methods.
