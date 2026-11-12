import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { inspectWebBundle, installWebBundle, removeWebBundle } from '../src/web-packages.ts'
import { createWebPackageRuntime } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/web-packages.ts'
import { WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader.ts'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { packTar } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/tar.ts'

it('installs ordinary disabled bundles and refuses incompatible distributions before code evaluation or profile changes', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-web-packages-'))
  const runtime = createWebPackageRuntime(
    new WorkerModuleLoader({ vfs: new MemoryVfs(), staticModules: {} }),
    async () => {},
  )
  const limits = { archiveBytes: 2 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024, files: 1024 }
  const original = JSON.stringify({ name: 'test-profile', dependencies: {}, dsh: { profile: { bundles: [] } } })
  try {
    await writeFile(join(profile, 'package.json'), original)
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']) {
      const directory = join(profile, 'node_modules', name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '0.2.2-rc.1' }))
    }
    const files = await runtime.unpack(
      new Uint8Array(
        await readFile(new URL('../../../../apps/web/public/plugin-community/cordis/hello-1.0.0.tgz', import.meta.url)),
      ),
      limits,
    )
    const base = JSON.parse(new TextDecoder().decode(files['package.json'])) as {
      name: string
      version: string
      engines: object
      dsh: { web: { requires: string[]; lowered: string; modules: Record<string, string[]> } }
    }
    const archive = (manifest: object, extra: Record<string, Uint8Array> = {}): string => {
      const packed: Record<string, Uint8Array> = {}
      for (const [path, bytes] of Object.entries(files)) packed['package/' + path] = bytes
      packed['package/package.json'] = new TextEncoder().encode(JSON.stringify(manifest))
      return gzipSync(packTar({ ...packed, ...extra })).toString('base64')
    }
    expect(await inspectWebBundle(archive(base), profile, runtime, limits)).toMatchObject({
      compatible: true,
      name: '@dsh-community/hello',
    })
    expect(
      await inspectWebBundle(archive({ ...base, engines: { dsh: '>=99' } }), profile, runtime, limits),
    ).toMatchObject({
      compatible: false,
      problem: 'version',
    })
    expect(
      await inspectWebBundle(
        archive({ ...base, dsh: { ...base.dsh, web: { ...base.dsh.web, requires: ['node:net'] } } }),
        profile,
        runtime,
        limits,
      ),
    ).toMatchObject({ compatible: false, problem: 'capability' })
    expect(
      await inspectWebBundle(
        archive({
          ...base,
          dsh: { ...base.dsh, web: { ...base.dsh.web, modules: { 'index.js': ['missing-dependency'] } } },
        }),
        profile,
        runtime,
        limits,
      ),
    ).toMatchObject({ compatible: false, problem: 'dependency' })
    expect(
      await inspectWebBundle(archive(base, { 'package/../escape': new Uint8Array([1]) }), profile, runtime, limits),
    ).toMatchObject({ compatible: false, problem: 'invalid' })
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(original)
    const ordinary = { ...base, dsh: { ...base.dsh, web: undefined, bundle: { patch: './cordis.patch.yml' } } }
    await installWebBundle(
      archive(ordinary, {
        'package/index.js': new Uint8Array(
          await readFile(new URL('../../../../apps/web/plugin-examples/hello/index.js', import.meta.url)),
        ),
      }),
      profile,
      runtime,
      limits,
    )
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { '@dsh-community/hello': '1.0.0' },
      dsh: { profile: { bundles: [] } },
    })
    await removeWebBundle(base.name, profile, runtime)
    await expect(access(join(profile, 'node_modules', base.name))).rejects.toThrow()
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: {} })
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})
