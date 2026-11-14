// Service worker of the browser-hosted site. A new version installs beside the running one and takes
// over only when the person accepts the reload, because the running host holds a matching runtime image.
const VERSION = '__DSH_SITE_VERSION__'
// Site path to content hash. Precached files are needed to start; lazy files fill in after boot.
const PRECACHE = __DSH_PRECACHE__
const LAZY = __DSH_LAZY__
const CACHE = `dsh-site-${VERSION}`
// Lives outside the versioned caches so an update between a share and its reading keeps the share.
const SHARE_CACHE = 'dsh-share'
const FILE_LIST = './__files.json'
const SHARE_TARGET = new URL('./share-target', self.registration.scope).href
const CONCURRENCY = 6

/** Run one task per item, a few at a time; the first failure rejects after running tasks settle. */
async function forEachLimited(items, task) {
  const queue = [...items]
  const failures = []
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) await task(queue.shift()).catch((error) => { failures.push(error) })
  }))
  if (failures.length > 0) throw failures[0]
}

/** Older caches with their file lists, so an update downloads only what changed. */
async function previousVersions() {
  const found = []
  for (const name of await caches.keys()) {
    if (!name.startsWith('dsh-site-') || name === CACHE) continue
    const cache = await caches.open(name)
    const list = await cache.match(FILE_LIST)
    if (list !== undefined) found.push({ cache, files: await list.json() })
  }
  return found
}

async function reusable(previous, url, hash) {
  for (const { cache, files } of previous) {
    if (files[url] !== hash) continue
    const response = await cache.match(url)
    if (response !== undefined) return response
  }
  return undefined
}

/** Download one file, refusing a body the build did not produce, such as a half-finished deployment. */
async function download(url, hash) {
  const response = await fetch(url, { cache: 'no-cache' })
  if (response.status !== 200) throw new Error(`${url}: HTTP ${String(response.status)}`)
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer())
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, hash.length)
  if (actual !== hash) throw new Error(`${url}: content does not match this version`)
  return response
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    const previous = await previousVersions()
    await forEachLimited(Object.entries(PRECACHE), async ([url, hash]) => {
      if (await cache.match(url) !== undefined) return
      await cache.put(url, await reusable(previous, url, hash) ?? await download(url, hash))
    })
    await forEachLimited(Object.entries(LAZY), async ([url, hash]) => {
      const response = await reusable(previous, url, hash)
      if (response !== undefined) await cache.put(url, response)
    })
    await cache.put(FILE_LIST, Response.json({ ...PRECACHE, ...LAZY }))
    // The first install has no running version to wait for.
    if (self.registration.active === null) await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('dsh-site-') && name !== CACHE) await caches.delete(name)
    }
    await self.clients.claim()
  })())
})

async function missingLazy(cache) {
  const missing = []
  for (const [url, hash] of Object.entries(LAZY)) {
    if (await cache.match(url) === undefined) missing.push([url, hash])
  }
  return missing
}

let filling

async function activateIfAlone() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (windows.length > 1) return false
  await self.skipWaiting()
  return true
}

/** Fetch on-demand grammars, fonts, and chunks once the app runs, so every page works offline. */
function fillLazy() {
  filling ??= (async () => {
    const cache = await caches.open(CACHE)
    // A file that fails stays missing and the next start tries it again.
    await forEachLimited(await missingLazy(cache), async ([url, hash]) => {
      await cache.put(url, await download(url, hash))
    }).catch(() => undefined)
  })().finally(() => { filling = undefined })
  return filling
}

async function offlineStatus() {
  return { version: VERSION, ready: (await missingLazy(await caches.open(CACHE))).length === 0 }
}

self.addEventListener('message', (event) => {
  const reply = event.ports[0]
  if (event.data === 'skip-waiting') void self.skipWaiting()
  // A window that has not started its host asks this waiting version to take over at once, which is
  // safe only while no other window runs the current version.
  else if (event.data === 'activate-if-alone') event.waitUntil(activateIfAlone().then((activated) => { reply?.postMessage({ activated }) }))
  else if (event.data === 'offline-status') event.waitUntil(offlineStatus().then((status) => { reply?.postMessage(status) }))
  else if (event.data === 'fill-offline') event.waitUntil(fillLazy().then(offlineStatus).then((status) => { reply?.postMessage(status) }))
})

/** Keep what another app shared until the page reads it, then send the window there. */
async function receiveShare(request) {
  const form = await request.formData()
  const id = crypto.randomUUID()
  const shares = await caches.open(SHARE_CACHE)
  // Only the newest share is waiting; anything older was abandoned.
  for (const key of await shares.keys()) await shares.delete(key)
  const files = form.getAll('files').filter(file => file instanceof File && file.size > 0)
  await Promise.all(files.map((file, index) => shares.put(`./__share/${id}/${String(index)}`, new Response(file, {
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
  }))))
  await shares.put(`./__share/${id}`, Response.json({
    title: form.get('title') ?? '', text: form.get('text') ?? '', url: form.get('url') ?? '', files: files.length,
  }))
  return Response.redirect(new URL(`./?share=${id}`, self.registration.scope).href, 303)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method === 'POST' && request.url === SHARE_TARGET) {
    event.respondWith(receiveShare(request))
    return
  }
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    if (request.mode === 'navigate') {
      const page = await cache.match('./index.html')
      if (page !== undefined) return page
    }
    const cached = await cache.match(request)
    if (cached !== undefined) return cached
    const response = await fetch(request)
    // Anything not filled in yet joins the cache the first time it is used; a partial body cannot be cached.
    if (response.status === 200) await cache.put(request, response.clone())
    return response
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const sessionId = event.notification.data?.sessionId
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find(client => client.focused) ?? windows[0]
    if (open === undefined) {
      await self.clients.openWindow(sessionId === undefined ? './' : `./?session=${encodeURIComponent(sessionId)}`)
      return
    }
    await open.focus()
    if (sessionId !== undefined) open.postMessage({ t: 'open-session', sessionId })
  })())
})
