/** Real browser composition for AI-operated cloud computing External providers are scripted in CI. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { cloudComputeScenario } from './cloud-compute.scenario.ts'

it(
  'lets the AI prepare cloud compute execute a task inspect returned files and enforce Session ownership',
  { timeout: 480000 },
  async () => {
    const root = new URL('../dist-site/', import.meta.url)
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
      void readFile(new URL(path === '/' ? 'index.html' : path.slice(1), root)).then(
        (bytes) => {
          response.writeHead(200, {
            'content-type': mime[extname(path === '/' ? 'index.html' : path)] ?? 'application/octet-stream',
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
    let browser: Browser | undefined
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
        ...(process.env.DSH_E2E_CHROME === undefined ? {} : { executablePath: process.env.DSH_E2E_CHROME }),
      })
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'zh-CN' })
      try {
        const result = await cloudComputeScenario(
          context,
          `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
        )
        expect(result.report).toContain('42')
        expect(result.errors).toEqual([])
      } finally {
        await context.close()
      }
    } finally {
      await browser?.close()
      if (server.listening)
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
    }
  },
)
