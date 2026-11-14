/**
 * Cloud development: the browser stays a stateless front end, a Cloudflare Worker is the stateless
 * gateway, and GitHub Actions compiles and runs workspace snapshots asynchronously. Job state lives
 * in GitHub (job branches, runs and artifacts); this plugin keeps only the person's runner choice and
 * a GitHub token in the credential store. The gateway URL is deployment configuration.
 * @module @deepseek-ai/dsh-experimental-cloud-dev
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ToolOutputDefinition, ToolExecution, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CloudEngine } from './engine.ts'
import { AUTOMATIC_RUNNER, CloudDevError, GitHubClient, parseRepository } from './github.ts'
import { RUNNER_WORKFLOW_FILE } from './runner-workflow.ts'
import type {
  CloudConnectRequest,
  CloudDevProblem,
  CloudDevSettings,
  CloudDevStatus,
  CloudJob,
  CloudJobResult,
  CloudRunRequest,
  CloudStartedJob,
} from './types.ts'

export type {
  CloudConnectRequest,
  CloudDevProblem,
  CloudDevSettings,
  CloudDevStatus,
  CloudJob,
  CloudJobResult,
  CloudRunRequest,
  CloudStartedJob,
} from './types.ts'
export { RUNNER_WORKFLOW, RUNNER_WORKFLOW_FILE, RUNNER_WORKFLOW_PATH } from './runner-workflow.ts'
export { parseRepository } from './github.ts'

/** Deployment configuration; the person only chooses a runner repository in the panel. */
export const Config = z
  .object({
    /** Base URL of the stateless gateway Worker that serves artifact and log downloads. */
    gatewayUrl: z.url({ protocol: /^https?$/ }).default('https://dsh-gw.openhub.today'),
  })
  .prefault({})
/** Validated deployment configuration after schema defaults. */
export type Config = z.infer<typeof Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cloud development jobs on GitHub Actions. */
    cloudDev: CloudDevService
  }
}

/** Credential reference holding the GitHub token used for the runner repository. */
export const TOKEN_REF = 'DSH_CLOUD_GITHUB_TOKEN'
const LOG_TAIL = 6000

/** Model-visible readiness text for each problem; the panel localizes the same causes. */
const PROBLEM_TEXT: Record<CloudDevProblem, string> = {
  'none': 'Cloud compute is connected Use cloud_run to automatically prepare the private runner and execute the task',
  'token-missing':
    'Ask the user to connect GitHub once in the Cloud development panel Never ask for or accept a token in chat',
  'token-invalid':
    'GitHub rejected the stored token Ask the user to reconnect in the Cloud development panel Never ask for a token in chat',
  'token-scopes':
    'The stored GitHub token lacks the repo or workflow scope Ask the user to reconnect in the Cloud development panel',
  'gateway': 'The cloud download gateway is unreachable Retry later',
  'runner-missing':
    'The chosen runner repository was not found Ask the user to fix the runner in the Cloud development panel',
  'runner-denied':
    'The token cannot use the chosen runner repository Ask the user to fix the runner in the Cloud development panel',
  'unknown': 'GitHub could not be reached Retry later',
}

function failure(error: unknown): never {
  if (error instanceof RemoteError) throw error
  if (error instanceof DOMException && error.name === 'AbortError') throw error
  const message = error instanceof Error ? error.message : 'Cloud development failed'
  const problem = error instanceof CloudDevError ? error.problem : undefined
  throw new RemoteError('cloudDev/failed', message, { message, ...(problem === undefined ? {} : { problem }) })
}

function describeResult(result: CloudJobResult): string {
  const log = result.log.length > LOG_TAIL ? '…' + result.log.slice(-LOG_TAIL) : result.log
  return [
    `Job ${result.job.id} ${result.job.conclusion ?? result.job.status} exit code ${result.exitCode ?? 'unknown'}${result.durationSeconds === null ? '' : ` in ${result.durationSeconds}s`}`,
    result.job.url === null ? '' : `Run: ${result.job.url}`,
    `Results: ${result.directory}`,
    result.files.length === 0 ? 'Returned files: none' : `Returned files (under files/): ${result.files.join(', ')}`,
    '--- output',
    log,
  ]
    .filter(line => line !== '')
    .join('\n')
}

