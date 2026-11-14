/**
 * Cloud development: the browser stays a stateless front end, a Cloudflare Worker is the stateless
 * gateway, and GitHub Actions compiles and runs workspace snapshots asynchronously. Job state lives
 * in GitHub (job branches, runs and artifacts); this plugin keeps only the three settings below and
 * a GitHub token in the credential store.
 * @module @deepseek-ai/dsh-experimental-cloud-dev
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ToolOutputDefinition, ToolExecution, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CloudEngine, checkSettings } from './engine.ts'
import { CloudDevError } from './github.ts'
import type {
  CloudDevSettings,
  CloudDevStatus,
  CloudJob,
  CloudJobResult,
  CloudRunRequest,
  CloudStartedJob,
} from './types.ts'

export type {
  CloudDevSettings,
  CloudDevStatus,
  CloudJob,
  CloudJobResult,
  CloudRunRequest,
  CloudStartedJob,
} from './types.ts'
export { RUNNER_WORKFLOW, RUNNER_WORKFLOW_PATH } from './runner-workflow.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cloud development jobs on GitHub Actions. */
    cloudDev: CloudDevService
  }
}

/** Credential reference holding the GitHub token used for the runner repository. */
export const TOKEN_REF = 'DSH_CLOUD_GITHUB_TOKEN'
const DEFAULT_SETTINGS: CloudDevSettings = {
  gatewayUrl: 'https://dsh-gw.openhub.today',
  repository: '',
  workflow: 'dsh-cloud-run.yml',
}
const LOG_TAIL = 6000

