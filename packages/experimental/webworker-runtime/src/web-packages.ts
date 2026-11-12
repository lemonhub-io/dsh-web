/** Browser distribution provider for the existing Cordis profile package manager. */
import type { WebPackageRuntime } from '@deepseek-ai/dsh-plugin-manager/types'
import { LOWERING_VERSION } from './image-layout.ts'
import { MODULE_PROXIES } from './module-proxies.ts'
import { parseTar } from './storage/tar.ts'
import type { WorkerModuleLoader } from './module-system/module-loader.ts'
import { dirname, join } from './module-system/posix-path.ts'
import { prepareWebPackage } from './compile/web-package.ts'

/** Supply bounded archive decoding and the running Worker's ordinary resolver.
 * @param loader Current host module loader.
 * @param flush Durable platform barrier.
 * @returns Platform capability consumed by pluginManager.
 */
export function createWebPackageRuntime(loader: WorkerModuleLoader, flush: () => Promise<void>): WebPackageRuntime {
  return {
    lowering: LOWERING_VERSION,
    capabilities: [
      ...Object.entries(MODULE_PROXIES)
        .filter(([, path]) => path.includes('/implemented/'))
        .map(([name]) => name),
      'process',
      'node:process',
    ],
    async unpack(bytes, limits) {
      if (bytes.length > limits.archiveBytes || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Invalid npm archive')
      const source = new Response(new Uint8Array(bytes)).body
      if (source === null) throw new Error('Missing npm archive')
      const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const item = await reader.read()
          if (item.done) break
          size += item.value.length
          if (size > limits.expandedBytes) throw new Error('Npm archive exceeds the expanded limit')
          chunks.push(item.value)
        }
      } finally {
        await reader.cancel()
      }
      const tar = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        tar.set(chunk, offset)
        offset += chunk.length
      }
      const entries = parseTar(tar)
      if (entries.length > limits.files) throw new Error('Too many npm archive entries')
      const files: Record<string, Uint8Array> = {},
        names = new Set<string>()
      for (const entry of entries) {
        const name = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name
        if (!name.startsWith('package/') && name !== 'package') throw new Error('Npm archive must contain one package directory')
        if (
          !name.split('/').every(p => /^[A-Za-z0-9_@.+-]+$/.test(p) && p !== '.' && p !== '..') ||
          names.has(name.toLowerCase())
        )
          throw new Error('Unsafe npm archive path')
        names.add(name.toLowerCase())
        if (!entry.directory) files[name.slice('package/'.length)] = entry.bytes
      }
      const prepared = prepareWebPackage(files)
      if (Object.values(prepared).reduce((total, bytes) => total + bytes.length, 0) > limits.expandedBytes) {
        throw new Error('Prepared package exceeds the expanded limit')
      }
      return prepared
    },
    validate(directory, modules) {
      for (const [path, requests] of Object.entries(modules)) {
        for (const request of requests) loader.resolve(request, dirname(join(directory, path)))
      }
    },
    invalidate: (directory) => {
      loader.invalidate(directory)
    },
    flush,
  }
}