function describeJob(job: CloudJob, note = ''): string {
  return [`Job ${job.id} ${job.status}${job.conclusion === null ? '' : ' ' + job.conclusion}`, job.url ?? '', note]
    .filter(Boolean)
    .join('\n')
}

type ToolExec = ToolExecution
interface RunArgs {
  command: string
  description?: string
  setup?: string
  node_version?: string
  python_version?: string
  include?: string[]
  outputs?: string[]
  workdir?: string
  wait?: boolean
  timeout_seconds?: number
}
interface JobArgs {
  id: string
  action?: 'status' | 'result' | 'cancel'
  timeout_seconds?: number
}

interface CloudPreparation {
  engine: CloudEngine
  change: 'created' | 'updated' | 'unchanged'
}
interface CloudToolResult {
  status: 'ready' | 'needs-connection' | 'running' | 'completed' | 'failed' | 'cancelled'
  text: string
  jobId?: string
  exitCode?: number
  directory?: string
  files?: string[]
}
const TEXT_OUTPUT: ToolOutputDefinition = {
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ready', 'needs-connection', 'running', 'completed', 'failed', 'cancelled'] },
      text: { type: 'string' },
      jobId: { type: 'string' },
      exitCode: { type: 'integer' },
      directory: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
    },
    required: ['status', 'text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  presentationMeta: (_args, value) => value,
}
function presentCloudResult(_args: unknown, result: ToolResult): ToolResultView | undefined {
  const value = result.meta
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.text !== 'string')
    return undefined
  return {
    card: 'terminal',
    output: value.text,
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
  }
}
function taskResult(result: CloudJobResult): CloudToolResult {
  return {
    status: result.exitCode === 0 && result.job.conclusion === 'success' ? 'completed' : 'failed',
    text: describeResult(result),
    jobId: result.job.id,
    directory: result.directory,
    files: result.files,
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
  }
}

/** Host service: the runner choice, readiness checks, the job lifecycle, and the agent tools. */
export default class CloudDevService extends TypertRemoteService {
  static inject = ['typert', 'credentials', 'tools', 'workingDirectory', 'systemPrompt']
  static Config = Config
  private readonly settingsFile = join(resolveDshHome(), 'cloud-dev', 'settings.json')
  private readonly gateway: string

  private preparing: Promise<CloudPreparation> | undefined
  /** Account of the last token GitHub accepted, so the automatic runner resolves without a request per poll. */
  private known: { token: string; login: string } | undefined
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  /**
   * @param ctx - Owning plugin context.
   * @param config - Validated deployment configuration; direct composition without one gets the schema defaults.
   */
  constructor(ctx: Context, config: Config = Config.parse({})) {
    super(ctx, 'cloudDev', { namespace: 'cloudDev' })
    this.gateway = config.gatewayUrl.replace(/\/+$/, '')
    ctx.effect(
      () => async () => {
        this.lifetime.abort()
        await Promise.allSettled([...this.operations])
      },
      'cloud-dev: operations',
    )
    ctx.systemPrompt.section({
      name: 'cloud-development',
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
      text: `Use cloud_run as the browser workspace's compute backend for dependency installation, builds, tests, native binaries, Docker and resource-intensive processing. Inspect and edit project files locally, then choose the smallest relevant cloud task yourself. Do not ask the user to type commands, initialize a runner or manually retrieve results.
Inspect project manifests and lockfiles to choose setup commands and Node or Python versions. Supply a concise description, the command, optional setup, required input globs and output globs. Dependencies are installed remotely; common local credential files and dependency caches are excluded. The private runner and workflow are prepared automatically. If credentials are missing, ask only for the one-time GitHub connection in Cloud development and never ask for a token in chat.
Prefer cloud_run's default waiting mode. It collects logs, exit status and artifacts automatically. Read the returned status and exit code; diagnose failures, edit locally and rerun the relevant task when needed. A queued or running job is not success: continue with cloud_job until it finishes, or explicitly report the outstanding job. cloud_job collects results by default and is restricted to the current Session and workspace. Results are in .dsh-cloud/<job>/files; inspect and integrate them using workspace tools without overwriting unrelated local edits.`,
    })
    this.registerTools()
  }

