/**
 * Runs one command line on the just-bash interpreter over the VFS: full bash
 * grammar plus its coreutils, grep, sed, awk, jq, and curl, with the Worker's own
 * `git` added. The interpreter returns output when the line settles, so a running
 * background job shows nothing until it ends.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/shell/interpret
 */

import { Bash, getCommandNames, getNetworkCommandNames, InMemoryFs, MountableFs } from 'just-bash/browser'
import type { BashOptions } from 'just-bash/browser'
import { DEFAULT_ROOT } from '../image-layout.ts'
import { gitCommand } from './commands/git.ts'
import { hostFileSystem } from './fs-access.ts'
import type { ShellFileSystem, ShellRunOutcome } from './types.ts'
import { ShellVfsAdapter } from './vfs-adapter.ts'

/** Status a command line reports once the caller's abort signal has fired. */
const ABORTED_STATUS = 130

/** Ceiling for loop and traversal counters; the host's timeouts and SIGKILL bound a run. */
const UNBOUNDED_COUNT = 1_000_000_000

/** Ceiling for one run's time; the host's timeouts terminate the process worker first. */
const UNBOUNDED_TIME_MS = 7 * 24 * 60 * 60 * 1000

/** A missing-program line from the interpreter, including its browser-bundle variant. */
const MISSING_PROGRAM = /^bash: ([^\s:]+): command not (?:found|available in browser environments\..*)$/gm

/** Appended once when a line names a missing program, because a browser shell can never obtain one. */
export const MISSING_PROGRAM_HINT =
  'This browser shell provides only built-in file and text utilities; it cannot install or run other programs.\n'

/**
 * Restate missing-program lines in bash's own wording and add the browser limitation. The interpreter's browser
 * variant suggests excluding the command or switching bundles, which no caller of this shell can do.
 * @param stderr - The run's complete error output.
 * @returns The rewritten error output.
 */
function explainMissingPrograms(stderr: string): string {
  let missing = false
  const text = stderr.replace(MISSING_PROGRAM, (_line, name: string) => {
    missing = true
    return `bash: ${name}: command not found`
  })
  return missing ? text + MISSING_PROGRAM_HINT : text
}

/**
 * The interpreter's defaults protect a host process from untrusted scripts. A run
 * here owns a dedicated Worker the host can terminate, so its counters must not
 * stop commands a real shell would finish.
 */
const EXECUTION_LIMITS: NonNullable<BashOptions['executionLimits']> = {
  maxCommandCount: UNBOUNDED_COUNT,
  maxLoopIterations: UNBOUNDED_COUNT,
  maxAwkIterations: UNBOUNDED_COUNT,
  maxSedIterations: UNBOUNDED_COUNT,
  maxJqIterations: UNBOUNDED_COUNT,
  maxWorkUnits: UNBOUNDED_COUNT,
  maxTraversalEntries: UNBOUNDED_COUNT,
  maxTraversalWork: UNBOUNDED_COUNT,
  maxGlobOperations: UNBOUNDED_COUNT,
  maxExecutionTimeMs: UNBOUNDED_TIME_MS,
}

/** Everything one `bash -c` invocation needs. */
export interface ShellRunOptions {
  /** Working directory the line starts in. */
  cwd: string
  /** Environment the line starts with. */
  env: Record<string, string>
  /** Standard input contents; absent means empty. */
  stdin?: string | undefined
  /** Cancellation: an aborted line stops before its next command. */
  signal?: AbortSignal | undefined
  /** The filesystem this run acts on; defaults to the VFS mounted in this thread. */
  fs?: ShellFileSystem | undefined
  /** Called with the output once the line settles. */
  onOutput?: ((stream: 'stdout' | 'stderr', text: string) => void) | undefined
}

let commandNames: ReadonlySet<string> | undefined

/**
 * Whether a program name can run without a shell line, as `spawn` must decide before starting a process.
 * @param name - Program name, without a path.
 * @returns true for every interpreter command and `git`.
 */
export function isShellCommand(name: string): boolean {
  commandNames ??= new Set([...getCommandNames(), ...getNetworkCommandNames(), gitCommand.name])
  return commandNames.has(name)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Turn binary-marked interpreter output into the text the process protocol carries. */
function textOf(output: string, bytes: boolean): string {
  return bytes ? new TextDecoder().decode(Uint8Array.from(output, character => character.charCodeAt(0) & 0xff)) : output
}

/**
 * Run one shell source line.
 * @param source - The command line.
 * @param options - Directory, environment, input, and filesystem.
 * @returns Exit status and complete output.
 */
export async function runShellCommand(source: string, options: ShellRunOptions): Promise<ShellRunOutcome> {
  if (isAborted(options.signal)) return { exitCode: ABORTED_STATUS, stdout: '', stderr: '' }
  const fs = options.fs ?? hostFileSystem()
  const inherited = (options.env.PATH ?? '').split(':').filter(entry => entry !== '' && entry !== '/usr/bin' && entry !== '/bin')
  const env = { ...options.env, PATH: ['/usr/bin', '/bin', ...inherited].join(':') }
  const bash = new Bash({
    fs: new MountableFs({
      // The base holds the interpreter's /bin stubs; only the mounts reach the VFS.
      base: new InMemoryFs(),
      mounts: [
        { mountPoint: DEFAULT_ROOT, filesystem: new ShellVfsAdapter(fs, DEFAULT_ROOT) },
        { mountPoint: '/tmp', filesystem: new ShellVfsAdapter(fs, `${DEFAULT_ROOT}/tmp`) },
      ],
    }),
    cwd: options.cwd,
    env,
    customCommands: [gitCommand],
    executionLimits: EXECUTION_LIMITS,
    network: { dangerouslyAllowFullInternetAccess: true },
    defenseInDepth: false,
  })
  let result: Awaited<ReturnType<Bash['exec']>>
  try {
    result = await bash.exec(source, {
      ...options.stdin === undefined ? {} : { stdin: options.stdin },
      ...options.signal === undefined ? {} : { signal: options.signal },
      rawScript: true,
    })
  } catch (error) {
    // The interpreter lets some redirection failures escape, which ends the whole line.
    if (typeof (error as { code?: unknown }).code !== 'string') throw error
    const stderr = `bash: ${(error as Error).message}\n`
    options.onOutput?.('stderr', stderr)
    return { exitCode: 1, stdout: '', stderr }
  }
  const stdout = textOf(result.stdout, result.stdoutKind === 'bytes')
  const stderr = explainMissingPrograms(result.stderr)
  if (stdout !== '') options.onOutput?.('stdout', stdout)
  if (stderr !== '') options.onOutput?.('stderr', stderr)
  return { exitCode: isAborted(options.signal) ? ABORTED_STATUS : result.exitCode, stdout, stderr, env: result.env }
}

/**
 * Run one program without a shell line. Arguments are quoted, so they reach the program verbatim.
 * @param argv - Program name and its arguments.
 * @param options - Directory, environment, input, and filesystem.
 * @returns Exit status and complete output.
 */
export async function runShellProgram(argv: readonly string[], options: ShellRunOptions): Promise<ShellRunOutcome> {
  const quoted = argv.map(argument => `'${argument.replaceAll('\'', '\'\\\'\'')}'`).join(' ')
  return await runShellCommand(quoted, options)
}
