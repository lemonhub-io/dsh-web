/** Browser-safe shapes shared by the cloud development host service and its panel. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** The person's only connection choice; the gateway and workflow belong to the deployment. */
export interface CloudDevSettings {
  /** Runner repository as owner/name; empty selects the token owner's private `dsh-cloud-runner`. */
  repository: string
}

/** What blocks the next cloud task, or `none` when the AI can run one. */
export type CloudDevProblem =
  /** No GitHub token is stored. */
  | 'token-missing'
  /** GitHub rejected the stored token. */
  | 'token-invalid'
  /** A classic token lacks the `repo` or `workflow` scope. */
  | 'token-scopes'
  /** The download gateway did not answer its health check. */
  | 'gateway'
  /** The chosen runner repository does not exist for this token. */
  | 'runner-missing'
  /** The token cannot read the chosen runner repository or write its workflow. */
  | 'runner-denied'
  /** GitHub could not be reached or answered unexpectedly. */
  | 'unknown'
  | 'none'

/** Readiness checked live; nothing here is stored. */
export interface CloudDevStatus {
  settings: CloudDevSettings
  problem: CloudDevProblem
  /** GitHub account that owns the token, once GitHub accepted it. */
  account: string | null
  /** Runner repository tasks use, as owner/name, once known. */
  runner: string | null
  /** Default directory for authenticated Remote requests AI tools use the Session directory. */
  defaultDirectory: string
  /** Credential reference holding the GitHub token. */
  tokenRef: string
}

/** The panel's one-step connection. Nothing is stored unless GitHub accepts the token and the runner is ready. */
export interface CloudConnectRequest {
  /** New GitHub token; omitted or blank keeps the stored token. */
  token?: string
  /** Runner choice as owner/name or a GitHub repository link; empty selects the automatic private runner. */
  repository: string
}

/** One job as GitHub reports it; the branch dsh-cloud/<id> identifies it. */
export interface CloudJob {
  id: string
  /** First line of the snapshot commit message: the command. */
  command: string
  status: 'pending' | 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested'
  conclusion: string | null
  runId: number | null
  url: string | null
  createdAt: string
  updatedAt: string
  /** Immutable snapshot commit used to recover the task's workspace and Session ownership. */
  snapshotCommit?: string
}

/** A request to snapshot a directory and run a command on GitHub Actions. */
export interface CloudRunRequest {
  /** Shell command run inside the snapshot. */
  command: string
  /** Short description of the computing task shown in the conversation. */
  description?: string
  /** Dependency or environment preparation executed before the command. */
  setup?: string
  /** Node version installed by the runner Defaults to 24. */
  nodeVersion?: string
  /** Python version installed by the runner Defaults to 3.12. */
  pythonVersion?: string
  /** Absolute directory to snapshot Remote calls use the host default when omitted. */
  directory?: string
  /** Globs selecting files to upload, relative to the directory; everything when omitted. */
  include?: string[]
  /** Globs of files the run returns, relative to the working directory. */
  outputs?: string[]
  /** Working directory inside the snapshot. */
  workdir?: string
}

/** Immutable origin recorded with a cloud snapshot Tools enforce it before accessing results or cancelling work. */
export interface CloudTaskOrigin {
  directory: string
  owner: string | null
}

/** What a finished job brought back into the workspace. */
export interface CloudJobResult {
  job: CloudJob
  exitCode: number | null
  durationSeconds: number | null
  /** Complete command output. */
  log: string
  /** Directory the result was written to. */
  directory: string
  /** Returned files, relative to directory/files. */
  files: string[]
}

/** Snapshot size of a started job. */
export interface CloudStartedJob {
  job: CloudJob
  files: number
  bytes: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A link in the chain refused or failed; the message is safe to show and `problem` names a known cause. */
    'cloudDev/failed': { message: string; problem?: CloudDevProblem }
  }
}