  private async readSettings(): Promise<CloudDevSettings> {
    try {
      const stored = JSON.parse(await readFile(this.settingsFile, 'utf8')) as { repository?: unknown }
      return { repository: typeof stored.repository === 'string' ? parseRepository(stored.repository) : '' }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return { repository: '' }
      throw new CloudDevError('Cloud connection settings could not be read Reconnect through Cloud development')
    }
  }

  private async writeSettings(settings: CloudDevSettings): Promise<void> {
    await mkdir(dirname(this.settingsFile), { recursive: true })
    await writeFileAtomic(this.settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  }

  private async storedToken(): Promise<string | undefined> {
    const token = await this.ctx.credentials.resolve(credentialRef(TOKEN_REF))
    return token === undefined || token.value === '' ? undefined : token.value
  }

  private async runner(settings: CloudDevSettings, token: string, signal: AbortSignal): Promise<string> {
    if (settings.repository !== '') return settings.repository
    if (this.known?.token !== token)
      this.known = { token, login: (await new GitHubClient(this.gateway, token, '').account(signal)).login }
    return `${this.known.login}/${AUTOMATIC_RUNNER}`
  }

  private async engine(signal: AbortSignal): Promise<CloudEngine> {
    const settings = await this.readSettings()
    const token = await this.storedToken()
    if (token === undefined)
      throw new CloudDevError(
        'Connect GitHub once in Cloud development The AI prepares and runs compute tasks after connection',
        undefined,
        'token-missing',
      )
    return new CloudEngine(this.gateway, await this.runner(settings, token, signal), token)
  }

  private async prepare(settings: CloudDevSettings, token: string, signal: AbortSignal): Promise<CloudPreparation> {
    const engine = await CloudEngine.prepare(this.gateway, settings.repository, token, signal)
    return { engine, change: await engine.installWorkflow(signal) }
  }

  private async preparedEngine(signal: AbortSignal): Promise<CloudPreparation> {
    if (this.preparing !== undefined) return await this.preparing
    const preparation = (async () => {
      const settings = await this.readSettings()
      const token = await this.storedToken()
      if (token === undefined)
        throw new CloudDevError(
          'Connect GitHub once in Cloud development Do not provide the token in chat',
          undefined,
          'token-missing',
        )
      return await this.prepare(settings, token, signal)
    })()
    this.preparing = preparation
    try {
      return await preparation
    } finally {
      this.preparing = undefined
    }
  }

  /** Wait for an in-flight preparation so a connection change never races it. */
  private async settled(): Promise<void> {
    if (this.preparing === undefined) return
    try {
      await this.preparing
    } catch (_preparationFailed) {
      /* A completed failed setup does not prevent replacing its connection. */
    }
  }

  private operation<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const owned = AbortSignal.any([signal, this.lifetime.signal])
    owned.throwIfAborted()
    const promise = run(owned)
    this.operations.add(promise)
    return promise.finally(() => {
      this.operations.delete(promise)
    })
  }

  private async waitForTask(engine: CloudEngine, id: string, timeout: number, signal: AbortSignal): Promise<CloudJob> {
    try {
      return await engine.wait(id, timeout, signal)
    } catch (error) {
      if (signal.aborted) {
        try {
          await engine.cancel(id, AbortSignal.timeout(30000))
        } catch (cancelError) {
          throw new CloudDevError(
            `Job ${id} cancellation is unconfirmed Check cloud_job before rerunning ${cancelError instanceof Error ? cancelError.message : ''}`,
          )
        }
      }
      throw error
    }
  }

  private defaultDirectory(): string {
    return process.cwd()
  }

  /**
   * Check the token, gateway and runner live.
   * @param signal - query cancellation.
   * @returns the first problem blocking the next task, with the account and runner once known.
   */
  @Remote
  async status(signal: AbortSignal): Promise<CloudDevStatus> {
    return this.operation(signal, active => this.readStatus(active))
  }

