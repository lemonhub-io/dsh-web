/** Minimal reader for the stored or deflated zip archives GitHub serves for artifacts. */

const decoder = new TextDecoder()

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Read every file entry of a zip archive.
 * @param bytes - complete archive.
 * @param limit - maximum total uncompressed bytes.
 * @returns entry paths mapped to contents; directories are omitted.
 */
export async function unzip(bytes: Uint8Array, limit = 64 * 1024 * 1024): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error('Not a zip archive')
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  const files = new Map<string, Uint8Array>()
  let total = 0
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Corrupt zip directory')
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const local = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    offset += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Unsafe zip entry ' + name)
    total += size
    if (total > limit) throw new Error('Archive is too large')
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = bytes.subarray(start, start + compressedSize)
    if (method === 0) files.set(name, data.slice())
    else if (method === 8) files.set(name, await inflateRaw(data))
    else throw new Error('Unsupported zip compression')
  }
  return files
}