function failure(error: unknown): never {
  if (error instanceof RemoteError) throw error
  if (error instanceof DOMException && error.name === 'AbortError') throw error
  const message = error instanceof CloudDevError || error instanceof Error ? error.message : 'Cloud development failed'
  throw new RemoteError('cloudDev/failed', message, { message })
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

/** Host service: settings, readiness checks, the job lifecycle, and the agent tools. */
export default class CloudDevService extends TypertRemoteService {
  static inject = ['typert', 'credentials', 'tools', 'workingDirectory', 'systemPrompt']
  private readonly settingsFile = join(resolveDshHome(), 'cloud-dev', 'settings.json')

  private preparing: Promise<CloudPreparation> | undefined
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'cloudDev', { namespace: 'cloudDev' })
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
      const stored = JSON.parse(await readFile(this.settingsFile, 'utf8')) as Partial<CloudDevSettings>
      return {
        gatewayUrl: typeof stored.gatewayUrl === 'string' ? stored.gatewayUrl : DEFAULT_SETTINGS.gatewayUrl,
        repository: typeof stored.repository === 'string' ? stored.repository : DEFAULT_SETTINGS.repository,
        workflow:
          typeof stored.workflow === 'string' && stored.workflow !== '' ? stored.workflow : DEFAULT_SETTINGS.workflow,
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return { ...DEFAULT_SETTINGS }
      throw new CloudDevError('Cloud connection settings could not be read Reconnect through Cloud development')
    }
  }

  private async engine(): Promise<CloudEngine> {
    const settings = await this.readSettings()
    const token = await this.ctx.credentials.resolve(credentialRef(TOKEN_REF))
    if (token === undefined || token.value === '')
      throw new CloudDevError(
        'Connect GitHub once in Cloud development The AI prepares and runs compute tasks after connection',
      )
    return new CloudEngine(settings, token.value)
  }

  private async preparedEngine(signal: AbortSignal): Promise<CloudPreparation> {
    if (this.preparing !== undefined) return await this.preparing
    const preparation = (async () => {
      const settings = await this.readSettings()
      const token = await this.ctx.credentials.resolve(credentialRef(TOKEN_REF))
      if (token === undefined || token.value === '')
        throw new CloudDevError('Connect GitHub once in Cloud development Do not provide the token in chat')
      const engine = await CloudEngine.prepare(settings, token.value, signal)
      const change = await engine.installWorkflow(signal)
      await mkdir(dirname(this.settingsFile), { recursive: true })
      await writeFileAtomic(this.settingsFile, JSON.stringify(engine.settings, null, 2) + '\n', { mode: 0o600 })
      return { engine, change }
    })()
    this.preparing = preparation
    try {
      return await preparation
    } finally {
      this.preparing = undefined
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
   * Read the settings and check every link of the chain live.
   * @param signal - query cancellation.
   * @returns readiness of the gateway, repository and workflow.
   */
  @Remote
  async status(signal: AbortSignal): Promise<CloudDevStatus> {
    return this.operation(signal, active => this.readStatus(active))
  }

  private async readStatus(signal: AbortSignal): Promise<CloudDevStatus> {
    const settings = await this.readSettings()
    const token = await this.ctx.credentials.resolve(credentialRef(TOKEN_REF))
    const status: CloudDevStatus = {
      settings,
      tokenPresent: token !== undefined && token.value !== '',
      gateway: 'unset',
      repository: 'unset',
      workflow: 'unknown',
      defaultDirectory: this.defaultDirectory(),
      tokenRef: TOKEN_REF,
    }
    if (settings.gatewayUrl === '') return status
    try {
      const response = await fetch(settings.gatewayUrl.replace(/\/+$/, '') + '/health', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      })
      const body = (await response.json()) as { service?: string }
      status.gateway = body.service === 'dsh-cloud-gateway' ? 'ok' : 'unreachable'
    } catch (_unreachableGateway) {
      signal.throwIfAborted()
      status.gateway = 'unreachable'
    }
    if (status.gateway !== 'ok' || settings.repository === '' || !status.tokenPresent || token === undefined)
      return status
    try {
      const engine = new CloudEngine(settings, token.value)
      if (settings.repository === '') {
        await engine.github.json('user', { signal })
        return status
      }
      await engine.github.json(engine.github.repo(), { signal })
      status.repository = 'ok'
      status.workflow = (await engine.workflowInstalled(signal)) ? 'installed' : 'missing'
    } catch (error) {
      signal.throwIfAborted()
      const code = error instanceof CloudDevError ? error.status : undefined
      status.repository = code === 404 ? 'missing' : code === 401 || code === 403 ? 'unauthorized' : 'unknown'
    }
    return status
  }

  /**
   * Save the gateway URL, runner repository and workflow name.
   * @param settings - new settings; validated before they are stored.
   * @param signal - cancellation.
   */
  @Remote
  async configure(settings: CloudDevSettings, signal: AbortSignal): Promise<void> {
    return this.operation(signal, async (active) => {
      if (this.preparing !== undefined) {
        try {
          await this.preparing
        } catch (_preparationFailed) {
          /* A completed failed setup does not prevent replacing its connection settings. */
        }
      }
      active.throwIfAborted()
      const next = {
        gatewayUrl: settings.gatewayUrl.trim().replace(/\/+$/, ''),
        repository: settings.repository.trim(),
        workflow: settings.workflow.trim() || DEFAULT_SETTINGS.workflow,
      }
      try {
        checkSettings(next)
      } catch (error) {
        failure(error)
      }
      await mkdir(dirname(this.settingsFile), { recursive: true })
      await writeFileAtomic(this.settingsFile, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    })
  }

  /**
   * Install or update the runner workflow in the runner repository.
   * @param signal - cancellation.
   * @returns what changed.
   */
  @Remote
  async setup(signal: AbortSignal): Promise<'created' | 'updated' | 'unchanged'> {
    try {
      return (await this.operation(signal, active => this.preparedEngine(active))).change
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
        const engine = await this.engine()
        return await engine.github.jobs(engine.settings.workflow, active)
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
      return await this.operation(signal, async active => (await this.engine()).cancel(id, active))
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
        (await this.engine()).collect(id, directory ?? this.defaultDirectory(), active),
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
              const status = await this.readStatus(signal)
              const ready =
                status.tokenPresent &&
                status.gateway === 'ok' &&
                (status.settings.repository === '' ? status.repository === 'unset' : status.repository === 'ok')
              return {
                status: ready ? 'ready' : 'needs-connection',
                text: ready
                  ? 'Cloud compute is connected Use cloud_run to automatically prepare the private runner and execute the task'
                  : 'Connect GitHub in the Cloud development panel or check its gateway connection Never provide a token in chat',
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
              const engine = await this.engine()
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
