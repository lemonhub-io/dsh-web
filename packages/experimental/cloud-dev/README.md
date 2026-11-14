---
description: "Run workspace commands on GitHub Actions through a stateless Cloudflare Worker gateway and bring the results back."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cloud-dev

English | [中文](README.zh.md)

## Summary

Cloud development hands build and run work to GitHub Actions. DSH Web stays a stateless front end, a Cloudflare Worker forwards requests as a stateless gateway, and a runner repository supplies elastic compute. The **Cloud development** sidebar panel and the `cloud_run` and `cloud_job` agent tools share one Host service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

1. Deploy the gateway with `wrangler deploy` in `gateway/`, or with `CF_WORKERS_TOKEN=... pnpm --filter @deepseek-ai/dsh-experimental-cloud-dev run deploy:gateway`. The token needs Workers Scripts edit and Workers Routes edit permissions. Both bind the custom domain `dsh-gw.openhub.today`; `DSH_GATEWAY_HOSTNAME` and `DSH_GATEWAY_ORIGINS` override the domain and the Web origins allowed to call it. `wrangler dev` in `gateway/` runs the same Worker locally. The panel defaults to the public gateway `https://dsh-gw.openhub.today`, which accepts `https://dsh.openhub.today` and localhost.
2. Create a private runner repository with at least one commit on its default branch.
3. In the panel, enter the gateway URL, the repository as `owner/name`, and a GitHub token with `repo` and `workflow` scopes. The token is stored as the `DSH_CLOUD_GITHUB_TOKEN` credential, never in the settings file.
4. Select **Set up runner repository** to install `.github/workflows/dsh-cloud-run.yml`.
5. Enter a command and select **Run in the cloud**. When the job finishes, **Bring back result** writes the log, exit code, and returned files to `<directory>/.dsh-cloud/<job>/`.

Agents call `cloud_run` with a command and optional `include`, `outputs`, and `workdir`. By default it waits and returns the result; with `wait: false` it returns a job id for `cloud_job`.

<a id="understand-the-implementation"></a>
## Understand the implementation

- `src/engine.ts` uploads a snapshot as a commit on a `dsh-cloud/<job>` branch, dispatches the workflow on that branch, and finds the run by its branch. GitHub holds every job's state, so the Host and Worker keep none.
- `gateway/worker.js` forwards only the GitHub REST paths the engine uses, passes the caller's token through, and strips it before following artifact download redirects.
- `src/runner-workflow.ts` defines the workflow. It runs the command, captures the output, exit code and duration, collects `outputs` globs, and uploads one `dsh-cloud-result` artifact.
- `src/zip.ts` unpacks that artifact with the platform `DecompressionStream`, and rejects unsafe paths.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Snapshots skip `.git`, `node_modules`, virtual environments, and build caches. They are limited to 2000 files, 40 MiB in total, and 10 MiB per file.
- Logs arrive when the job finishes. They do not stream.
- Artifacts are kept for 3 days.
