/** Direct GitHub management requests and gateway-backed artifact and log downloads. */
import type { CloudDevProblem, CloudJob } from './types.ts'

/** A failure whose message is safe to show to the person running the job. */
export class CloudDevError extends Error {
  /**
   * @param message - English diagnostic for the AI and integrations.
   * @param status - GitHub HTTP status, when GitHub answered.
   * @param problem - known cause the panel localizes.
   */
  constructor(
    message: string,
    readonly status?: number,
    readonly problem?: CloudDevProblem,
  ) {
    super(message)
    this.name = 'CloudDevError'
  }
}

/** Branch prefix that marks a commit as a cloud development job. */
export const JOB_BRANCH_PREFIX = 'dsh-cloud/'

/** Repository name of the automatic private runner in the token owner's account. */
export const AUTOMATIC_RUNNER = 'dsh-cloud-runner'

/** Classic-token scopes that runner creation, workflow installation and dispatch need. */
const REQUIRED_SCOPES = ['repo', 'workflow']

/**
 * Normalize a runner choice typed or pasted by a person.
 * @param input - owner/name, a github.com link or an SSH remote, with or without `.git`.
 * @returns owner/name, or an empty string for the automatic runner.
 * @throws CloudDevError when the text names no repository.
 */
export function parseRepository(input: string): string {
  const text = input.trim()
  if (text === '') return ''
  const link = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)([^?#]*)/i.exec(text)?.[1]
  const path = link === undefined ? text : link.split('/').slice(0, 2).join('/')
  const name = path.replace(/\/+$/, '').replace(/\.git$/i, '')
  const match = /^([A-Za-z0-9-]+)\/([\w.-]+)$/.exec(name)
  if (match === null || match[2] === '.' || match[2] === '..')
    throw new CloudDevError('Enter the runner repository as owner/name or a GitHub link', undefined, 'runner-missing')
  return `${match[1]}/${match[2]}`
}

interface WorkflowRun {
  id: number
  head_branch: string | null
  status: CloudJob['status'] | null
  conclusion: string | null
  html_url: string
  created_at: string
  updated_at: string
  head_commit?: { message?: string } | null
  head_sha?: string
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
    ...(run.head_sha === undefined ? {} : { snapshotCommit: run.head_sha }),
  }
}

/** GitHub JSON uses its native browser API Binary downloads use the gateway for storage redirects. */
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

  async request(
    path: string,
    init: { method?: string; body?: unknown; accept?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    let response: Response
    try {
      const binary = /\/actions\/(?:artifacts\/\d+\/zip|runs\/\d+\/logs)$/.test(path)
      const address = binary ? `${this.gateway}/github/${path}` : `https://api.github.com/${path}`
      response = await fetch(address, {
        credentials: 'omit',
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: init.accept ?? 'application/vnd.github+json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.any([AbortSignal.timeout(30000), ...(init.signal === undefined ? [] : [init.signal])]),
      })
    } catch (error) {
      if (init.signal?.aborted === true) throw error
      throw new CloudDevError(
        'The cloud API could not be reached Check the network and gateway connection',
        undefined,
        'unknown',
      )
    }
    if (response.ok) return response
    let detail = ''
    try {
      const body = (await response.json()) as { message?: string; error?: string }
      detail = body.message ?? body.error ?? ''
    } catch {
      /* non-JSON error body */
    }
    if (response.status === 401) throw new CloudDevError('GitHub rejected the token', 401, 'token-invalid')
    if (response.status === 403 && /rate limit/i.test(detail))
      throw new CloudDevError('GitHub rate limit reached Try again later', 403)
    throw new CloudDevError(`GitHub ${response.status}${detail === '' ? '' : ' ' + detail}`, response.status)
  }

  async json<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const response = await this.request(path, init)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /**
   * Verify the token and read its account.
   * @param signal - cancellation.
   * @returns the account login and the required scopes a classic token lacks; other token kinds report none.
   */
  async account(signal?: AbortSignal): Promise<{ login: string; missing: string[] }> {
    const response = await this.request('user', { ...(signal === undefined ? {} : { signal }) })
    const user = (await response.json()) as { login?: unknown }
    if (typeof user.login !== 'string' || !/^[A-Za-z0-9-]+$/.test(user.login))
      throw new CloudDevError('GitHub returned an invalid account', undefined, 'unknown')
    const header = response.headers.get('x-oauth-scopes')
    if (header === null || !/^gh[po]_/.test(this.token)) return { login: user.login, missing: [] }
    const granted = header.split(',').map(scope => scope.trim())
    return { login: user.login, missing: REQUIRED_SCOPES.filter(scope => !granted.includes(scope)) }
  }

  async bytes(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(path, { ...(signal === undefined ? {} : { signal }) })
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Recent jobs, newest first, read from the runner workflow's runs. */
  async jobs(workflow: string, signal?: AbortSignal): Promise<CloudJob[]> {
    const body = await this.json<{ workflow_runs: WorkflowRun[] }>(
      this.repo(`/actions/workflows/${workflow}/runs?per_page=30&event=workflow_dispatch`),
      { ...(signal === undefined ? {} : { signal }) },
    )
    return body.workflow_runs.flatMap(run => jobFromRun(run) ?? [])
  }

  /** The run of one job, or undefined while GitHub has not created it yet. */
  async findRun(workflow: string, id: string, signal?: AbortSignal): Promise<CloudJob | undefined> {
    const branch = encodeURIComponent(JOB_BRANCH_PREFIX + id)
    const body = await this.json<{ workflow_runs: WorkflowRun[] }>(
      this.repo(`/actions/workflows/${workflow}/runs?per_page=5&branch=${branch}`),
      { ...(signal === undefined ? {} : { signal }) },
    )
    for (const run of body.workflow_runs) {
      const job = jobFromRun(run)
      if (job?.id === id) return job
    }
    return undefined
  }
}
