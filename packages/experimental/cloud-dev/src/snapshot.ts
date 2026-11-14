/** Read a workspace directory into tree entries for a snapshot commit. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import picomatch from 'picomatch'

/** Directories never uploaded: dependencies, VCS data, build caches and previous results. */
const SKIPPED = new Set([
  '.git',
  '.ssh',
  '.credentials',
  'node_modules',
  '.dsh-cloud',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
])

/** Upload bounds keep snapshots within GitHub request limits. */
export const SNAPSHOT_LIMITS = { files: 2000, bytes: 40 * 1024 * 1024, fileBytes: 10 * 1024 * 1024 }

/** One file of the snapshot, relative to the snapshotted directory with forward slashes. */
export interface SnapshotFile {
  path: string
  mode: '100644' | '100755'
  bytes: Uint8Array
  /** UTF-8 text, inlined into the tree request; binary files are uploaded as blobs. */
  text?: string
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Collect the files of a directory.
 * @param root - absolute directory to snapshot.
 * @param include - optional globs; all files when empty.
 * @param signal - cancellation.
 * @param excludedRoots - application-owned data directories that never enter the snapshot.
 * @returns files sorted by path.
 */
export async function snapshot(
  root: string,
  include: readonly string[] = [],
  signal?: AbortSignal,
  excludedRoots: readonly string[] = [],
): Promise<SnapshotFile[]> {
  const excluded = new Set(excludedRoots.map(path => resolve(path)))
  if (excluded.has(resolve(root)))
    throw new Error('Choose a project directory Cloud tasks cannot upload application storage')
  const match = include.length === 0 ? undefined : picomatch([...include], { dot: true })
  const files: SnapshotFile[] = []
  let total = 0
  const walk = async (directory: string): Promise<void> => {
    signal?.throwIfAborted()
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name)
      if (excluded.has(resolve(absolute))) continue
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (
        (entry.name === '.env' || entry.name.startsWith('.env.')) &&
        !['.env.example', '.env.sample', '.env.template'].includes(entry.name)
      )
        continue
      if (/\.(?:pem|key)$/i.test(entry.name)) continue
      const path = relative(root, absolute).split(sep).join('/')
      if (match !== undefined && !match(path)) continue
      const info = await stat(absolute)
      if (info.size > SNAPSHOT_LIMITS.fileBytes)
        throw new Error(`${path} is larger than ${SNAPSHOT_LIMITS.fileBytes / 1048576} MiB`)
      total += info.size
      if (files.length >= SNAPSHOT_LIMITS.files)
        throw new Error(`The snapshot has more than ${SNAPSHOT_LIMITS.files} files Narrow it with include globs`)
      if (total > SNAPSHOT_LIMITS.bytes)
        throw new Error(
          `The snapshot is larger than ${SNAPSHOT_LIMITS.bytes / 1048576} MiB Narrow it with include globs`,
        )
      const bytes = new Uint8Array(await readFile(absolute))
      let text: string | undefined
      try {
        text = utf8.decode(bytes)
      } catch {
        text = undefined
      }
      files.push({
        path,
        mode: (info.mode & 0o111) === 0 ? '100644' : '100755',
        bytes,
        ...(text === undefined ? {} : { text }),
      })
    }
  }
  await walk(root)
  return files
}
