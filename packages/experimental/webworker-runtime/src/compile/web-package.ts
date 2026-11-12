/** Prepare ordinary built npm files with the existing Worker module transform. */
import { lowerModuleSource } from './transform.ts'
import { LOWERING_VERSION } from '../image-layout.ts'
import { MODULE_PROXIES } from '../module-proxies.ts'

/** Add Worker metadata and lower JavaScript without evaluating package code.
 * @param files Package-relative archive files owned by the caller.
 * @returns Files with prepared JavaScript and package metadata Existing Web builds retain their declared generation.
 */
export function prepareWebPackage(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const metadata = files['package.json']
  if (metadata === undefined || metadata.length > 256 * 1024) throw new Error('Missing package manifest')
  const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata))
  if (typeof manifest !== 'object' || manifest === null || !('dsh' in manifest))
    throw new Error('Missing bundle metadata')
  const dsh = manifest.dsh
  if (typeof dsh !== 'object' || dsh === null || !('bundle' in dsh)) throw new Error('Missing bundle metadata')
  if ('web' in dsh) return files
  const modules: Record<string, string[]> = {}
  const requires = new Set<string>()
  for (const [path, bytes] of Object.entries(files)) {
    if (!/\.(?:js|mjs|cjs)$/.test(path)) continue
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const lowered = source.includes('window.__ModuleLoader__.load(')
      ? { code: source, moduleRequests: [], metaResolveRequests: [] }
      : lowerModuleSource({ filename: path, source })
    modules[path] = [...new Set([...lowered.moduleRequests, ...lowered.metaResolveRequests])]
    for (const request of modules[path]) {
      if (Object.hasOwn(MODULE_PROXIES, request) || request === 'process' || request === 'node:process')
        requires.add(request)
    }
    files[path] = new TextEncoder().encode(lowered.code)
  }
  files['package.json'] = new TextEncoder().encode(
    JSON.stringify(
      {
        ...manifest,
        dsh: {
          ...dsh,
          web: {
            lowered: LOWERING_VERSION,
            modules,
            requires: [...requires].sort(),
          },
        },
      },
      null,
      2,
    ) + '\n',
  )
  return files
}
