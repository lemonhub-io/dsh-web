---
kind: upgrade-guide
description: "Cloud development task control moves to AI tools and requires a Session origin record."
---

# AI-controlled cloud computing

English | [中文](guide.zh.md)

## Change

Cloud development provides a connection and activity panel. AI submits commands and collects results through `cloud_run` and `cloud_job`. The latter waits and collects by default. Use `action: status` for a nonblocking query. AI controls verify the task's creating Session and workspace.

## Migration

Keep the existing GitHub credential and connection settings. Ask the AI to execute computing tasks in the conversation. An empty runner repository is prepared automatically as a private account-owned repository. Existing jobs without Session origin records remain viewable on GitHub. Start new tasks in the working Session for automatic collection. Explicit authenticated Remote integrations retain their methods.
