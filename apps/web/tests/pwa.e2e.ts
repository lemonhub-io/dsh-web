/**
 * The installed-application behavior of the built site, in one browser context:
 * installability, offline completeness, launches, sharing, hand-over to the running
 * window, attention, and an incremental update. Requires `pnpm --filter
 * @deepseek-ai/dsh-web-frontend run build:site`.
 */
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'

const SITE = fileURLToPath(new URL('../dist-site', import.meta.url))
const BOOT_TIMEOUT_MS = 150_000
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.gz': 'application/gzip',
}

const composer = (page: Page) => page.locator('[data-composer-input]').first()

/** Whether a directory exists in origin-private storage, below the data layout's root. */
async function storedDirectory(page: Page, path: string): Promise<boolean> {
  return await page.evaluate(async (relative) => {
    try {
      let directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('dsh-data-v1')
      for (const segment of relative.split('/')) directory = await directory.getDirectoryHandle(segment)
      return true
    } catch {
      return false
    }
  }, path)
}

/** Store a credential over the page's tunnel, which also ends the first-launch dialog. */
async function setCredential(page: Page): Promise<void> {
  await page.evaluate(async () => {
    type Transport = { fetch(input: string, init: RequestInit): Promise<Response> }
    const { fetch: tunnelFetch } = (globalThis as unknown as { __DSH_TRANSPORT__: Transport }).__DSH_TRANSPORT__
    const response = await tunnelFetch('/api/credentials/set', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'pwa-credentials', method: 'credentials/set', payload: { args: { ref: 'DEEPSEEK_API_KEY', value: 'sk-scripted' } } }),
    })
    const body = await response.json() as { result: { ok: boolean } }
    if (!body.result.ok) throw new Error('credentials/set failed')
  })
}

/** Post a share the way the operating system does: a form navigation to the share target. */
async function submitShare(target: Page, text: string): Promise<void> {
  await target.evaluate((body) => {
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = './share-target'
    form.enctype = 'multipart/form-data'
    const add = (name: string, value: string): void => {
      const input = document.createElement('input')
      input.name = name
      input.value = value
      form.append(input)
    }
    add('title', 'Shared title')
    add('text', body)
    add('url', 'https://example.com/shared')
    const file = document.createElement('input')
    file.type = 'file'
    file.name = 'files'
    const transfer = new DataTransfer()
    transfer.items.add(new File(['shared file'], 'shared.txt', { type: 'text/plain' }))
    file.files = transfer.files
    form.append(file)
    document.body.append(form)
    form.submit()
  }, text)
}

