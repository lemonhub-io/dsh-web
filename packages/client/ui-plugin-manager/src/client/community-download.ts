/** Bounded credential-free reads shared by community source adapters. */
export class CommunitySourceError extends Error {
  constructor(readonly code: 'network' | 'rate' | 'missing' | 'invalid' | 'size' | 'empty') {
    super(code)
    this.name = 'CommunitySourceError'
  }
}

/** GitHub hosts whose files reach the browser only through the community backend. */
const GITHUB_FILE_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])

/** Route a GitHub-hosted catalog or package URL through the community backend; other addresses are unchanged.
 * @param address Absolute source or same-origin development reference.
 * @param backend Community backend URL.
 * @returns The backend file address for GitHub hosts, otherwise `address`.
 */
export function communitySource(address: string, backend: string): string {
  let url: URL
  try {
    url = new URL(address, location.href)
  } catch (_invalidAddress) {
    return address
  }
  if (url.protocol !== 'https:' || !GITHUB_FILE_HOSTS.has(url.hostname.toLowerCase())) return address
  return `${backend.replace(/\/+$/, '')}/fetch?url=${encodeURIComponent(url.href)}`
}

/** Read an HTTPS source without redirects or ambient credentials.
 * @param address Absolute source or same-origin development reference.
 * @param limit Maximum response bytes.
 * @param signal Caller-owned cancellation and deadline.
 * @param accept Optional representation requested from GitHub.
 * @returns Complete bounded bytes HTTP failures never produce a usable package.
 */
export async function downloadCommunityBytes(
  address: string,
  limit: number,
  signal: AbortSignal,
  accept?: string,
): Promise<Uint8Array> {
  const url = new URL(address, location.href)
  if ((url.protocol !== 'https:' && url.origin !== location.origin) || url.username !== '' || url.password !== '') {
    throw new CommunitySourceError('invalid')
  }
  const response = await fetch(url, {
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal,
    ...(accept === undefined ? {} : { headers: { accept } }),
  })
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    await response.body?.cancel()
    throw new CommunitySourceError('rate')
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new CommunitySourceError(response.status === 404 ? 'missing' : response.status === 413 ? 'size' : 'network')
  }
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > limit) throw new CommunitySourceError('size')
      parts.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}
