/**
 * Cloud development: the browser stays a stateless front end, a Cloudflare Worker is the stateless
 * gateway, and GitHub Actions compiles and runs workspace snapshots asynchronously. Job state lives
 * in GitHub (job branches, runs and artifacts); this plugin keeps only the three settings below and
 * a GitHub token in the credential store.
 * @module @deepseek-ai/dsh-experimental-cloud-dev
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ToolOutputDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-working-directory'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CloudEngine, checkSettings } from './engine.ts'
import { CloudDevError } from './github.ts'
import type { CloudDevSettings, CloudDevStatus, CloudJob, CloudJobResult, CloudRunRequest, CloudStartedJob } from './types.ts'

export type { CloudDevSettings, CloudDevStatus, CloudJob, CloudJobResult, CloudRunRequest, CloudStartedJob } from './types.ts'
export { RUNNER_WORKFLOW, RUNNER_WORKFLOW_PATH } from './runner-workflow.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cloud development jobs on GitHub Actions. */
    cloudDev: CloudDevService
  }
}

/** Credential reference holding the GitHub token used for the runner repository. */
export const TOKEN_REF = 'DSH_CLOUD_GITHUB_TOKEN'
const DEFAULT_SETTINGS: CloudDevSettings = { gatewayUrl: '', repository: '', workflow: 'dsh-cloud-run.yml' }
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
  ].filter(line => line !== '').join('\n')
}

function describeJob(job: CloudJob, note = ''): string {
  return [`Job ${job.id} ${job.status}${job.conclusion === null ? '' : ' ' + job.conclusion}`, job.url ?? '', note].filter(Boolean).join('\n')
}

interface ToolExec { agent?: unknown; signal: AbortSignal }
interface RunArgs { command: string; include?: string[]; outputs?: string[]; workdir?: string; wait?: boolean; timeout_seconds?: number }
interface JobArgs { id: string; action?: 'status' | 'result' | 'cancel'; timeout_seconds?: number }

const TEXT_OUTPUT: ToolOutputDefinition = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
}

/** Host service: settings, readiness checks, the job lifecycle, and the agent tools. */
export default class CloudDevService extends TypertRemoteService {
  static inject = ['typert', 'credentials', 'tools', 'workingDirectory']
  private readonly settingsFile = join(resolveDshHome(), 'cloud-dev', 'settings.json')

  constructor(ctx: Context) {
    super(ctx, 'cloudDev', { namespace: 'cloudDev' })
    this.registerTools()
  }

