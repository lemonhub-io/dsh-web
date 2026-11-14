/** The job lifecycle: snapshot commit, dispatch, discovery, polling, result collection and cleanup. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CloudDevError, GitHubClient, JOB_BRANCH_PREFIX } from './github.ts'
import { RESULT_ARTIFACT, RUNNER_WORKFLOW, RUNNER_WORKFLOW_PATH } from './runner-workflow.ts'
import { snapshot, type SnapshotFile } from './snapshot.ts'
import type { CloudDevSettings, CloudJob, CloudJobResult, CloudRunRequest, CloudStartedJob } from './types.ts'
import { unzip } from './zip.ts'

/** Tree requests stay well under GitHub's request body limit. */
const TREE_CHUNK_BYTES = 4 * 1024 * 1024

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason as Error) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** A new job id: time-ordered and unique enough for a branch name. */
export function newJobId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

/** Validate settings before any request leaves the browser. */
export function checkSettings(settings: CloudDevSettings): void {
  if (!/^https?:\/\/[^/\s]+(?:\/[^\s]*)?$/.test(settings.gatewayUrl)) throw new CloudDevError('Set the gateway URL first')
  if (!/^[\w.-]+\/[\w.-]+$/.test(settings.repository)) throw new CloudDevError('Set the runner repository as owner/name')
  if (!/^[\w.-]+\.ya?ml$/.test(settings.workflow)) throw new CloudDevError('The workflow must be a yml file name')
}

/** Lifecycle operations for one configured runner repository. */
export class CloudEngine {
  readonly github: GitHubClient

  constructor(readonly settings: CloudDevSettings, token: string) {
    checkSettings(settings)
    this.github = new GitHubClient(settings.gatewayUrl.replace(/\/+$/, ''), token, settings.repository)
  }

  private async defaultBranch(signal?: AbortSignal): Promise<string> {
    const repo = await this.github.json<{ default_branch: string }>(this.github.repo(), { ...signal ? { signal } : {} })
    return repo.default_branch
  }

  /** Install or update the runner workflow on the default branch. */
  async installWorkflow(signal?: AbortSignal): Promise<'created' | 'updated' | 'unchanged'> {
    const branch = await this.defaultBranch(signal)
    const path = this.github.repo(`/contents/${RUNNER_WORKFLOW_PATH}`)
    let sha: string | undefined
    try {
      const current = await this.github.json<{ sha: string; content: string }>(`${path}?ref=${encodeURIComponent(branch)}`, { ...signal ? { signal } : {} })
      if (new TextDecoder().decode(Uint8Array.from(atob(current.content.replace(/\s/g, '')), c => c.charCodeAt(0))) === RUNNER_WORKFLOW) return 'unchanged'
      sha = current.sha
    } catch (error) {
      if (!(error instanceof CloudDevError) || error.status !== 404) throw error
    }
    await this.github.json(path, {
      method: 'PUT',
      body: {
        message: 'Install the DSH cloud run workflow',
        content: base64(new TextEncoder().encode(RUNNER_WORKFLOW)),
        branch,
        ...sha === undefined ? {} : { sha },
      },
      ...signal ? { signal } : {},
    })
    return sha === undefined ? 'created' : 'updated'
  }

