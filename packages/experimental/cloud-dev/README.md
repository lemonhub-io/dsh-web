---
description: "Give the AI a cloud compute backend for browser programming tasks with automatic runner preparation and result collection."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cloud-dev

English | [中文](README.zh.md)

## Summary

Cloud development gives the AI computing capabilities unavailable in the browser. The AI edits and inspects the project locally, chooses cloud tasks and environments, and consumes the returned diagnostics and artifacts to continue programming. GitHub Actions supplies compute and a stateless gateway enables binary artifact retrieval. The sidebar is a one-time connection and activity monitor; task execution belongs to the AI.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Open Cloud development and connect a GitHub token with repository and workflow write permissions once. The token stays in the credential store as `DSH_CLOUD_GITHUB_TOKEN`; it is never inserted into model requests or runner inputs. Leaving the repository empty automatically creates an initialized private `dsh-cloud-runner` repository in the token owner's account. Advanced connection settings can select an existing runner, gateway and workflow file.

Describe the programming goal in the conversation. The AI uses `cloud_run` for dependency installation, builds, tests, native programs or other computation the browser cannot perform. It selects `command`, optional `setup`, input and output globs, and Node/Python versions from the project. Default toolchains are Node 24 and Python 3.12. The service installs or updates the runner workflow before submitting a task; users do not initialize workflows or type execution commands.

The normal call waits and collects logs, exit code and artifacts into `<workspace>/.dsh-cloud/<job>/`. Returned files are under `files/`. The AI reads them using normal workspace tools and continues coding. Background calls and expired wait budgets return a job id; `cloud_job` waits and collects by default, with explicit status and cancellation actions. A running job is never reported as a successful completed task.

The panel shows connection state and job history. It has no manual command submission or result-collection controls. Ask the AI to continue or cancel a task in the conversation. Existing human-facing Remote methods remain available to authenticated integrations.

<a id="understand-the-implementation"></a>
## Understand the implementation

- `src/index.ts` contributes logged programming guidance and the `cloud_status`, `cloud_run` and `cloud_job` tools. Preparation is serialized per service. Active operations combine caller and plugin cancellation and are awaited during disposal.
- `src/engine.ts` snapshots the Session's working directory onto a `dsh-cloud/<job>` branch and dispatches the workflow. An immutable origin record binds the snapshot to its Session and workspace. AI result and cancellation operations verify that record before acting; result files are never routed using a different Session's current directory.
- `src/snapshot.ts` always excludes the DSH application data home, including when it is nested inside the workspace, plus dependency caches, prior results, `.ssh`, `.credentials`, private `.env` variants and PEM/key files. Environment examples and templates can be uploaded. Limits are 2000 files, 40 MiB total and 10 MiB per file.
- `src/runner-workflow.ts` prepares toolchains, runs setup before the task, stops on command failure, captures logs and outputs, and uploads the result artifact. A missing result artifact causes automatic workflow-log retrieval for AI diagnosis. Failed or unverifiable runs return a failed status.
- `src/github.ts` uses GitHub’s native browser API for account and repository management. `gateway/worker.js` handles binary downloads and follows artifact/log redirects without forwarding the personal token to storage. The default gateway is `https://dsh-gw.openhub.today`; `gateway/deploy.ts` deploys it with the configured Worker credential. `DSH_GATEWAY_HOSTNAME` and `DSH_GATEWAY_ORIGINS` configure its domain and allowed origins.
- Dispatch transport failures preserve the job branch and identify the unknown job outcome instead of silently submitting another job. Confirmed missing-workflow refusals receive a bounded registration retry. Cancelling an active wait requests remote cancellation; unconfirmed cancellation is reported with the job id.

<a id="model-experience"></a>
## Model Experience

The prompt tells the AI to keep editing locally, select cloud work when local capabilities are insufficient, inspect exit codes and artifacts, and diagnose failures before rerunning. Static guidance and tool schemas add prompt tokens; cloud results are logged JSON with explicit task status, job id, exit code when known, artifact paths and a bounded log tail. Full logs remain in the workspace for targeted reads. No hidden model request or paid-model retry loop is added.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- GitHub Actions cold starts and queue times apply; this is task compute rather than an interactive terminal. Logs arrive at completion and do not stream.
- Artifacts are retained for three days. A task intentionally left in the background continues remotely until completion or cancellation.
- AI controls require an origin record from the creating Session. Pre-refactor jobs without that record remain inspectable on GitHub but cannot be claimed by a different Session.
- Results are collected into a task directory. The AI integrates selected files into the project; the plugin does not overwrite unrelated local edits.
