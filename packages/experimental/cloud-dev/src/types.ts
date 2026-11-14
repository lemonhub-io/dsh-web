/** Browser-safe shapes shared by the cloud development host service and its panel. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Where jobs go: the gateway in front of GitHub and the repository whose Actions run them. */
export interface CloudDevSettings {
  /** Base URL of the stateless gateway Worker, without a trailing slash. */
  gatewayUrl: string
  /** Runner repository as owner/name. */
  repository: string
  /** Workflow file name inside .github/workflows. */
  workflow: string
}

/** Readiness of each link in the chain, checked live without storing anything. */
export interface CloudDevStatus {
  settings: CloudDevSettings
  /** Whether a GitHub token is stored in the credential store. */
  tokenPresent: boolean
  gateway: 'unset' | 'ok' | 'unreachable'
  repository: 'unset' | 'ok' | 'missing' | 'unauthorized' | 'unknown'
  workflow: 'unknown' | 'installed' | 'missing'
  /** Directory snapshotted by panel runs when none is given. */
  defaultDirectory: string
  /** Credential reference holding the GitHub token. */
  tokenRef: string
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
}

/** A request to snapshot a directory and run a command on GitHub Actions. */
export interface CloudRunRequest {
  /** Shell command run inside the snapshot. */
  command: string
  /** Absolute directory to snapshot; the panel uses the default directory when omitted. */
  directory?: string
  /** Globs selecting files to upload, relative to the directory; everything when omitted. */
  include?: string[]
  /** Globs of files the run returns, relative to the working directory. */
  outputs?: string[]
  /** Working directory inside the snapshot. */
  workdir?: string
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
    /** A link in the chain refused or failed; the message is safe to show. */
    'cloudDev/failed': { message: string }
  }
}