  private async readSettings(): Promise<CloudDevSettings> {
    try {
      const stored = JSON.parse(await readFile(this.settingsFile, 'utf8')) as Partial<CloudDevSettings>
      return {
        gatewayUrl: typeof stored.gatewayUrl === 'string' ? stored.gatewayUrl : DEFAULT_SETTINGS.gatewayUrl,
        repository: typeof stored.repository === 'string' ? stored.repository : DEFAULT_SETTINGS.repository,
        workflow: typeof stored.workflow === 'string' && stored.workflow !== '' ? stored.workflow : DEFAULT_SETTINGS.workflow,
      }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  private async engine(): Promise<CloudEngine> {
    const settings = await this.readSettings()
    const token = await this.ctx.credentials.resolve(credentialRef(TOKEN_REF))
    if (token === undefined || token.value === '') throw new CloudDevError('Add a GitHub token first')
    return new CloudEngine(settings, token.value)
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
    const settings = await this.readSettings()
    const token = await this.ctx.credentials.resolve(credentialRef(TOKEN_REF))
    const status: CloudDevStatus = {
      settings, tokenPresent: token !== undefined && token.value !== '', gateway: 'unset', repository: 'unset',
      workflow: 'unknown', defaultDirectory: this.defaultDirectory(), tokenRef: TOKEN_REF,
    }
    if (settings.gatewayUrl === '') return status
    try {
      const response = await fetch(settings.gatewayUrl.replace(/\/+$/, '') + '/health', { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
      const body = await response.json() as { service?: string }
      status.gateway = body.service === 'dsh-cloud-gateway' ? 'ok' : 'unreachable'
    } catch {
      status.gateway = 'unreachable'
    }
    if (status.gateway !== 'ok' || settings.repository === '' || !status.tokenPresent || token === undefined) return status
    try {
      const engine = new CloudEngine(settings, token.value)
      await engine.github.json(engine.github.repo(), { signal })
      status.repository = 'ok'
      status.workflow = await engine.workflowInstalled(signal) ? 'installed' : 'missing'
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
    signal.throwIfAborted()
    const next = { gatewayUrl: settings.gatewayUrl.trim().replace(/\/+$/, ''), repository: settings.repository.trim(), workflow: settings.workflow.trim() || DEFAULT_SETTINGS.workflow }
    try { checkSettings(next) } catch (error) { failure(error) }
    await mkdir(dirname(this.settingsFile), { recursive: true })
    await writeFile(this.settingsFile, JSON.stringify(next, null, 2) + '\n')
  }

  /**
   * Install or update the runner workflow in the runner repository.
   * @param signal - cancellation.
   * @returns what changed.
   */
  @Remote
  async setup(signal: AbortSignal): Promise<'created' | 'updated' | 'unchanged'> {
    try { return await (await this.engine()).installWorkflow(signal) } catch (error) { failure(error) }
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
      return await (await this.engine()).start({ ...request, directory: request.directory ?? this.defaultDirectory() }, signal)
    } catch (error) { failure(error) }
  }

  /**
   * Recent jobs, newest first, read from GitHub.
   * @param signal - cancellation.
   * @returns jobs started by this plugin.
   */
  @Remote
  async jobs(signal: AbortSignal): Promise<CloudJob[]> {
    try {
      const engine = await this.engine()
      return await engine.github.jobs(engine.settings.workflow, signal)
    } catch (error) { failure(error) }
  }

  /**
   * Cancel a job.
   * @param id - job id.
   * @param signal - cancellation.
   * @returns the job after the request.
   */
  @Remote
  async cancel(id: string, signal: AbortSignal): Promise<CloudJob> {
    try { return await (await this.engine()).cancel(id, signal) } catch (error) { failure(error) }
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
    try { return await (await this.engine()).collect(id, directory ?? this.defaultDirectory(), signal) } catch (error) { failure(error) }
  }

  private registerTools(): void {
    const ctx = this.ctx
    const cwd = async (exec: { agent?: unknown; signal: AbortSignal }): Promise<string> => exec.agent === undefined
      ? this.defaultDirectory()
      : await ctx.workingDirectory.ensure(exec.agent as Parameters<typeof ctx.workingDirectory.ensure>[0], exec.signal)
    ctx.effect(() => ctx.tools.register({
      name: 'cloud_run',
      description: 'Run a shell command on GitHub Actions against a snapshot of the current working directory, through the cloud development gateway. '
        + 'Use it for builds, test suites and other heavy or long work that should not run in this environment. '
        + 'The runner is ubuntu-latest with common toolchains (gcc, make, node, python, go, java, docker). '
        + 'node_modules, .git and virtual environments are not uploaded, so install dependencies in the command. '
        + 'With wait (default) the call returns the exit code, output and returned files, written to .dsh-cloud/<job>/; otherwise it returns a job id for cloud_job.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command run from the working directory inside the snapshot' },
          include: { type: 'array', items: { type: 'string' }, description: 'Globs selecting files to upload; all files when omitted' },
          outputs: { type: 'array', items: { type: 'string' }, description: 'Globs of files to bring back, relative to workdir, such as dist/** or report.xml' },
          workdir: { type: 'string', description: 'Directory inside the snapshot to run in; defaults to the snapshot root' },
          wait: { type: 'boolean', description: 'Wait for the job to finish (default true)' },
          timeout_seconds: { type: 'integer', minimum: 30, maximum: 3600, description: 'How long to wait before returning the job id (default 900)' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      timeoutMs: 3_900_000,
      execute: async (args: RunArgs, exec: ToolExec) => {
        const engine = await this.engine()
        const directory = await cwd(exec)
        const started = await engine.start({
          command: args.command, directory,
          ...args.include === undefined ? {} : { include: args.include },
          ...args.outputs === undefined ? {} : { outputs: args.outputs },
          ...args.workdir === undefined ? {} : { workdir: args.workdir },
        }, exec.signal)
        const intro = `Uploaded ${started.files} files (${Math.ceil(started.bytes / 1024)} KiB)`
        if (args.wait === false) return { text: describeJob(started.job, `${intro}\nCheck it with cloud_job`) }
        const job = await engine.wait(started.job.id, (args.timeout_seconds ?? 900) * 1000, exec.signal)
        if (job.status !== 'completed') return { text: describeJob(job, `${intro}\nStill running Check it later with cloud_job`) }
        return { text: intro + '\n' + describeResult(await engine.collect(job.id, directory, exec.signal)) }
      },
    }), 'cloud-dev: cloud_run tool')
    ctx.effect(() => ctx.tools.register({
      name: 'cloud_job',
      description: 'Check, collect or cancel a cloud development job started by cloud_run. '
        + 'status reports progress; result waits up to timeout_seconds, then writes the log and returned files to .dsh-cloud/<job>/; cancel stops it.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job id from cloud_run' },
          action: { type: 'string', enum: ['status', 'result', 'cancel'], description: 'What to do (default status)' },
          timeout_seconds: { type: 'integer', minimum: 0, maximum: 3600, description: 'For result: how long to wait for completion (default 600)' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      timeoutMs: 3_900_000,
      execute: async (args: JobArgs, exec: ToolExec) => {
        const engine = await this.engine()
        if (args.action === 'cancel') return { text: describeJob(await engine.cancel(args.id, exec.signal)) }
        if (args.action !== 'result') return { text: describeJob(await engine.job(args.id, exec.signal)) }
        const job = await engine.wait(args.id, (args.timeout_seconds ?? 600) * 1000, exec.signal)
        if (job.status !== 'completed') return { text: describeJob(job, 'Still running') }
        return { text: describeResult(await engine.collect(job.id, await cwd(exec), exec.signal)) }
      },
    }), 'cloud-dev: cloud_job tool')
  }
}
