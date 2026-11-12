/** One real static-site lifecycle for ordinary Cordis Web distributions. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { cordisCommunityScenario } from './cordis-community.scenario.ts'
import { createWebPackageRuntime } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/web-packages.ts'
import { WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader.ts'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { packTar } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/tar.ts'

it(
  'discovers and installs existing Cordis bundles through the shared manager and withdraws their tools on removal',
  { timeout: 300000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cordis-browser-'))
    let browser: Browser | undefined
    const site = new URL('../dist-site/', import.meta.url)
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.wasm': 'application/wasm',
      '.woff2': 'font/woff2',
      '.svg': 'image/svg+xml',
    }
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://site').pathname
      void readFile(new URL(path === '/' ? 'index.html' : path.slice(1), site)).then(
        (bytes) => {
          response.writeHead(200, {
            'content-type': mime[extname(path)] ?? 'application/octet-stream',
            'content-length': bytes.length,
          })
          response.end(bytes)
        },
        () => {
          response.writeHead(404)
          response.end()
        },
      )
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const runtime = createWebPackageRuntime(
        new WorkerModuleLoader({ vfs: new MemoryVfs(), staticModules: {} }),
        async () => {},
      )
      const files = await runtime.unpack(
        new Uint8Array(await readFile(new URL('../public/plugin-community/cordis/hello-1.0.0.tgz', import.meta.url))),
        { archiveBytes: 2097152, expandedBytes: 33554432, files: 1024 },
      )
      const manifest = JSON.parse(new TextDecoder().decode(files['package.json'])) as object
      const archive: Record<string, Uint8Array> = {}
      for (const [path, bytes] of Object.entries(files)) archive['package/' + path] = bytes
      archive['package/package.json'] = new TextEncoder().encode(
        JSON.stringify({ ...manifest, version: '9.0.0', engines: { dsh: '>=99' } }),
      )
      const incompatible = join(directory, 'incompatible.tgz')
      await writeFile(incompatible, gzipSync(packTar(archive)))
      const sourceFiles: Record<string, Uint8Array> = {}
      for (const path of ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
        sourceFiles[path] = new Uint8Array(await readFile(new URL('../plugin-examples/hello/' + path, import.meta.url)))
      }
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
        ...(process.env.DSH_E2E_CHROME === undefined ? {} : { executablePath: process.env.DSH_E2E_CHROME }),
      })
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
      try {
        const result = await cordisCommunityScenario(
          context,
          `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
          incompatible,
          sourceFiles,
        )
        expect(result.toolResult).toContain('Cordis ordinary-plugin')
        expect(result.errors).toEqual([])
      } finally {
        await context.close()
      }
    } finally {
      await browser?.close()
      if (server.listening)
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
          server.closeAllConnections()
        })
      await rm(directory, { recursive: true, force: true })
    }
  },
)
