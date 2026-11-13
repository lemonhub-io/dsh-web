/** GitHub discovery and immutable source downloads for ordinary Cordis packages. */
import picomatch from 'picomatch'
import { packTar } from 'modern-tar'
import type { WebPackageLimits } from '@deepseek-ai/dsh-plugin-manager/types'
import { CommunitySourceError, downloadCommunityBytes } from './community-download.ts'

/** Public repository and optional package-directory selection. */
export interface GitHubRepository {
  name: string
  description: string
  branch: string
  directory: string
}
interface GitHubFile {
  path: string
  sha: string
  size: number
  mode: string
}
/** Package metadata and immutable Git blob identities selected from one commit. */
export interface GitHubPackage {
  repository: string
  commit: string
  directory: string
  name: string
  version: string
  description: string
  files: GitHubFile[]
}
const segment = /^[A-Za-z0-9_.@+-]+$/
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CommunitySourceError('invalid')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new CommunitySourceError('invalid')
  return value
}
async function json(path: string, signal: AbortSignal, limit = 1024 * 1024): Promise<unknown> {
  const bytes = await downloadCommunityBytes(
    'https://api.github.com/' + path,
    limit,
    signal,
    'application/vnd.github+json',
  )
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (_invalidJson) {
    throw new CommunitySourceError('invalid')
  }
}
function repository(value: unknown): GitHubRepository {
  const item = object(value)
  const name = text(item.full_name)
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new CommunitySourceError('invalid')
  return {
    name,
    description: typeof item.description === 'string' ? item.description : '',
    branch: text(item.default_branch),
    directory: '',
  }
}

/** Find tagged repositories or resolve an explicit owner/repository or GitHub tree URL.
 * @param query Search terms or public repository address.
 * @param signal Caller-owned cancellation and deadline.
 * @returns Up to 24 repositories No credentials or code-search authentication is required.
 */
export async function discoverGitHub(query: string, signal: AbortSignal): Promise<GitHubRepository[]> {
  let target = query
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\/$/, '')
  const direct = /^[\w.-]+\/[\w.-]+(?:\/tree\/[^/]+(?:\/.*)?)?$/.test(target)
  if (direct) {
    const [owner, rawName, , branch, ...directory] = target.split('/')
    const item = repository(await json(`repos/${owner}/${rawName?.replace(/\.git$/, '')}`, signal))
    const path = directory.map(decodeURIComponent)
    if (path.some(part => !segment.test(part) || part === '.' || part === '..'))
      throw new CommunitySourceError('invalid')
    return [
      {
        ...item,
        branch: branch === undefined ? item.branch : decodeURIComponent(branch),
        directory: path.join('/'),
      },
    ]
  }
  target = query.trim()
  const search = new URLSearchParams({
    q: `${target} topic:dsh-plugin archived:false`,
    per_page: '24',
    sort: 'updated',
  })
  const result = object(await json('search/repositories?' + search.toString(), signal))
  if (!Array.isArray(result.items) || result.items.length > 24) throw new CommunitySourceError('invalid')
  return result.items.map(repository)
}

async function blob(repo: string, file: GitHubFile, signal: AbortSignal): Promise<Uint8Array> {
  const bytes = await downloadCommunityBytes(
    `https://api.github.com/repos/${repo}/git/blobs/${file.sha}`,
    file.size,
    signal,
    'application/vnd.github.raw+json',
  )
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const payload = new Uint8Array(prefix.length + bytes.length)
  payload.set(prefix)
  payload.set(bytes, prefix.length)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', payload))
  if (bytes.length !== file.size || [...hash].map(b => b.toString(16).padStart(2, '0')).join('') !== file.sha) {
    throw new CommunitySourceError('invalid')
  }
  return bytes
}

/** Read package manifests from a single commit without evaluating repository code.
 * @param repo Repository selected by discovery.
 * @param signal Caller-owned cancellation and deadline.
 * @returns Ordinary bundle packages with npm files selection and pinned blob identities.
 */
