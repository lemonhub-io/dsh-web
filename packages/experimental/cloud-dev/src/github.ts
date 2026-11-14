/** GitHub REST calls routed through the stateless gateway. */
import type { CloudJob } from './types.ts'

/** A failure whose message is safe to show to the person running the job. */
export class CloudDevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'CloudDevError'
  }
}

/** Branch prefix that marks a commit as a cloud development job. */
export const JOB_BRANCH_PREFIX = 'dsh-cloud/'

interface WorkflowRun {
  id: number
  head_branch: string | null
  status: CloudJob['status'] | null
  conclusion: string | null
  html_url: string
  created_at: string
  updated_at: string
  head_commit?: { message?: string } | null
}

/** Map one workflow run onto a job, or undefined for runs this plugin did not start. */
export function jobFromRun(run: WorkflowRun): CloudJob | undefined {
  const branch = run.head_branch ?? ''
  if (!branch.startsWith(JOB_BRANCH_PREFIX)) return undefined
  const message = run.head_commit?.message ?? ''
  return {
    id: branch.slice(JOB_BRANCH_PREFIX.length),
    command: message.split('\n')[0]?.replace(/^dsh-cloud [\w-]+: /, '') ?? '',
    status: run.status ?? 'queued',
    conclusion: run.conclusion,
    runId: run.id,
    url: run.html_url,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  }
}

/** Thin GitHub client; the gateway forwards the token and follows storage redirects. */
export class GitHubClient {
  constructor(
    private readonly gateway: string,
    private readonly token: string,
    readonly repository: string,
  ) {}

  /** Repository-relative REST path. */
  repo(path = ''): string {
    return `repos/${this.repository}${path}`
  }

  async request(path: string, init: { method?: string; body?: unknown; accept?: string; signal?: AbortSignal } = {}): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${this.gateway}/github/${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: init.accept ?? 'application/vnd.github+json',
          ...init.body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
        ...init.signal === undefined ? {} : { signal: init.signal },
      })
    } catch (error) {
      if (init.signal?.aborted === true) throw error
      throw new CloudDevError('The gateway could not be reached Check its URL')
    }
    if (response.ok) return response
    let detail = ''
    try {
      const body = await response.json() as { message?: string; error?: string }
      detail = body.message ?? body.error ?? ''
    } catch { /* non-JSON error body */ }
    if (response.status === 401) throw new CloudDevError('GitHub rejected the token', 401)
    if (response.status === 403 && /rate limit/i.test(detail)) throw new CloudDevError('GitHub rate limit reached Try again later', 403)
    throw new CloudDevError(`GitHub ${response.status}${detail === '' ? '' : ' ' + detail}`, response.status)
  }

  async json<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const response = await this.request(path, init)
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  async bytes(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(path, { ...signal === undefined ? {} : { signal } })
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Recent jobs, newest first, read from the runner workflow's runs. */
  async jobs(workflow: string, signal?: AbortSignal): Promise<CloudJob[]> {
    const body = await this.json<{ workflow_runs: WorkflowRun[] }>(
      this.repo(`/actions/workflows/${workflow}/runs?per_page=30&event=workflow_dispatch`),
      { ...signal === undefined ? {} : { signal } },
    )
    return body.workflow_runs.flatMap(run => jobFromRun(run) ?? [])
  }

  /** The run of one job, or undefined while GitHub has not created it yet. */
  async findRun(workflow: string, id: string, signal?: AbortSignal): Promise<CloudJob | undefined> {
    const branch = encodeURIComponent(JOB_BRANCH_PREFIX + id)
    const body = await this.json<{ workflow_runs: WorkflowRun[] }>(
      this.repo(`/actions/workflows/${workflow}/runs?per_page=5&branch=${branch}`),
      { ...signal === undefined ? {} : { signal } },
    )
    for (const run of body.workflow_runs) {
      const job = jobFromRun(run)
      if (job?.id === id) return job
    }
    return undefined
  }
}