it('installs, works offline, takes launches, and updates only what changed', { timeout: 600_000 }, async () => {
  const requested: string[] = []
  const swSource = await readFile(join(SITE, 'sw.js'), 'utf8')
  let serviceWorker = swSource
  let indexOverride: string | undefined
  const server = createServer((request, response) => {
    const pathname = normalize(new URL(request.url ?? '/', 'http://site').pathname)
    requested.push(pathname)
    const send = (body: string | Buffer, path: string): void => {
      response.writeHead(200, { 'content-type': MEDIA_TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body)
    }
    const file = pathname === '/' ? 'index.html' : pathname
    if (pathname === '/sw.js') return send(serviceWorker, file)
    if (file.endsWith('index.html') && indexOverride !== undefined) return send(indexOverride, file)
    void readFile(join(SITE, file)).then((body) => { send(body, file) }, () => { response.writeHead(404).end() })
    return undefined
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...process.env.DSH_E2E_CHROME === undefined ? {} : { executablePath: process.env.DSH_E2E_CHROME } })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    await context.grantPermissions(['notifications'], { origin })
    // Any reach for the host machine's file system fails the run.
    await context.addInitScript(() => {
      (globalThis as unknown as { showDirectoryPicker(): never }).showDirectoryPicker = () => {
        throw new Error('the site asked for a host folder')
      }
    })
    const page = await context.newPage()
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await composer(page).waitFor({ timeout: BOOT_TIMEOUT_MS })
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 8000 }).catch(() => undefined)
    await setCredential(page)

    // First launch makes a default workspace in origin-private storage and opens the composer on it.
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30_000 })
    await expect.poll(() => storedDirectory(page, 'workspace/deepseek-harness/default-workspace'), { timeout: 10_000 }).toBe(true)
    expect(await page.getByText('Unable to create default workspace').count()).toBe(0)

    // The manifest parses without complaint and the browser would install it.
    const cdp = await context.newCDPSession(page)
    const manifest = await cdp.send('Page.getAppManifest')
    expect(manifest.errors).toEqual([])
    const parsed = JSON.parse(manifest.data ?? '{}') as Record<string, unknown>
    for (const member of ['share_target', 'launch_handler', 'shortcuts', 'screenshots']) expect(parsed).toHaveProperty(member)
    expect(parsed).not.toHaveProperty('file_handlers')
    // A Playwright context counts as incognito, where no site can install; anything else would be the site's fault.
    const installability = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors
    expect(installability.map(error => error.errorId).filter(id => id !== 'in-incognito')).toEqual([])

    // After boot every file is stored, so no page needs the network once the app ran.
    const offlineReady = (): Promise<boolean | undefined> => page.evaluate(() => {
      type App = { offlineReady(): Promise<boolean | undefined> }
      return (globalThis as unknown as { __DSH_WEB_PLATFORM__: { app: App } }).__DSH_WEB_PLATFORM__.app.offlineReady()
    })
    await expect.poll(offlineReady, { timeout: 120_000, interval: 1000 }).toBe(true)
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 20_000 }).toBe(true)

    // A share posted the way the operating system posts one lands in a draft, unsent.
    await submitShare(page, 'first share')
    await composer(page).waitFor({ timeout: BOOT_TIMEOUT_MS })
    await expect.poll(() => composer(page).innerText(), { timeout: 30_000 }).toContain('first share')
    expect(await composer(page).innerText()).toContain('https://example.com/shared')
    await page.getByText('shared.txt').first().waitFor({ timeout: 30_000 })

    // A second window launched with a share gives it to the window holding the host.
    const second = await context.newPage()
    await second.goto(origin, { waitUntil: 'domcontentloaded' })
    await second.getByText('open in another tab').waitFor({ timeout: 60_000 })
    await submitShare(second, 'second share')
    await expect.poll(() => composer(page).innerText(), { timeout: 60_000 }).toContain('second share')
    if (!second.isClosed()) await second.close()

    // Adding a workspace asks for a name and creates it in origin-private storage.
    await page.getByRole('button', { name: 'Add workspace' }).first().click()
    await page.getByRole('textbox', { name: 'Workspace name' }).fill('../my project')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect.poll(() => storedDirectory(page, 'workspace/my-project'), { timeout: 20_000 }).toBe(true)
    await page.getByText('my-project').first().waitFor({ timeout: 20_000 })

    // A shortcut opens Settings, the settings rows ship, and the action leaves the address.
    await page.goto(`${origin}?action=settings`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Browser data').waitFor({ timeout: BOOT_TIMEOUT_MS })
    expect(new URL(page.url()).search).toBe('')
    await page.getByRole('button', { name: 'Check for updates' }).click()
    // The check waits for the first install, which caches the whole image and is slow on CI runners.
    await page.getByText('You have the latest version').waitFor({ timeout: 120_000 })
    await page.getByText('All files are saved for offline use').waitFor({ timeout: 30_000 })
    await page.keyboard.press('Escape')

    // Headless Chromium accepts notifications without showing or listing them, so this checks the call.
    const shown = await page.evaluate(async () => {
      const calls: { title: string; data: unknown }[] = []
      const original = ServiceWorkerRegistration.prototype.showNotification
      ServiceWorkerRegistration.prototype.showNotification = async function (title: string, options?: NotificationOptions) {
        calls.push({ title, data: options?.data })
        await original.call(this, title, options)
      }
      type App = {
        setNotifications(on: boolean): Promise<void>
        notify(title: string, body: string, id: string): void
        setBadge(count: number): void
      }
      const { app } = (globalThis as unknown as { __DSH_WEB_PLATFORM__: { app: App } }).__DSH_WEB_PLATFORM__
      app.notify('Before enabling', 'A title', 'session-id')
      await app.setNotifications(true)
      app.notify('Session finished', 'A title', 'session-id')
      app.setBadge(1)
      return calls
    })
    expect(shown).toEqual([{ title: 'Session finished', data: { sessionId: 'session-id' } }])

    // Everything starts with no network: reload offline, including a chunk nothing has used yet.
    await context.setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await composer(page).waitFor({ timeout: BOOT_TIMEOUT_MS })
    await page.locator('[data-dsh-toast]', { hasText: 'You are offline' }).waitFor({ timeout: 20_000 })
    const anyLazy = await page.evaluate(async () => {
      const cache = await caches.open((await caches.keys()).find(name => name.startsWith('dsh-site-'))!)
      return (await cache.keys()).map(key => key.url).filter(url => url.includes('/assets/langs/') || url.includes('/preview/lazy/'))
    })
    expect(anyLazy.length).toBeGreaterThan(0)
    expect(await page.evaluate(async url => (await fetch(url)).status, anyLazy[0]!)).toBe(200)
    await context.setOffline(false)

    // A new version whose only changed file is the page downloads that file alone.
    const index = await readFile(join(SITE, 'index.html'), 'utf8')
    indexOverride = index.replace('</head>', '<meta name="dsh-e2e" content="next" /></head>')
    const { createHash } = await import('node:crypto')
    const nextHash = createHash('sha256').update(indexOverride).digest('hex').slice(0, 16)
    const currentHash = createHash('sha256').update(index).digest('hex').slice(0, 16)
    expect(swSource).toContain(currentHash)
    serviceWorker = swSource.replace(currentHash, nextHash).replace(/const VERSION = '[^']+'/u, "const VERSION = 'e2e-next'")
    requested.length = 0
    const result = await page.evaluate(() => {
      type App = { checkForUpdate(): Promise<string> }
      return (globalThis as unknown as { __DSH_WEB_PLATFORM__: { app: App } }).__DSH_WEB_PLATFORM__.app.checkForUpdate()
    })
    expect(result).toBe('available')
    const notice = page.locator('[data-dsh-toast]', { hasText: 'A new version is ready' })
    await notice.waitFor({ timeout: 60_000 })
    expect(requested.filter(path => path !== '/sw.js').sort()).toEqual(['/index.html'])

    // Accepting it reloads into the new page.
    await notice.getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => page.evaluate(() => document.querySelector('meta[name="dsh-e2e"]')?.getAttribute('content')).catch(() => undefined), { timeout: 60_000 }).toBe('next')

    // A version put off with Later takes over by itself on the next start, before the harness runs.
    await composer(page).waitFor({ timeout: BOOT_TIMEOUT_MS })
    indexOverride = index.replace('</head>', '<meta name="dsh-e2e" content="third" /></head>')
    const thirdHash = createHash('sha256').update(indexOverride).digest('hex').slice(0, 16)
    serviceWorker = swSource.replace(currentHash, thirdHash).replace(/const VERSION = '[^']+'/u, "const VERSION = 'e2e-third'")
    expect(await page.evaluate(() => {
      type App = { checkForUpdate(): Promise<string> }
      return (globalThis as unknown as { __DSH_WEB_PLATFORM__: { app: App } }).__DSH_WEB_PLATFORM__.app.checkForUpdate()
    })).toBe('available')
    const third = page.locator('[data-dsh-toast]', { hasText: 'A new version is ready' })
    await third.waitFor({ timeout: 60_000 })
    await third.getByRole('button', { name: 'Later' }).click()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(() => page.evaluate(() => document.querySelector('meta[name="dsh-e2e"]')?.getAttribute('content')).catch(() => undefined), { timeout: 60_000 }).toBe('third')
    await composer(page).waitFor({ timeout: BOOT_TIMEOUT_MS })
    expect(await page.locator('[data-dsh-toast]', { hasText: 'A new version is ready' }).count()).toBe(0)
  } finally {
    await browser.close()
    server.close()
  }
})
