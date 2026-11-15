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
  /** Stargazer count; 0 when the backend omits it. */
  stars: number
  /** ISO time of the latest push, when the backend reports it. */
  pushed?: string
  /** Repository topics as reported by GitHub. */
  topics: string[]
  /** SPDX license identifier, when GitHub recognises one. */
  license?: string
}
/** Search orders accepted by the community backend. */
export type GitHubSort = 'updated' | 'stars'
/** Repositories requested per search page. */
export const GITHUB_PAGE_SIZE = 50
/** GitHub search returns at most this many results for one query. */
export const GITHUB_RESULT_LIMIT = 1000
/** One discovery request: keywords or an address, order, optional topic and 1-based page. */
export interface GitHubQuery {
  query: string
  sort: GitHubSort
  topic: string | undefined
  page: number
}
/** One page of discovery results. */
export interface GitHubSearch {
  repositories: GitHubRepository[]
  /** Matching repositories reported by GitHub, beyond the loaded page. */
  total: number
  /** The query named one repository address rather than search terms. */
  direct: boolean
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
  /** Package `license` field, empty when absent. */
  license: string
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
async function json(backend: string, path: string, signal: AbortSignal, limit = 1024 * 1024): Promise<unknown> {
  const bytes = await downloadCommunityBytes(
    backend.replace(/\/+$/, '') + '/github/' + path,
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
  const license = item.license
  return {
    name,
    description: typeof item.description === 'string' ? item.description : '',
    branch: text(item.default_branch),
    directory: '',
    stars: typeof item.stargazers_count === 'number' && Number.isSafeInteger(item.stargazers_count) && item.stargazers_count > 0 ? item.stargazers_count : 0,
    topics: Array.isArray(item.topics) ? item.topics.filter((topic): topic is string => typeof topic === 'string' && /^[a-z0-9-]{1,50}$/.test(topic)) : [],
    ...(typeof item.pushed_at === 'string' && !Number.isNaN(Date.parse(item.pushed_at)) ? { pushed: item.pushed_at } : {}),
    ...(typeof license === 'string' && /^[\w.+-]{1,64}$/.test(license) ? { license } : {}),
  }
}

/** Find tagged repositories or resolve an explicit owner/repository or GitHub tree URL.
 * @param request Search terms or repository address, order, topic and page; an address ignores the others.
 * @param signal Caller-owned cancellation and deadline.
 * @param backend Worker backend URL.
 * @returns Up to {@link GITHUB_PAGE_SIZE} repositories and the total match count No credentials are required.
 */
export async function discoverGitHub(request: GitHubQuery, signal: AbortSignal, backend: string): Promise<GitHubSearch> {
  const { query, sort, topic, page } = request
  let target = query
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\/$/, '')
  const direct = /^[\w.-]+\/[\w.-]+(?:\/tree\/[^/]+(?:\/.*)?)?$/.test(target)
  if (direct) {
    const [owner, rawName, , branch, ...directory] = target.split('/')
    const item = repository(await json(backend, `repos/${owner}/${rawName?.replace(/\.git$/, '')}`, signal))
    const path = directory.map(decodeURIComponent)
    if (path.some(part => !segment.test(part) || part === '.' || part === '..'))
      throw new CommunitySourceError('invalid')
    const repositories = [
      {
        ...item,
        branch: branch === undefined ? item.branch : decodeURIComponent(branch),
        directory: path.join('/'),
      },
    ]
    return { repositories, total: 1, direct: true }
  }
  target = query.trim()
  const search = new URLSearchParams({
    q: `${target}${topic === undefined ? '' : ' topic:' + topic} topic:dsh-plugin archived:false`,
    per_page: String(GITHUB_PAGE_SIZE),
    page: String(page),
    sort,
  })
  const result = object(await json(backend, 'search/repositories?' + search.toString(), signal))
  if (!Array.isArray(result.items) || result.items.length > GITHUB_PAGE_SIZE) throw new CommunitySourceError('invalid')
  const repositories = result.items.map(repository)
  const total = typeof result.total_count === 'number' && Number.isSafeInteger(result.total_count) && result.total_count >= 0
    ? result.total_count
    : repositories.length
  return { repositories, total, direct: false }
}

/** Blob identities the backend downloads in one request. */
const BLOB_BATCH = 24
/** Blob batch requests in flight at once. */
const BLOB_REQUESTS = 2

/** Refuse bytes whose Git blob identity differs from the pinned tree entry. */
async function verify(bytes: Uint8Array, file: GitHubFile): Promise<Uint8Array> {
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
function decodeBase64(value: string): Uint8Array {
  let binary: string
  try {
    binary = atob(value)
  } catch (_invalidBase64) {
    throw new CommunitySourceError('invalid')
  }
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

/** Read package manifests from a single commit without evaluating repository code.
 * One backend request returns the pinned commit, its file list under the selected directory and the manifests.
 * @param repo Repository selected by discovery.
 * @param signal Caller-owned cancellation and deadline.
 * @param backend Worker backend URL.
 * @returns Ordinary bundle packages with npm files selection and pinned blob identities.
 */
export async function githubPackages(repo: GitHubRepository, signal: AbortSignal, backend: string): Promise<GitHubPackage[]> {
  const query = new URLSearchParams({ ref: repo.branch, ...(repo.directory === '' ? {} : { directory: repo.directory }) })
  const snapshot = object(await json(backend, `repos/${repo.name}/packages?${query.toString()}`, signal, 16 * 1024 * 1024))
  const sha = text(snapshot.commit)
  if (!/^[a-f0-9]{40}$/.test(sha) || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.manifests))
    throw new CommunitySourceError('invalid')
  const supplied = new Map(snapshot.manifests.map((raw) => {
    const entry = object(raw)
    return [text(entry.path), text(entry.data)] as const
  }))
  const files: GitHubFile[] = []
  for (const raw of snapshot.files) {
    const entry = object(raw)
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
    const data = supplied.get(file.path)
    if (data === undefined) throw new CommunitySourceError('invalid')
    const bytes = await verify(decodeBase64(data), file)
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
      license: typeof info.license === 'string' ? info.license : '',
      files: selected,
    })
  }
  if (packages.length === 0) throw new CommunitySourceError('empty')
  return packages
}