  private async readStatus(signal: AbortSignal): Promise<CloudDevStatus> {
    const settings = await this.readSettings()
    const status: CloudDevStatus = {
      settings,
      problem: 'none',
      account: null,
      runner: settings.repository === '' ? null : settings.repository,
      defaultDirectory: this.defaultDirectory(),
      tokenRef: TOKEN_REF,
    }
    const token = await this.storedToken()
    if (token === undefined) return { ...status, problem: 'token-missing' }
    let account: { login: string; missing: string[] }
    try {
      account = await new GitHubClient(this.gateway, token, '').account(signal)
    } catch (error) {
      signal.throwIfAborted()
      return { ...status, problem: error instanceof CloudDevError && error.problem === 'token-invalid' ? 'token-invalid' : 'unknown' }
    }
    this.known = { token, login: account.login }
    status.account = account.login
    status.runner = settings.repository === '' ? `${account.login}/${AUTOMATIC_RUNNER}` : settings.repository
    if (account.missing.length > 0) return { ...status, problem: 'token-scopes' }
    try {
      const response = await fetch(this.gateway + '/health', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      })
      const body = (await response.json()) as { service?: string }
      if (body.service !== 'dsh-cloud-gateway') return { ...status, problem: 'gateway' }
    } catch (_unreachableGateway) {
      signal.throwIfAborted()
      return { ...status, problem: 'gateway' }
    }
    try {
      const engine = new CloudEngine(this.gateway, status.runner, token)
      await engine.github.json(engine.github.repo(), { signal })
    } catch (error) {
      signal.throwIfAborted()
      const code = error instanceof CloudDevError ? error.status : undefined
      // The automatic runner is created by the next connection or task.
      if (code === 404 && settings.repository === '') return status
      return {
        ...status,
        problem: code === 404 ? 'runner-missing' : code === 401 || code === 403 ? 'runner-denied' : 'unknown',
      }
    }
    return status
  }

  /**
   * Verify a token and runner choice, prepare the runner and its workflow, then store both.
   * Nothing is stored when any step fails, so a mistyped token never replaces a working one.
   * @param request - optional new token and the runner choice.
   * @param signal - cancellation.
   * @returns readiness after the connection.
   */
  @Remote
  async connect(request: CloudConnectRequest, signal: AbortSignal): Promise<CloudDevStatus> {
    try {
      return await this.operation(signal, async (active) => {
        await this.settled()
        active.throwIfAborted()
        const settings: CloudDevSettings = { repository: parseRepository(request.repository) }
        const supplied = request.token?.trim() ?? ''
        if (/\s/.test(supplied))
          throw new CloudDevError('The GitHub token cannot contain spaces', undefined, 'token-invalid')
        const token = supplied === '' ? await this.storedToken() : supplied
        if (token === undefined) throw new CloudDevError('Paste a GitHub token first', undefined, 'token-missing')
        await this.prepare(settings, token, active)
        if (supplied !== '') await this.ctx.credentials.set(credentialRef(TOKEN_REF), supplied)
        await this.writeSettings(settings)
        return await this.readStatus(active)
      })
    } catch (error) {
      failure(error)
    }
  }

  /**
   * Remove the stored GitHub token; the runner choice and remote jobs remain.
   * @param signal - cancellation.
   * @returns readiness after the token is removed.
   */
  @Remote
  async disconnect(signal: AbortSignal): Promise<CloudDevStatus> {
    try {
      return await this.operation(signal, async (active) => {
        await this.settled()
        await this.ctx.credentials.unset(credentialRef(TOKEN_REF))
        this.known = undefined
        return await this.readStatus(active)
      })
    } catch (error) {
      failure(error)
    }
  }

  /**
   * Snapshot a directory and start a job.
   * @param request - command and file selection; the directory defaults to the current workspace.
   * @param signal - cancellation.
   * @returns the started job.
   */
  @Remote
  async start(request: CloudRunRequest, signal: AbortSignal): Promise<CloudStartedJob> {
    try {
      return await this.operation(signal, async active =>
        (await this.preparedEngine(active)).engine.start(
          { ...request, directory: request.directory ?? this.defaultDirectory() },
          active,
        ),
      )
    } catch (error) {
      failure(error)
    }
  }

  /**
   * Recent jobs, newest first, read from GitHub.
   * @param signal - cancellation.
   * @returns jobs started by this plugin.
   */
  @Remote
  async jobs(signal: AbortSignal): Promise<CloudJob[]> {
    try {
      return await this.operation(signal, async (active) => {
        const engine = await this.engine(active)
        try {
          return await engine.github.jobs(RUNNER_WORKFLOW_FILE, active)
        } catch (error) {
          // A runner without its workflow yet has no history.
          if (error instanceof CloudDevError && error.status === 404) return []
          throw error
        }
      })
    } catch (error) {
      failure(error)
    }
  }

  /**
   * Cancel a job.
   * @param id - job id.
   * @param signal - cancellation.
   * @returns the job after the request.
   */
  @Remote
  async cancel(id: string, signal: AbortSignal): Promise<CloudJob> {
    try {
      return await this.operation(signal, async active => (await this.engine(active)).cancel(id, active))
    } catch (error) {
      failure(error)
    }
  }

  /**
   * Bring a finished job's result into a directory.
   * @param id - job id.
   * @param directory - target workspace; the default directory when omitted.
   * @param signal - cancellation.
   * @returns the written result.
   */
  @Remote
  async collect(id: string, directory: string | undefined, signal: AbortSignal): Promise<CloudJobResult> {
    try {
      return await this.operation(signal, async active =>
        (await this.engine(active)).collect(id, directory ?? this.defaultDirectory(), active),
      )
    } catch (error) {
      failure(error)
    }
  }

  private registerTools(): void {
    const ctx = this.ctx
    const scope = async (exec: ToolExec): Promise<{ directory: string; owner: string }> => {
      if (exec.agent === undefined) throw new CloudDevError('Cloud computing requires an active programming Session')
      return { directory: await ctx.workingDirectory.ensure(exec.agent, exec.signal), owner: exec.agent.session.id }
    }
    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'cloud_status',
          description:
            'Read cloud computing readiness without creating jobs or exposing credentials. A missing connection is the only prerequisite the user must supply; cloud_run prepares the runner automatically.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: TEXT_OUTPUT,
          execute: async (_args: object, exec: ToolExec): Promise<CloudToolResult> =>
            this.operation(exec.signal, async (signal) => {
              const { problem } = await this.readStatus(signal)
              return { status: problem === 'none' ? 'ready' : 'needs-connection', text: PROBLEM_TEXT[problem] }
            }),
        }),
      'cloud-dev: cloud_status tool',
    )
    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'cloud_run',
          description:
            'Execute a programming task that cannot run efficiently in the browser. Automatically prepare a private GitHub Actions runner, snapshot the current Session workspace, configure Node and Python, run setup and command, wait and collect logs and output files. Choose commands and file globs from the project manifests yourself. Failed tasks return a failed status and exit code for diagnosis; queued tasks return a job id to continue with cloud_job. Dependency caches and common local credential files are excluded.',
          parameters: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'Short purpose of this computing task shown in the conversation',
              },
              command: {
                type: 'string',
                description: 'Bash command for the actual task Failures stop the command pipeline',
              },
              setup: {
                type: 'string',
                description:
                  'Dependency and tool preparation before the task For example npm ci or python -m pip install -r requirements.txt',
              },
              node_version: { type: 'string', description: 'Node version compatible with the project Default 24' },
              python_version: {
                type: 'string',
                description: 'Python version compatible with the project Default 3.12',
              },
              include: {
                type: 'array',
                items: { type: 'string' },
                description: 'Smallest useful snapshot globs All non-secret project files when omitted',
              },
              outputs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Files to collect automatically relative to workdir For example dist/** or report.json',
              },
              workdir: { type: 'string', description: 'Relative directory inside the snapshot Default root' },
              wait: {
                type: 'boolean',
                description:
                  'Wait and collect automatically Default true Use false only when doing other useful work concurrently',
              },
              timeout_seconds: {
                type: 'integer',
                minimum: 30,
                maximum: 3600,
                description: 'Wait budget Default 900 Returns the job id if still running',
              },
            },
            required: ['command'],
            additionalProperties: false,
          },
          output: TEXT_OUTPUT,
          timeoutMs: 3_900_000,
          presentCall: (args: RunArgs) => ({
            card: 'terminal',
            title: args.command,
            ...(args.description === undefined ? {} : { description: args.description }),
          }),
          presentResult: presentCloudResult,
          execute: async (args: RunArgs, exec: ToolExec): Promise<CloudToolResult> =>
            this.operation(exec.signal, async (signal) => {
              const origin = await scope({ ...exec, signal })
              const { engine } = await this.preparedEngine(signal)
              const started = await engine.start(
                {
                  command: args.command,
                  ...origin,
                  ...(args.description === undefined ? {} : { description: args.description }),
                  ...(args.setup === undefined ? {} : { setup: args.setup }),
                  ...(args.node_version === undefined ? {} : { nodeVersion: args.node_version }),
                  ...(args.python_version === undefined ? {} : { pythonVersion: args.python_version }),
                  ...(args.include === undefined ? {} : { include: args.include }),
                  ...(args.outputs === undefined ? {} : { outputs: args.outputs }),
                  ...(args.workdir === undefined ? {} : { workdir: args.workdir }),
                },
                signal,
              )
              const intro = `Uploaded ${started.files} files (${Math.ceil(started.bytes / 1024)} KiB)`
              if (args.wait === false)
                return {
                  status: 'running',
                  jobId: started.job.id,
                  text: describeJob(started.job, intro + '\nContinue with cloud_job'),
                }
              const job = await this.waitForTask(engine, started.job.id, (args.timeout_seconds ?? 900) * 1000, signal)
              if (job.status !== 'completed')
                return {
                  status: 'running',
                  jobId: job.id,
                  text: describeJob(job, intro + '\nContinue with cloud_job until completion'),
                }
              return taskResult(await engine.collect(job.id, origin.directory, signal))
            }),
        }),
      'cloud-dev: cloud_run tool',
    )
    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'cloud_job',
          description:
            'Continue a cloud task from the current Session and workspace. By default wait and automatically collect logs and files. Use status for a nonblocking check or cancel to stop the task. Never start duplicate work while a task is pending.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Job id returned by cloud_run' },
              action: {
                type: 'string',
                enum: ['status', 'result', 'cancel'],
                description: 'Default result Wait and collect automatically',
              },
              timeout_seconds: {
                type: 'integer',
                minimum: 0,
                maximum: 3600,
                description: 'Result wait budget Default 600',
              },
            },
            required: ['id'],
            additionalProperties: false,
          },
          output: TEXT_OUTPUT,
          timeoutMs: 3_900_000,
          presentResult: presentCloudResult,
          execute: async (args: JobArgs, exec: ToolExec): Promise<CloudToolResult> =>
            this.operation(exec.signal, async (signal) => {
              const caller = await scope({ ...exec, signal })
              const engine = await this.engine(signal)
              const origin = await engine.origin(args.id, caller.owner, caller.directory, signal)
              if (args.action === 'cancel') {
                const job = await engine.cancel(args.id, signal)
                return {
                  status: job.status === 'completed' && job.conclusion === 'cancelled' ? 'cancelled' : 'running',
                  jobId: job.id,
                  text: describeJob(job, 'Cancellation requested Check status until GitHub confirms completion'),
                }
              }
              const job =
                args.action === 'status'
                  ? await engine.job(args.id, signal)
                  : await this.waitForTask(engine, args.id, (args.timeout_seconds ?? 600) * 1000, signal)
              if (args.action === 'status' || job.status !== 'completed')
                return {
                  status:
                    job.status === 'completed' ? (job.conclusion === 'success' ? 'completed' : 'failed') : 'running',
                  jobId: job.id,
                  text: describeJob(job),
                }
              return taskResult(await engine.collect(job.id, origin.directory, signal))
            }),
        }),
      'cloud-dev: cloud_job tool',
    )
  }
}
