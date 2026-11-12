/** Prepared npm bundle installation through the existing profile and module loader. */
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import semver from 'semver'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import {
  evaluatePluginCompatibility,
  bundlePatchPaths,
  loadOverlayPatches,
  assertBundlePlatform,
  readProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { saveManifest } from './operations.ts'

import type { WebPackageLimits, WebPackageRuntime, WebBundleInspection } from './web-package-types.ts'
export type { WebPackageLimits, WebPackageRuntime, WebBundleInspection } from './web-package-types.ts'
/** Typed distribution refusal User-facing text belongs to the community dictionary. */
export class WebPackageFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'WebPackageFailure'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webPluginRuntime: WebPackageRuntime
  }
}

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const safePath = (path: string): boolean => path.split('/').every(p => /^[A-Za-z0-9_@.+-]+$/.test(p) && p !== '.' && p !== '..')
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WebPackageFailure('invalid')
  return value as Record<string, unknown>
}
interface Prepared {
  manifest: ProfileManifest & { name: string; version: string }
  files: Record<string, Uint8Array>
  modules: Record<string, string[]>
  requires: string[]
}

async function prepare(encoded: string, runtime: WebPackageRuntime, limits: WebPackageLimits): Promise<Prepared> {
  if (encoded.length > Math.ceil(limits.archiveBytes / 3) * 4) throw new WebPackageFailure('size')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) throw new WebPackageFailure('invalid')
  let files: Record<string, Uint8Array>
  try {
    files = await runtime.unpack(bytes, limits)
  } catch (_invalidArchive) {
    throw new WebPackageFailure('invalid')
  }
  const metadata = files['package.json']
  if (metadata === undefined || metadata.length > 256 * 1024) throw new WebPackageFailure('invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata))
  } catch (_invalidManifest) {
    throw new WebPackageFailure('invalid')
  }
  const value = record(parsed),
    dsh = record(value.dsh),
    web = record(dsh.web),
    bundle = record(dsh.bundle)
  if (value.description !== undefined && typeof value.description !== 'string') throw new WebPackageFailure('invalid')
  const engines = value.engines === undefined ? {} : record(value.engines)
  if (engines.node !== undefined && (typeof engines.node !== 'string' || !semver.satisfies(process.versions.node, engines.node)))
    throw new WebPackageFailure('version')
  if (bundle.platforms !== undefined && (!Array.isArray(bundle.platforms) || bundle.platforms.some(p => typeof p !== 'string')))
    throw new WebPackageFailure('invalid')
  const platforms = Array.isArray(bundle.platforms)
    ? bundle.platforms.filter((p): p is string => typeof p === 'string')
    : undefined
  try {
    assertBundlePlatform(platforms, process.platform)
  } catch (_unsupportedPlatform) {
    throw new WebPackageFailure('capability')
  }
  if (
    typeof value.name !== 'string' ||
    !packageName.test(value.name) ||
    typeof value.version !== 'string' ||
    semver.valid(value.version) === null
  )
    throw new WebPackageFailure('invalid')
  if (web.lowered !== runtime.lowering) throw new WebPackageFailure('lowering')
  if (!Array.isArray(web.requires) || web.requires.some(v => typeof v !== 'string')) throw new WebPackageFailure('invalid')
  const requires = web.requires.filter((v): v is string => typeof v === 'string')
  if (requires.some(v => !runtime.capabilities.includes(v))) throw new WebPackageFailure('capability')
  const modules: Record<string, string[]> = {}
  for (const [path, imports] of Object.entries(record(web.modules))) {
    if (!safePath(path) || files[path] === undefined || !Array.isArray(imports) || imports.some(v => typeof v !== 'string'))
      throw new WebPackageFailure('invalid')
    modules[path] = imports.filter((v): v is string => typeof v === 'string')
  }
  const patches = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
  if (
    !Array.isArray(patches) ||
    patches.length === 0 ||
    patches.some(p => typeof p !== 'string' || !safePath(p.replace(/^\.\//, '')) || files[p.replace(/^\.\//, '')] === undefined)
  )
    throw new WebPackageFailure('invalid')
  for (const path of Object.keys(files)) {
    if (/\.(?:node|[cm]?ts|tsx)$/i.test(path) && !/\.d\.(?:ts|mts|cts)$/i.test(path)) throw new WebPackageFailure('native')
    if (/\.(?:js|mjs|cjs)$/.test(path) && modules[path] === undefined) throw new WebPackageFailure('invalid')
  }
  const manifest: ProfileManifest & { name: string; version: string } = { ...value, name: value.name, version: value.version }
  const compatibility = evaluatePluginCompatibility(manifest, {})
  if (compatibility !== undefined && !compatibility.exempted) throw new WebPackageFailure('version')
  return { manifest, files, modules, requires }
}

async function stage(
  prepared: Prepared,
  profile: string,
  runtime: WebPackageRuntime,
): Promise<{ root: string; directory: string }> {
  const staging = join(profile, '.web-packages')
  await mkdir(staging, { recursive: true })
  const root = await mkdtemp(join(staging, 'install-'))
  const directory = join(root, 'node_modules', prepared.manifest.name)
  try {
    for (const [path, bytes] of Object.entries(prepared.files)) {
      const target = join(directory, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    try {
      runtime.validate(directory, prepared.modules)
    } catch (_missingModule) {
      throw new WebPackageFailure('dependency')
    }
    for (const [name, range] of Object.entries({ ...prepared.manifest.dependencies, ...prepared.manifest.peerDependencies })) {
      if (!packageName.test(name) || typeof range !== 'string' || semver.validRange(range) === null)
        throw new WebPackageFailure('dependency')
      const require = createRequire(join(directory, 'package.json'))
      const roots = require.resolve.paths(name) ?? []
      const path = roots.map(root => join(root, name, 'package.json')).find(existsSync)
      if (path === undefined) throw new WebPackageFailure('dependency')
      const dependency = record(JSON.parse(readFileSync(path, 'utf8')))
      if (typeof dependency.version !== 'string' || !semver.satisfies(dependency.version, range, { includePrerelease: true }))
        throw new WebPackageFailure('dependency')
    }
    return { root, directory }
  } catch (error) {
    runtime.invalidate(root)
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/** Inspect a prepared npm archive without evaluating its JavaScript.
 * @param encoded Base64 gzip tar bytes.
 * @param profile Existing profile directory.
 * @param runtime Platform provider.
 * @param limits Deployment bounds.
 * @returns Compatibility and ordinary package metadata.
 */
export async function inspectWebBundle(
  encoded: string,
  profile: string,
  runtime: WebPackageRuntime,
  limits: WebPackageLimits,
): Promise<WebBundleInspection> {
  try {
    const prepared = await prepare(encoded, runtime, limits)
    const staged = await stage(prepared, profile, runtime)
    runtime.invalidate(staged.root)
    await rm(staged.root, { recursive: true, force: true })
    return {
      name: prepared.manifest.name,
      version: prepared.manifest.version,
      description: prepared.manifest.description ?? '',
      compatible: true,
      requires: prepared.requires,
    }
  } catch (error) {
    if (!(error instanceof WebPackageFailure)) throw error
    return { name: '', version: '', description: '', compatible: false, problem: error.code, requires: [] }
  } finally {
    await runtime.flush()
  }
}

/** Commit one disabled bundle dependency The existing manager owns subsequent enablement.
 * @param encoded Base64 npm archive.
 * @param profile Current profile directory.
 * @param runtime Platform provider.
 * @param limits Deployment bounds.
 * @returns Installed package identity.
 */
export async function installWebBundle(
  encoded: string,
  profile: string,
  runtime: WebPackageRuntime,
  limits: WebPackageLimits,
  signal?: AbortSignal,
): Promise<{ name: string; version: string }> {
  const prepared = await prepare(encoded, runtime, limits)
  const current = readProfileManifest('dsh', profile)
  const dependencies = current.dependencies ?? {}
  const target = join(profile, 'node_modules', prepared.manifest.name)
  if (Object.hasOwn(dependencies, prepared.manifest.name) || existsSync(target)) throw new WebPackageFailure('installed')
  const staged = await stage(prepared, profile, runtime)
  let moved = false,
    committed = false
  try {
    signal?.throwIfAborted()
    for (const path of bundlePatchPaths(staged.directory, prepared.manifest.dsh?.bundle ?? { patch: [] }))
      loadOverlayPatches('dsh', path)
    await mkdir(dirname(target), { recursive: true })
    await rename(staged.directory, target)
    moved = true
    await runtime.flush()
    await saveManifest(profile, {
      ...current,
      dependencies: { ...dependencies, [prepared.manifest.name]: prepared.manifest.version },
    })
    committed = true
    await runtime.flush()
    return { name: prepared.manifest.name, version: prepared.manifest.version }
  } finally {
    runtime.invalidate(staged.root)
    await rm(staged.root, { recursive: true, force: true })
    if (moved && !committed) {
      runtime.invalidate(target)
      await rm(target, { recursive: true, force: true })
      await runtime.flush()
    }
  }
}

/** Remove files only after the manager has stopped every contribution.
 * @param name Installed package name.
 * @param profile Current profile directory.
 * @param runtime Platform provider.
 */
export async function removeWebBundle(name: string, profile: string, runtime: WebPackageRuntime): Promise<void> {
  if (!packageName.test(name)) throw new WebPackageFailure('invalid')
  const manifest = readProfileManifest('dsh', profile)
  const dependencies = manifest.dependencies ?? {}
  const kept = Object.fromEntries(Object.entries(dependencies).filter(([key]) => key !== name))
  await saveManifest(profile, { ...manifest, dependencies: kept })
  const target = join(profile, 'node_modules', name)
  runtime.invalidate(target)
  await rm(target, { recursive: true, force: true })
  await runtime.flush()
}
