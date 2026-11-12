/** Prepare an ordinary Cordis npm bundle with the existing Web Worker transform. */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'
import { prepareWebPackage } from '../packages/experimental/webworker-runtime/src/compile/web-package.ts'
import { packTar } from '../packages/experimental/webworker-runtime/src/storage/tar.ts'
import type { DshPackageManifest } from '../packages/util/package-manifest/src/types.ts'

const { values } = parseArgs({
  options: { src: { type: 'string' }, out: { type: 'string' } },
})
async function main(): Promise<void> {
  if (values.src === undefined || values.out === undefined)
    throw new Error('Usage: pack-web-plugin --src <built npm package> --out <package.tgz>')
  const directory = resolve(values.src),
    files: Record<string, Uint8Array> = {}
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as DshPackageManifest
  if (manifest.dsh?.bundle === undefined) throw new Error('The package must declare dsh.bundle.patch')
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name),
        name = relative(directory, full).replaceAll('\\', '/')
      if (entry.isSymbolicLink()) throw new Error('Bundle dependencies before packing Symlinks are not distributed')
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (name === 'package.json') continue
      files[name] = new Uint8Array(await readFile(full))
    }
  }
  await walk(directory)
  files['package.json'] = new TextEncoder().encode(JSON.stringify(manifest))
  const prepared = prepareWebPackage(files)
  const packed = Object.fromEntries(Object.entries(prepared).map(([path, bytes]) => ['package/' + path, bytes]))
  await writeFile(resolve(values.out), gzipSync(packTar(packed)))
  console.log(`${manifest.name}@${manifest.version}`)
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
