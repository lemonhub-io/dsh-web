/** The job lifecycle: snapshot commit, dispatch, discovery, polling, result collection and cleanup. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { AUTOMATIC_RUNNER, CloudDevError, GitHubClient, JOB_BRANCH_PREFIX } from './github.ts'
import { RESULT_ARTIFACT, RUNNER_WORKFLOW, RUNNER_WORKFLOW_FILE, RUNNER_WORKFLOW_PATH } from './runner-workflow.ts'
import { snapshot, type SnapshotFile } from './snapshot.ts'
import type {
  CloudJob,
  CloudJobResult,
  CloudRunRequest,
  CloudStartedJob,
  CloudTaskOrigin,
} from './types.ts'
import { unzip } from './zip.ts'

/** Tree requests stay well under GitHub's request body limit. */
const TREE_CHUNK_BYTES = 4 * 1024 * 1024
const ORIGIN_FILE = '.dsh-cloud-request.json'

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason as Error)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** A new job id: time-ordered and unique enough for a branch name. */
export function newJobId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

/** Lifecycle operations for one resolved runner repository. */
export class CloudEngine {
  readonly github: GitHubClient

  /**
   * @param gateway - deployment gateway base URL without a trailing slash.
   * @param repository - resolved runner repository as owner/name.
   * @param token - GitHub credential kept outside model-visible values.
   */
  constructor(
    gateway: string,
    readonly repository: string,
    token: string,
  ) {
    this.github = new GitHubClient(gateway, token, repository)
  }

  /** Verify the token, then resolve and check the runner; the automatic runner is created when missing.
   * @param gateway Deployment gateway base URL.
   * @param choice The person's runner choice An empty choice selects the account-owned private runner.
   * @param token GitHub credential kept outside model-visible values.
   * @param signal Cancellation.
   * @returns Engine for the resolved runner The caller installs the workflow before admitting tasks.
   */
  static async prepare(gateway: string, choice: string, token: string, signal: AbortSignal): Promise<CloudEngine> {
    const account = await new GitHubClient(gateway, token, '').account(signal)
    if (account.missing.length > 0)
      throw new CloudDevError(
        `The GitHub token lacks the ${account.missing.join(' and ')} scope Create a token with repo and workflow scopes`,
        403,
        'token-scopes',
      )
    const automatic = choice === ''
    const engine = new CloudEngine(gateway, automatic ? `${account.login}/${AUTOMATIC_RUNNER}` : choice, token)
    let repository: { private: boolean }
    try {
      repository = await engine.github.json(engine.github.repo(), { signal })
    } catch (error) {
      if (!(error instanceof CloudDevError) || error.status !== 404) throw error
      if (!automatic)
        throw new CloudDevError(
          `Runner repository ${choice} was not found or the token cannot access it`,
          404,
          'runner-missing',
        )
      try {
        repository = await engine.github.json('user/repos', {
          method: 'POST',
          body: {
            name: AUTOMATIC_RUNNER,
            private: true,
            auto_init: true,
            description: 'Private cloud compute for DSH programming tasks',
          },
          signal,
        })
      } catch (error) {
        if (error instanceof CloudDevError && (error.status === 403 || error.status === 404))
          throw new CloudDevError('The token cannot create the private runner repository', error.status, 'runner-denied')
        if (!(error instanceof CloudDevError) || error.status !== 422) throw error
        repository = await engine.github.json(engine.github.repo(), { signal })
      }
    }
    if (automatic && repository.private !== true)
      throw new CloudDevError(
        `${engine.repository} is public The automatic runner must be private Choose a private runner repository`,
        undefined,
        'runner-denied',
      )
    return engine
  }

  private async defaultBranch(signal?: AbortSignal): Promise<string> {
    const repo = await this.github.json<{ default_branch: string }>(this.github.repo(), {
      ...(signal ? { signal } : {}),
    })
    return repo.default_branch
  }

