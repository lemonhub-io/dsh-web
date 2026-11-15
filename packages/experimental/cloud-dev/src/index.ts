/**
 * Cloud development: the browser stays a stateless front end, a Cloudflare Worker is the stateless
 * gateway, and GitHub Actions compiles and runs workspace snapshots asynchronously. Job state lives
 * in GitHub (job branches, runs and artifacts); this plugin keeps the person's runner and visibility choices and
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
import { BROWSER_ENVIRONMENT, cloudGuidance, type CloudWorkspace } from './prompt.ts'
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
  CloudRepositoryVisibility,
  CloudRunRequest,
  CloudStartedJob,
} from './types.ts'
export { RUNNER_WORKFLOW, RUNNER_WORKFLOW_FILE, RUNNER_WORKFLOW_PATH } from './runner-workflow.ts'
export { parseRepository } from './github.ts'
export { BROWSER_ENVIRONMENT, cloudGuidance, type CloudWorkspace } from './prompt.ts'

/** Deployment configuration The panel supplies runner and visibility choices. */
export const Config = z
  .object({
    /** Base URL of the stateless gateway Worker that serves artifact and log downloads. */
    gatewayUrl: z.url({ protocol: /^https?$/ }).default('https://dsh-gw.openhub.today'),
    /**
     * Where Session workspaces live. `browser` (DSH Web) has no local program execution, so the model is told
     * to run all code with cloud_run; `local` keeps the host shell and offers the cloud runner beside it.
     */
    workspace: z.enum(['local', 'browser']).default('local'),
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
  'none': 'Cloud execution is ready.',
  'token-missing': 'GitHub is not connected. Ask the user to connect GitHub once in Cloud development.',
  'token-invalid': 'GitHub rejected the saved token. Ask the user to reconnect GitHub in Cloud development.',
  'token-scopes': 'The saved GitHub token lacks the repo or workflow scope. Ask the user to reconnect GitHub in Cloud development.',
  'gateway': 'The cloud result gateway is unreachable. Check again later with cloud_status.',
  'runner-missing': 'The configured runner repository does not exist. Ask the user to correct it in Cloud development.',
  'runner-denied': 'The saved token cannot use the configured runner repository. Ask the user to correct it in Cloud development.',
  'visibility-denied': 'GitHub refused the repository visibility change Check repository administration access and organization policy',
  'visibility-unknown': 'The visibility change outcome is unconfirmed Save the connection again to verify GitHub visibility',
  'unknown': 'GitHub could not be reached. Check again later with cloud_status.',
}

function failure(error: unknown): never {
  if (error instanceof RemoteError) throw error
  if (error instanceof DOMException && error.name === 'AbortError') throw error
  const message = error instanceof Error ? error.message : 'Cloud development failed'
  const problem = error instanceof CloudDevError ? error.problem : undefined
  throw new RemoteError('cloudDev/failed', message, { message, ...(problem === undefined ? {} : { problem }) })
}

function describeResult(result: CloudJobResult): string {
  const truncated = result.log.length > LOG_TAIL
  const log = truncated ? '…' + result.log.slice(-LOG_TAIL) : result.log
  return [
    `Job ${result.job.id} ${result.job.conclusion ?? result.job.status} exit code ${result.exitCode ?? 'unknown'}${result.durationSeconds === null ? '' : ` in ${result.durationSeconds}s`}`,
    result.job.url === null ? '' : `Run: ${result.job.url}`,
    `Results: ${result.directory}`,
    result.files.length === 0 ? 'Returned files: none' : `Returned files (under files/): ${result.files.join(', ')}`,
    truncated ? `--- last ${LOG_TAIL} characters of output (full log: ${result.directory}/output.log)` : '--- output',
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
  problem?: CloudDevProblem
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
      problem: {
        type: 'string',
        enum: ['none', 'token-missing', 'token-invalid', 'token-scopes', 'gateway', 'runner-missing', 'runner-denied', 'visibility-denied', 'visibility-unknown', 'unknown'],
      },
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
    const workspace: CloudWorkspace = config.workspace
    if (workspace === 'browser')
      ctx.systemPrompt.context({
        name: 'cloud-development:browser-environment',
        order: ctx.systemPrompt.getContextOrder('WEB_SURFACE') + 1,
        required: true,
        text: BROWSER_ENVIRONMENT,
      })
    ctx.systemPrompt.section({
      name: 'cloud-development',
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
      text: cloudGuidance(workspace),
    })
    this.registerTools()
  }

  private async readSettings(): Promise<CloudDevSettings> {
    try {
      const stored = JSON.parse(await readFile(this.settingsFile, 'utf8')) as { repository?: unknown; visibility?: unknown }
      if (stored.visibility !== undefined && stored.visibility !== 'private' && stored.visibility !== 'public')
        throw new CloudDevError('Invalid runner creation visibility Reconnect through Cloud development')
      return {
        repository: typeof stored.repository === 'string' ? parseRepository(stored.repository) : '',
        visibility: stored.visibility ?? 'private',
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return { repository: '', visibility: 'private' }
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
      throw new CloudDevError(PROBLEM_TEXT['token-missing'], undefined, 'token-missing')
    return new CloudEngine(this.gateway, await this.runner(settings, token, signal), token)
  }

  private async prepare(settings: CloudDevSettings, token: string, signal: AbortSignal): Promise<CloudPreparation> {
    const engine = await CloudEngine.prepare(this.gateway, settings.repository, token, signal, settings.visibility)
    return { engine, change: await engine.installWorkflow(signal) }
  }

  private async preparedEngine(signal: AbortSignal): Promise<CloudPreparation> {
    if (this.preparing !== undefined) return await this.preparing
    const preparation = (async () => {
      const settings = await this.readSettings()
      const token = await this.storedToken()
      if (token === undefined)
        throw new CloudDevError(PROBLEM_TEXT['token-missing'], undefined, 'token-missing')
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
            `Cancellation of job ${id} is unconfirmed. Check it with cloud_job before rerunning.${cancelError instanceof Error ? ' ' + cancelError.message : ''}`,
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
      visibility: null,
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
      const repository = await engine.github.json<{ private: boolean }>(engine.github.repo(), { signal })
      status.visibility = repository.private ? 'private' : 'public'
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
   * Verify the connection, prepare the workflow and apply an explicit visibility choice before saving credentials and settings.
   * A GitHub visibility update can commit before a later failure Repeating a save reads the current value first.
   * @param request - optional new token, runner choice and optional visibility update.
   * @param signal - cancellation.
   * @returns readiness after the connection.
   */
  @Remote
  async connect(request: CloudConnectRequest, signal: AbortSignal): Promise<CloudDevStatus> {
    try {
      return await this.operation(signal, async (active) => {
        await this.settled()
        active.throwIfAborted()
        const settings: CloudDevSettings = {
          repository: parseRepository(request.repository),
          visibility: request.visibility ?? 'private',
        }
        const supplied = request.token?.trim() ?? ''
        if (/\s/.test(supplied))
          throw new CloudDevError('The GitHub token cannot contain spaces', undefined, 'token-invalid')
        const token = supplied === '' ? await this.storedToken() : supplied
        if (token === undefined) throw new CloudDevError('Paste a GitHub token first', undefined, 'token-missing')
        const { engine } = await this.prepare(settings, token, active)
        if (request.visibility !== undefined) await engine.setVisibility(request.visibility, active)
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
      if (exec.agent === undefined) throw new CloudDevError('Cloud execution needs an active Session.')
      return { directory: await ctx.workingDirectory.ensure(exec.agent, exec.signal), owner: exec.agent.session.id }
    }
    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'cloud_status',
          description:
            'Report whether cloud execution is ready, without starting a job. When it is not, the result names the cause and the next step. cloud_run prepares the runner itself, so use this only to diagnose access.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: TEXT_OUTPUT,
          execute: async (_args: object, exec: ToolExec): Promise<CloudToolResult> =>
            this.operation(exec.signal, async (signal) => {
              const { problem } = await this.readStatus(signal)
              const unavailable = problem === 'gateway' || problem === 'unknown'
              return {
                status: problem === 'none' ? 'ready' : unavailable ? 'failed' : 'needs-connection',
                problem,
                text: PROBLEM_TEXT[problem],
              }
            }),
        }),
      'cloud-dev: cloud_status tool',
    )
    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'cloud_run',
          description:
            'Run a Bash task on a fresh GitHub-hosted Ubuntu runner with a snapshot of the current workspace, then return the exit code, the end of the output and the files matched by outputs. The full log and returned files are saved under .dsh-cloud/<job id> in the workspace, which later snapshots leave out. Every job starts clean: nothing from earlier jobs carries over, so install dependencies in setup each time. The runner has the standard GitHub Ubuntu toolset (Git, GCC, Clang, CMake, Go, Rust, Java, Docker and more) plus the requested Node.js and Python, and a job stops after 60 minutes. The snapshot has no Git history and leaves out .git, dependency and cache directories (node_modules, .venv, venv, __pycache__, .next, .turbo, .cache), .env files and .pem or .key files.',
          parameters: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'Short purpose shown to the user, such as "Run unit tests".',
              },
              command: {
                type: 'string',
                description:
                  'Bash script for the task, run in workdir after setup in the same shell. Use paths relative to workdir; workspace paths from local tools do not exist on the runner. A failing command, including one inside a pipeline, ends the job with its exit code.',
              },
              setup: {
                type: 'string',
                description:
                  'Bash script run before command in the same shell, such as dependency installation. Its directory changes, exports and PATH changes carry into command.',
              },
              node_version: { type: 'string', description: 'Node.js version to install, such as 22. Defaults to 24.' },
              python_version: {
                type: 'string',
                description: 'Python version to install, such as 3.11. Defaults to 3.12.',
              },
              include: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Workspace-relative globs selecting the files to upload, such as ["src/**", "package.json"]. Defaults to all eligible files. An upload is limited to 2000 files and 40 MiB, with 10 MiB per file.',
              },
              outputs: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Globs relative to workdir for files to return, such as ["dist/**", "report.json"]. Defaults to none; the log is always returned.',
              },
              workdir: {
                type: 'string',
                description: 'Snapshot-relative directory where setup and command start. Defaults to the workspace root.',
              },
              wait: {
                type: 'boolean',
                description:
                  'Whether to wait for the job and collect its result. Defaults to true; set false only to keep working while the job runs.',
              },
              timeout_seconds: {
                type: 'integer',
                minimum: 30,
                maximum: 3600,
                description: 'How long to wait before returning a job that is still running; the job keeps running. Defaults to 900.',
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
              const intro = `Uploaded ${started.files} files (${Math.ceil(started.bytes / 1024)} KiB).`
              if (args.wait === false)
                return {
                  status: 'running',
                  jobId: started.job.id,
                  text: describeJob(started.job, intro + '\nCollect the result with cloud_job.'),
                }
              const job = await this.waitForTask(engine, started.job.id, (args.timeout_seconds ?? 900) * 1000, signal)
              if (job.status !== 'completed')
                return {
                  status: 'running',
                  jobId: job.id,
                  text: describeJob(job, intro + '\nThe job has not finished. Continue with cloud_job.'),
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
            'Follow a job that cloud_run started in this Session: wait for and collect its result, check its status, or cancel it.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Job id from cloud_run.' },
              action: {
                type: 'string',
                enum: ['status', 'result', 'cancel'],
                description: 'result (default) waits, then collects the log and returned files; status returns at once; cancel stops the job.',
              },
              timeout_seconds: {
                type: 'integer',
                minimum: 0,
                maximum: 3600,
                description: 'How long result waits before returning a job that is still running. Defaults to 600.',
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
                  text: describeJob(job, 'Cancellation requested. Check with cloud_job until the job reports cancelled.'),
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