export async function githubPackages(repo: GitHubRepository, signal: AbortSignal): Promise<GitHubPackage[]> {
  const commit = object(await json(`repos/${repo.name}/commits/${encodeURIComponent(repo.branch)}`, signal))
  const sha = text(commit.sha)
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new CommunitySourceError('invalid')
  const treeId = text(object(object(commit.commit).tree).sha)
  if (!/^[a-f0-9]{40}$/.test(treeId)) throw new CommunitySourceError('invalid')
  const tree = object(await json(`repos/${repo.name}/git/trees/${treeId}?recursive=1`, signal, 4 * 1024 * 1024))
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new CommunitySourceError('size')
  const files: GitHubFile[] = []
  for (const raw of tree.tree) {
    const entry = object(raw)
    if (entry.type !== 'blob') continue
    const path = text(entry.path),
      hash = text(entry.sha),
      mode = text(entry.mode)
    if (
      !/^[a-f0-9]{40}$/.test(hash) ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new CommunitySourceError('invalid')
    }
    files.push({ path, sha: hash, mode, size: entry.size })
  }
  const prefix = repo.directory === '' ? '' : repo.directory + '/'
  const manifests = files.filter(
    file =>
      file.path.startsWith(prefix) &&
      /(?:^|\/)package\.json$/.test(file.path) &&
      !file.path.split('/').some(part => part === 'node_modules' || part.startsWith('.')),
  )
  if (manifests.length > 24) throw new CommunitySourceError('size')
  const packages: GitHubPackage[] = []
  for (const file of manifests) {
    if (file.size > 256 * 1024 || (file.mode !== '100644' && file.mode !== '100755'))
      throw new CommunitySourceError('invalid')
    const bytes = await blob(repo.name, file, signal)
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (_invalidManifest) {
      throw new CommunitySourceError('invalid')
    }
    const info = object(raw)
    if (typeof info.dsh !== 'object' || info.dsh === null || !('bundle' in info.dsh)) continue
    const directory = file.path.slice(0, -'package.json'.length)
    let patterns: string[] | undefined
    if (info.files !== undefined) {
      if (!Array.isArray(info.files) || info.files.some(p => typeof p !== 'string'))
        throw new CommunitySourceError('invalid')
      patterns = info.files.flatMap(p =>
        typeof p === 'string'
          ? [p.replace(/^\.\//, '').replace(/\/$/, ''), p.replace(/^\.\//, '').replace(/\/$/, '') + '/**']
          : [],
      )
    }
    const matches = patterns === undefined ? () => true : picomatch(patterns, { dot: true })
    const selected = files
      .filter((entry) => {
        if (!entry.path.startsWith(directory)) return false
        const relative = entry.path.slice(directory.length)
        if (relative.split('/').some(p => p.startsWith('.') || p === 'node_modules')) return false
        return relative === 'package.json' || /^(?:readme|licen[cs]e)(?:\.|$)/i.test(relative) || matches(relative)
      })
      .map(entry => ({ ...entry, path: entry.path.slice(directory.length) }))
    if (selected.some(entry => !['100644', '100755'].includes(entry.mode))) throw new CommunitySourceError('invalid')
    packages.push({
      repository: repo.name,
      commit: sha,
      directory: directory.replace(/\/$/, ''),
      name: text(info.name),
      version: text(info.version),
      description: typeof info.description === 'string' ? info.description : '',
      files: selected,
    })
  }
  if (packages.length === 0) throw new CommunitySourceError('empty')
  return packages
}

/** Fetch pinned blobs and assemble a bounded npm archive for download or ordinary inspection.
 * @param pkg Package selected from one repository commit.
 * @param limits Current host archive policy.
 * @param signal Caller-owned cancellation and deadline.
 * @returns Gzip npm tar bytes Files are verified against their Git blob hashes before use.
 */
export async function downloadGitHubPackage(
  pkg: GitHubPackage,
  limits: WebPackageLimits,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const tarSize = 1024 + pkg.files.reduce((sum, file) => sum + 512 + Math.ceil(file.size / 512) * 512, 0)
  if (pkg.files.length > limits.files || tarSize > limits.expandedBytes) throw new CommunitySourceError('size')
  const entries: {
    header: { name: string; size: number }
    body: Uint8Array
  }[] = []
  for (let index = 0; index < pkg.files.length; index += 4) {
    const batch = pkg.files.slice(index, index + 4)
    const results = await Promise.allSettled(
      batch.map(async file => ({
        header: { name: 'package/' + file.path, size: file.size },
        body: await blob(pkg.repository, file, signal),
      })),
    )
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
      entries.push(result.value)
    }
  }
  signal.throwIfAborted()
  const tar = await packTar(entries)
  const gzip = new Blob([new Uint8Array(tar)]).stream().pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(gzip).arrayBuffer())
  if (bytes.length > limits.archiveBytes) throw new CommunitySourceError('size')
  return bytes
}