/** Fetch pinned blobs in backend batches and assemble a bounded npm archive for download or ordinary inspection.
 * @param pkg Package selected from one repository commit.
 * @param limits Current host archive policy.
 * @param signal Caller-owned cancellation and deadline.
 * @param backend Worker backend URL.
 * @returns Gzip npm tar bytes Files are verified against their Git blob hashes before use.
 */
export async function downloadGitHubPackage(
  pkg: GitHubPackage,
  limits: WebPackageLimits,
  signal: AbortSignal,
  backend: string,
): Promise<Uint8Array> {
  const tarSize = 1024 + pkg.files.reduce((sum, file) => sum + 512 + Math.ceil(file.size / 512) * 512, 0)
  if (pkg.files.length > limits.files || tarSize > limits.expandedBytes) throw new CommunitySourceError('size')
  // Identical files share one blob, so each identity is downloaded once.
  const unique = [...new Map(pkg.files.map(file => [file.sha, file])).values()]
  const batches: GitHubFile[][] = []
  for (let index = 0; index < unique.length; index += BLOB_BATCH) batches.push(unique.slice(index, index + BLOB_BATCH))
  const contents = new Map<string, Uint8Array>()
  const fetchBatch = async (batch: GitHubFile[]): Promise<void> => {
    const total = batch.reduce((sum, file) => sum + file.size, 0)
    const bytes = await downloadCommunityBytes(
      backend.replace(/\/+$/, '') + `/github/repos/${pkg.repository}/blobs?sha=${batch.map(file => file.sha).join(',')}`,
      total,
      signal,
    )
    if (bytes.length !== total) throw new CommunitySourceError('invalid')
    let offset = 0
    for (const file of batch) {
      contents.set(file.sha, await verify(bytes.subarray(offset, offset + file.size), file))
      offset += file.size
    }
  }
  for (let index = 0; index < batches.length; index += BLOB_REQUESTS) {
    const results = await Promise.allSettled(batches.slice(index, index + BLOB_REQUESTS).map(fetchBatch))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  signal.throwIfAborted()
  const entries = pkg.files.map((file) => {
    const body = contents.get(file.sha)
    if (body === undefined) throw new CommunitySourceError('invalid')
    return { header: { name: 'package/' + file.path, size: file.size }, body }
  })
  const tar = await packTar(entries)
  const gzip = new Blob([new Uint8Array(tar)]).stream().pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(gzip).arrayBuffer())
  if (bytes.length > limits.archiveBytes) throw new CommunitySourceError('size')
  return bytes
}