  /** Install or update the runner workflow on the default branch. */
  async installWorkflow(signal?: AbortSignal): Promise<'created' | 'updated' | 'unchanged'> {
    const branch = await this.defaultBranch(signal)
    const path = this.github.repo(`/contents/${RUNNER_WORKFLOW_PATH}`)
    let sha: string | undefined
    try {
      const current = await this.github.json<{ sha: string; content: string }>(
        `${path}?ref=${encodeURIComponent(branch)}`,
        { ...(signal ? { signal } : {}) },
      )
      if (
        new TextDecoder().decode(Uint8Array.from(atob(current.content.replace(/\s/g, '')), c => c.charCodeAt(0))) ===
        RUNNER_WORKFLOW
      )
        return 'unchanged'
      sha = current.sha
    } catch (error) {
      if (!(error instanceof CloudDevError) || error.status !== 404) throw error
    }
    try {
      await this.github.json(path, {
        method: 'PUT',
        body: {
          message: 'Install the DSH cloud run workflow',
          content: base64(new TextEncoder().encode(RUNNER_WORKFLOW)),
          branch,
          ...(sha === undefined ? {} : { sha }),
        },
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if (error instanceof CloudDevError && (error.status === 403 || error.status === 404))
        throw new CloudDevError(
          `The token cannot write the runner workflow in ${this.repository} Grant repo and workflow access`,
          error.status,
          'runner-denied',
        )
      throw error
    }
    return sha === undefined ? 'created' : 'updated'
  }

  private async createTree(
    files: SnapshotFile[],
    origin: CloudTaskOrigin,
    signal?: AbortSignal,
  ): Promise<string> {
    let tree: string | undefined
    let chunk: object[] = [
      { path: ORIGIN_FILE, mode: '100644', type: 'blob', content: JSON.stringify(origin) },
      { path: RUNNER_WORKFLOW_PATH, mode: '100644', type: 'blob', content: RUNNER_WORKFLOW },
      { path: 'workspace/.dsh-cloud-root', mode: '100644', type: 'blob', content: '' },
    ]
    let size = 0
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return
      const created = await this.github.json<{ sha: string }>(this.github.repo('/git/trees'), {
        method: 'POST',
        body: { ...(tree === undefined ? {} : { base_tree: tree }), tree: chunk },
        ...(signal ? { signal } : {}),
      })
      tree = created.sha
      chunk = []
      size = 0
    }
    for (const file of files) {
      const path = 'workspace/' + file.path
      if (file.text !== undefined && file.bytes.length < TREE_CHUNK_BYTES / 2) {
        chunk.push({ path, mode: file.mode, type: 'blob', content: file.text })
      } else {
        const blob = await this.github.json<{ sha: string }>(this.github.repo('/git/blobs'), {
          method: 'POST',
          body: { content: base64(file.bytes), encoding: 'base64' },
          ...(signal ? { signal } : {}),
        })
        chunk.push({ path, mode: file.mode, type: 'blob', sha: blob.sha })
      }
      size += file.bytes.length < TREE_CHUNK_BYTES / 2 ? JSON.stringify(file.text ?? '').length * 3 : 256
      if (size >= TREE_CHUNK_BYTES) await flush()
    }
    await flush()
    if (tree === undefined) throw new CloudDevError('Snapshot tree was not created')
    return tree
  }

  /**
   * Snapshot a directory onto a job branch and dispatch the runner workflow.
   * @param request - command, directory and file selection.
   * @param signal - cancellation; uncertain dispatch retains its snapshot for recovery.
   * @returns the accepted pending job and snapshot size Run discovery can complete later.
   */
  async start(
    request: CloudRunRequest & { directory: string; owner?: string },
    signal?: AbortSignal,
  ): Promise<CloudStartedJob> {
    const command = request.command.trim()
    if (command === '') throw new CloudDevError('Enter a command')
    if (command.length > 20000) throw new CloudDevError('The command is too long')
    if ((request.setup?.length ?? 0) > 20000) throw new CloudDevError('The setup command is too long')
    for (const version of [request.nodeVersion, request.pythonVersion]) {
      if (version !== undefined && !/^[\w.+^~<>=| -]{1,80}$/.test(version))
        throw new CloudDevError('Invalid toolchain version')
    }
    const workdir = request.workdir ?? '.'
    if (isAbsolute(workdir) || workdir.split(/[\\/]/).includes('..'))
      throw new CloudDevError('The cloud working directory must stay inside the snapshot')
    const files = await snapshot(request.directory, request.include ?? [], signal, [resolveDshHome()])
    const id = newJobId()
    const branch = await this.defaultBranch(signal)
    const head = await this.github.json<{ object: { sha: string } }>(this.github.repo(`/git/ref/heads/${branch}`), {
      ...(signal ? { signal } : {}),
    })
    const tree = await this.createTree(files, { directory: request.directory, owner: request.owner ?? null }, signal)
    const snapshotCommit = await this.github.json<{ sha: string }>(this.github.repo('/git/commits'), {
      method: 'POST',
      body: {
        message: `dsh-cloud ${id}: ${(request.description ?? command).split('\n')[0]}`,
        tree,
        parents: [head.object.sha],
      },
      ...(signal ? { signal } : {}),
    })
    const ref = JOB_BRANCH_PREFIX + id
    await this.github.json(this.github.repo('/git/refs'), {
      method: 'POST',
      body: { ref: `refs/heads/${ref}`, sha: snapshotCommit.sha },
      ...(signal ? { signal } : {}),
    })
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.github.json(this.github.repo(`/actions/workflows/${RUNNER_WORKFLOW_FILE}/dispatches`), {
            method: 'POST',
            body: {
              ref,
              inputs: {
                job: id,
                command,
                setup: request.setup ?? '',
                workdir,
                node_version: request.nodeVersion ?? '24',
                python_version: request.pythonVersion ?? '3.12',
                outputs: (request.outputs ?? []).join('\n'),
              },
            },
            ...(signal ? { signal } : {}),
          })
          break
        } catch (error) {
          if (!(error instanceof CloudDevError) || error.status !== 404 || attempt >= 4) throw error
          await sleep(1000, signal)
        }
      }
    } catch (error) {
      if (!(error instanceof CloudDevError) || error.status === undefined) {
        throw new CloudDevError(
          `Dispatch outcome is unknown for job ${id} Check cloud_job before starting another task`,
        )
      }
      await this.removeBranch(id)
      if (error.status === 404)
        throw new CloudDevError(
          'The runner workflow is not available yet Retry the task after GitHub finishes registering it',
          404,
        )
      throw error
    }
    const bytes = files.reduce((sum, file) => sum + file.bytes.length, 0)
    const now = new Date().toISOString()
    return {
      job: {
        id,
        command: request.description ?? command,
        status: 'pending',
        conclusion: null,
        runId: null,
        url: null,
        snapshotCommit: snapshotCommit.sha,
        createdAt: now,
        updatedAt: now,
      },
      files: files.length,
      bytes,
    }
  }

  /** Current state of one job. */
  async job(id: string, signal?: AbortSignal): Promise<CloudJob> {
    this.jobId(id)
    const job = await this.github.findRun(RUNNER_WORKFLOW_FILE, id, signal)
    if (job !== undefined) return job
    await this.github.json(this.github.repo(`/git/ref/heads/${JOB_BRANCH_PREFIX}${this.jobId(id)}`), {
      ...(signal ? { signal } : {}),
    })
    const now = new Date().toISOString()
    return {
      id,
      command: '',
      status: 'pending',
      conclusion: null,
      runId: null,
      url: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  private jobId(id: string): string {
    if (!/^[a-z0-9]+-[a-z0-9-]+$/.test(id)) throw new CloudDevError('Invalid cloud job id')
    return id
  }

  /** Verify an AI task's immutable Session and workspace origin before controls or collection.
   * @param id Cloud job identity.
   * @param owner Calling Session identity.
   * @param directory Calling workspace directory.
   * @param signal Cancellation.
   * @returns The verified origin used for result collection.
   */
  async origin(id: string, owner: string, directory: string, signal: AbortSignal): Promise<CloudTaskOrigin> {
    this.jobId(id)
    const job = await this.job(id, signal)
    const ref = job.snapshotCommit ?? JOB_BRANCH_PREFIX + id
    const stored = await this.github.json<{ content: string }>(
      this.github.repo(`/contents/${ORIGIN_FILE}?ref=${encodeURIComponent(ref)}`),
      { signal },
    )
    const value: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(stored.content.replace(/\s/g, '')), c => c.charCodeAt(0))),
    )
    if (
      typeof value !== 'object' ||
      value === null ||
      !('directory' in value) ||
      !('owner' in value) ||
      typeof value.directory !== 'string' ||
      !isAbsolute(value.directory) ||
      value.owner !== owner ||
      value.directory !== directory
    ) {
      throw new CloudDevError('This cloud task belongs to another Session or workspace', 403)
    }
    return { directory: value.directory, owner }
  }

  /** Wait until a job completes, or until the deadline passes. */
  async wait(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
    onUpdate?: (job: CloudJob) => void,
  ): Promise<CloudJob> {
    const deadline = Date.now() + timeoutMs
    let job = await this.job(id, signal)
    while (job.status !== 'completed' && Date.now() < deadline) {
      await sleep(5000, signal)
      job = await this.job(id, signal)
      onUpdate?.(job)
    }
    return job
  }

  /** Cancel a queued or running job. */
  async cancel(id: string, signal?: AbortSignal): Promise<CloudJob> {
    let job = await this.job(id, signal)
    const deadline = Date.now() + 25000
    while (job.runId === null && Date.now() < deadline) {
      await sleep(1000, signal)
      job = await this.job(id, signal)
    }
    if (job.runId === null)
      throw new CloudDevError(`Cancellation is unconfirmed for job ${id} Check cloud_job before rerunning`, 409)
    if (job.status !== 'completed') {
      await this.github.json(this.github.repo(`/actions/runs/${job.runId}/cancel`), {
        method: 'POST',
        ...(signal ? { signal } : {}),
      })
    }
    return await this.job(id, signal)
  }

  /** Delete the job branch; the run, its logs and its artifact remain. */
  async removeBranch(id: string): Promise<void> {
    await this.github.request(this.github.repo(`/git/refs/heads/${JOB_BRANCH_PREFIX}${id}`), { method: 'DELETE' })
  }

  /**
   * Bring a finished job's log, exit status and returned files into a directory.
   * @param id - job id.
   * @param directory - workspace directory; results land in directory/.dsh-cloud/<id>.
   * @param signal - cancellation.
   * @returns the written result.
   */
  async collect(id: string, directory: string, signal?: AbortSignal): Promise<CloudJobResult> {
    const job = await this.job(id, signal)
    if (job.status !== 'completed' || job.runId === null) throw new CloudDevError(`Job ${id} has not finished`, 409)
    const artifacts = await this.github.json<{ artifacts: { id: number; name: string; expired: boolean }[] }>(
      this.github.repo(`/actions/runs/${job.runId}/artifacts`),
      { ...(signal ? { signal } : {}) },
    )
    const artifact = artifacts.artifacts.find(item => item.name === RESULT_ARTIFACT && !item.expired)
    const target = join(directory, '.dsh-cloud', id)
    if (artifact === undefined) {
      const logs = await unzip(await this.github.bytes(this.github.repo(`/actions/runs/${job.runId}/logs`), signal))
      const log = [...logs].map(([name, bytes]) => name + '\n' + new TextDecoder().decode(bytes)).join('\n')
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'output.log'), log)
      return {
        job,
        exitCode: null,
        durationSeconds: null,
        log: 'The runner failed before producing task artifacts Inspect these workflow logs\n' + log,
        directory: target,
        files: [],
      }
    }
    const entries = await unzip(
      await this.github.bytes(this.github.repo(`/actions/artifacts/${artifact.id}/zip`), signal),
    )
    const text = (name: string): string | undefined => {
      const bytes = entries.get(name)
      return bytes === undefined ? undefined : new TextDecoder().decode(bytes)
    }
    const exitText = text('exit-code')?.trim()
    const durationText = text('duration-seconds')?.trim()
    const exitCode = exitText === undefined || exitText === '' ? null : Number(exitText)
    const duration = durationText === undefined || durationText === '' ? null : Number(durationText)
    if (
      (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) ||
      (duration !== null && (!Number.isFinite(duration) || duration < 0))
    ) {
      throw new CloudDevError('The cloud result metadata is invalid The task outcome cannot be trusted')
    }
    const files: string[] = []
    for (const [name, bytes] of entries) {
      const destination = join(target, name)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes)
      if (name.startsWith('files/')) files.push(name.slice('files/'.length))
    }
    try {
      await this.removeBranch(id)
    } catch (_cleanupFailed) {
      // The result is already written and the run remains authoritative.
      console.warn(`Cloud task ${id} finished but its snapshot branch could not be removed`)
    }
    return {
      job,
      exitCode,
      durationSeconds: duration,
      log: text('output.log') ?? '',
      directory: target,
      files: files.sort(),
    }
  }
}