  /** Whether the runner workflow exists on the default branch. */
  async workflowInstalled(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.github.json(this.github.repo(`/actions/workflows/${this.settings.workflow}`), { ...signal ? { signal } : {} })
      return true
    } catch (error) {
      if (error instanceof CloudDevError && error.status === 404) return false
      throw error
    }
  }

  private async createTree(base: string, files: SnapshotFile[], signal?: AbortSignal): Promise<string> {
    let tree = base
    let chunk: object[] = []
    let size = 0
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return
      const created = await this.github.json<{ sha: string }>(this.github.repo('/git/trees'), { method: 'POST', body: { base_tree: tree, tree: chunk }, ...signal ? { signal } : {} })
      tree = created.sha
      chunk = []
      size = 0
    }
    for (const file of files) {
      const path = 'workspace/' + file.path
      if (file.text !== undefined) {
        chunk.push({ path, mode: file.mode, type: 'blob', content: file.text })
      } else {
        const blob = await this.github.json<{ sha: string }>(this.github.repo('/git/blobs'), { method: 'POST', body: { content: base64(file.bytes), encoding: 'base64' }, ...signal ? { signal } : {} })
        chunk.push({ path, mode: file.mode, type: 'blob', sha: blob.sha })
      }
      size += file.text?.length ?? 64
      if (size >= TREE_CHUNK_BYTES) await flush()
    }
    await flush()
    return tree
  }

  /**
   * Snapshot a directory onto a job branch and dispatch the runner workflow.
   * @param request - command, directory and file selection.
   * @param signal - cancellation; a cancelled start removes its branch.
   * @returns the job once GitHub has created its run, with the snapshot size.
   */
  async start(request: CloudRunRequest & { directory: string }, signal?: AbortSignal): Promise<CloudStartedJob> {
    const command = request.command.trim()
    if (command === '') throw new CloudDevError('Enter a command')
    if (command.length > 20000) throw new CloudDevError('The command is too long')
    const files = await snapshot(request.directory, request.include ?? [], signal)
    const id = newJobId()
    const branch = await this.defaultBranch(signal)
    const head = await this.github.json<{ object: { sha: string } }>(this.github.repo(`/git/ref/heads/${branch}`), { ...signal ? { signal } : {} })
    const commit = await this.github.json<{ tree: { sha: string } }>(this.github.repo(`/git/commits/${head.object.sha}`), { ...signal ? { signal } : {} })
    const tree = await this.createTree(commit.tree.sha, files, signal)
    const snapshotCommit = await this.github.json<{ sha: string }>(this.github.repo('/git/commits'), {
      method: 'POST',
      body: { message: `dsh-cloud ${id}: ${command.split('\n')[0]}`, tree, parents: [head.object.sha] },
      ...signal ? { signal } : {},
    })
    const ref = JOB_BRANCH_PREFIX + id
    await this.github.json(this.github.repo('/git/refs'), { method: 'POST', body: { ref: `refs/heads/${ref}`, sha: snapshotCommit.sha }, ...signal ? { signal } : {} })
    try {
      await this.github.json(this.github.repo(`/actions/workflows/${this.settings.workflow}/dispatches`), {
        method: 'POST',
        body: { ref, inputs: { job: id, command, workdir: request.workdir ?? '.', outputs: (request.outputs ?? []).join('\n') } },
        ...signal ? { signal } : {},
      })
    } catch (error) {
      await this.removeBranch(id).catch(() => undefined)
      if (error instanceof CloudDevError && error.status === 404) throw new CloudDevError('The runner workflow is missing Set up the runner repository first', 404)
      throw error
    }
    const bytes = files.reduce((sum, file) => sum + file.bytes.length, 0)
    for (let attempt = 0; attempt < 30; attempt++) {
      const job = await this.github.findRun(this.settings.workflow, id, signal)
      if (job !== undefined) return { job, files: files.length, bytes }
      await sleep(2000, signal)
    }
    const now = new Date().toISOString()
    return { job: { id, command, status: 'pending', conclusion: null, runId: null, url: null, createdAt: now, updatedAt: now }, files: files.length, bytes }
  }

  /** Current state of one job. */
  async job(id: string, signal?: AbortSignal): Promise<CloudJob> {
    const job = await this.github.findRun(this.settings.workflow, id, signal)
    if (job === undefined) throw new CloudDevError(`Job ${id} was not found`, 404)
    return job
  }

  /** Wait until a job completes, or until the deadline passes. */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal, onUpdate?: (job: CloudJob) => void): Promise<CloudJob> {
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
    const job = await this.job(id, signal)
    if (job.runId !== null && job.status !== 'completed') {
      await this.github.json(this.github.repo(`/actions/runs/${job.runId}/cancel`), { method: 'POST', ...signal ? { signal } : {} })
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
    const artifacts = await this.github.json<{ artifacts: { id: number; name: string; expired: boolean }[] }>(this.github.repo(`/actions/runs/${job.runId}/artifacts`), { ...signal ? { signal } : {} })
    const artifact = artifacts.artifacts.find(item => item.name === RESULT_ARTIFACT && !item.expired)
    const target = join(directory, '.dsh-cloud', id)
    if (artifact === undefined) {
      return { job, exitCode: null, durationSeconds: null, log: 'The run produced no result artifact Open it on GitHub for details', directory: target, files: [] }
    }
    const entries = await unzip(await this.github.bytes(this.github.repo(`/actions/artifacts/${artifact.id}/zip`), signal))
    const text = (name: string): string | undefined => {
      const bytes = entries.get(name)
      return bytes === undefined ? undefined : new TextDecoder().decode(bytes)
    }
    const files: string[] = []
    for (const [name, bytes] of entries) {
      const destination = join(target, name)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes)
      if (name.startsWith('files/')) files.push(name.slice('files/'.length))
    }
    const exitText = text('exit-code')?.trim()
    const durationText = text('duration-seconds')?.trim()
    await this.removeBranch(id).catch(() => undefined)
    return {
      job,
      exitCode: exitText === undefined || exitText === '' ? null : Number(exitText),
      durationSeconds: durationText === undefined || durationText === '' ? null : Number(durationText),
      log: text('output.log') ?? '',
      directory: target,
      files: files.sort(),
    }
  }
}
