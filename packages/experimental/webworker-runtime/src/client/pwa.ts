/**
 * The installed-application half of the page: service worker lifecycle and update
 * offers, the install prompt, launches from the operating system (shortcuts and
 * shared content), hand-over to a window already running the host, storage
 * protection, connectivity notices, notifications, and the app badge.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/client/pwa
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

const LAUNCH_CHANNEL = 'dsh-web-launch'
const SHARE_CACHE = 'dsh-share'
const HANDOVER_TIMEOUT_MS = 1500
const COMPOSER_TIMEOUT_MS = 300_000
const COMPOSER_NOTICE_MS = 3000
const UPDATE_INTERVAL_MS = 60 * 60 * 1000
const UPDATE_ON_RETURN_MS = 15 * 60 * 1000
/** Longest a manual update check waits for the first install to finish. */
const FIRST_INSTALL_WAIT_MS = 90 * 1000
const INSTALL_OFFER_DELAY_MS = 45_000
const INSTALL_OFFER_MS = 20_000
/** The install offer returns after this long, at most this many times in all. */
const INSTALL_OFFER_AGAIN_MS = 14 * 24 * 60 * 60 * 1000
const INSTALL_OFFER_LIMIT = 3
/** Longest an accepted update waits for durable storage to be written before reloading. */
const RELOAD_GUARD_MS = 3000
/** Longest a starting window waits for a waiting version to say whether it took over. */
const ACTIVATE_ANSWER_MS = 2000
const NOTIFICATIONS_KEY = 'dsh-web-notifications'
/** Offers made so far, as `{ count, at }`; replaces the one-time flag below. */
const INSTALL_OFFER_KEY = 'dsh-web-install-offer'
/** The one-time flag earlier versions kept, read once to carry the offer already made. */
const INSTALL_OFFERED_KEY = 'dsh-web-install-offered'
/** Set once this browser installed the app, cleared when it offers the install again. */
const INSTALLED_KEY = 'dsh-web-installed'
const OFFLINE_TOLD_KEY = 'dsh-web-offline-told'

const COPY = {
  en: {
    update: 'A new version is ready',
    reload: 'Reload',
    later: 'Later',
    offline: 'You are offline Models cannot answer until you reconnect',
    offlineReady: 'Ready to start without a network',
    install: 'Install as an app for its own window and a faster start',
    installIos: 'Add DSH to your Home Screen for its own window In Safari, tap Share, then Add to Home Screen',
    installAction: 'Install',
    notNow: 'Not now',
    shareLost: 'What you shared did not arrive Close the app and share it again',
    composeWaiting: 'Choose a workspace to continue with what you shared',
    composeFailed: 'Could not add that to a new session Finish setup and try again',
    sentTitle: 'Sent to your open window',
    sentDetail: 'You can close this window',
  },
  zh: {
    update: '新版本已就绪',
    reload: '重新加载',
    later: '稍后',
    offline: '当前处于离线状态 恢复网络前，模型无法回复',
    offlineReady: '现在无网络也能启动',
    install: '安装为应用，使用独立窗口并更快启动',
    installIos: '添加到主屏幕即可使用独立窗口 在 Safari 中点按“分享”，再选择“添加到主屏幕”',
    installAction: '安装',
    notNow: '暂不',
    shareLost: '分享的内容没有送达 请关闭应用后重新分享',
    composeWaiting: '请选择工作区，以继续处理分享的内容',
    composeFailed: '无法添加到新会话 请完成设置后重试',
    sentTitle: '已发送到已打开的窗口',
    sentDetail: '可以关闭此窗口',
  },
}

const copy = navigator.language.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en

/** How this browser can install the app right now. */
export type InstallState = 'installed' | 'available' | 'manual-ios' | 'unavailable'

/** Whether a newer version is on its way: `downloading` while it installs, `ready` once it waits for a reload. */
export type UpdateState = 'idle' | 'downloading' | 'ready'

/** What the operating system or another window asked this page to do. */
export type LaunchIntent =
  | { readonly kind: 'new' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'compose'; readonly text: string; readonly files: readonly File[] }

/** The intents the harness UI carries out; composing stays with the page. */
export type AppLaunch = Exclude<LaunchIntent, { kind: 'compose' }>

/** Application facts and actions Settings and the attention watcher use. */
export interface WebAppBridge {
  installState(): InstallState
  subscribeInstall(listener: () => void): () => void
  install(): Promise<void>
  /** Whether every file of this version is stored; undefined without a service worker. */
  offlineReady(): Promise<boolean | undefined>
  /** Ask the host for a newer version; one found is offered as a notice. */
  checkForUpdate(): Promise<'current' | 'available' | 'unavailable'>
  updateState(): UpdateState
  subscribeUpdate(listener: () => void): () => void
  /** Switch to the waiting version; the page reloads once its storage is written. */
  applyUpdate(): void
  /** Build version of the running site; undefined without a service worker. */
  version(): Promise<string | undefined>
  storage(): Promise<{ readonly usage: number; readonly quota: number; readonly persisted: boolean } | undefined>
  protectStorage(): Promise<boolean>
  notificationState(): 'on' | 'off' | 'blocked' | 'unavailable'
  setNotifications(enabled: boolean): Promise<void>
  /** Show a notification when the person enabled them; no-op otherwise. */
  notify(title: string, body: string, sessionId: string): void
  setBadge(count: number): void
  /** Receive launches; ones that arrived earlier are delivered at once. */
  onLaunch(handler: (launch: AppLaunch) => void): () => void
}

/** Show a notice; `timeoutMs` undefined keeps it until an action or the returned remover runs. */
export type ToastFunction = (text: string, actions: readonly { readonly label: string; run(): void }[], timeoutMs?: number) => () => void

/** The browser's install event, absent from the standard DOM types. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>
}

/** The launch queue, absent from the standard DOM types. */
interface LaunchQueue {
  setConsumer(consumer: (params: { readonly targetURL?: string }) => void): void
}

function remembered(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function remember(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* A browser refusing storage just asks again later. */ }
}

function forget(key: string): void {
  try { localStorage.removeItem(key) } catch { /* Nothing was stored. */ }
}

/** Install offers made so far; a page from before the counter counts as one offer made now. */
function installOffers(): { count: number; at: number } {
  try {
    const parsed = JSON.parse(remembered(INSTALL_OFFER_KEY) ?? 'null') as { count?: unknown; at?: unknown } | null
    if (typeof parsed?.count === 'number' && typeof parsed.at === 'number') return { count: parsed.count, at: parsed.at }
  } catch { /* An unreadable record starts over. */ }
  if (remembered(INSTALL_OFFERED_KEY) === null) return { count: 0, at: 0 }
  const migrated = { count: 1, at: Date.now() }
  remember(INSTALL_OFFER_KEY, JSON.stringify(migrated))
  forget(INSTALL_OFFERED_KEY)
  return migrated
}

function recordInstallOffer(): void {
  remember(INSTALL_OFFER_KEY, JSON.stringify({ count: installOffers().count + 1, at: Date.now() }))
}

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

function isIos(): boolean {
  return /iP(hone|ad|od)/u.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** Read and remove what the service worker stored for one share. */
async function takeShare(id: string): Promise<LaunchIntent | undefined> {
  if (typeof caches === 'undefined') return undefined
  const shares = await caches.open(SHARE_CACHE)
  const metadata = await shares.match(`./__share/${id}`)
  if (metadata === undefined) return undefined
  const { title, text, url, files: count } = await metadata.json() as { title: string; text: string; url: string; files: number }
  const files: File[] = []
  for (let index = 0; index < count; index += 1) {
    const key = `./__share/${id}/${String(index)}`
    const response = await shares.match(key)
    if (response === undefined) continue
    const name = decodeURIComponent(response.headers.get('x-file-name') ?? 'shared')
    files.push(new File([await response.blob()], name, { type: response.headers.get('content-type') ?? '' }))
    await shares.delete(key)
  }
  await shares.delete(`./__share/${id}`)
  return { kind: 'compose', text: [...new Set([title, text, url].filter(part => part !== ''))].join('\n'), files }
}

/** Translate a launch URL. Shared text only ever becomes a draft, so a link cannot send anything. */
async function intentFromUrl(url: URL): Promise<LaunchIntent | undefined> {
  const share = url.searchParams.get('share')
  if (share !== null) return await takeShare(share)
  const session = url.searchParams.get('session')
  if (session !== null) return { kind: 'session', sessionId: session }
  const action = url.searchParams.get('action')
  return action === 'new' || action === 'settings' ? { kind: action } : undefined
}

/**
 * Put text and files in the composer the way pasting does, so they take the same
 * path as anything else a person adds to a draft. Nothing is sent.
 */
async function pasteIntoComposer(text: string, files: readonly File[], whileBlocked: () => () => void): Promise<boolean> {
  const started = Date.now()
  let removeNotice: (() => void) | undefined
  try {
    // A composer with no workspace stays locked and would drop the paste, so wait until it opens.
    for (;;) {
      const input = document.querySelector<HTMLElement>('[data-composer-input]')
      if (input?.isContentEditable === true) {
        input.focus()
        const data = new DataTransfer()
        // A draft already in progress keeps its own line.
        if (text !== '') data.setData('text/plain', input.textContent === '' ? text : `\n${text}`)
        for (const file of files) data.items.add(file)
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        return true
      }
      const waited = Date.now() - started
      if (waited > COMPOSER_TIMEOUT_MS) return false
      if (waited > COMPOSER_NOTICE_MS) removeNotice ??= whileBlocked()
      await new Promise(settle => setTimeout(settle, 250))
    }
  } finally {
    removeNotice?.()
  }
}

/** One page's application state; see the module description. */
export class WebApp {
  private readonly installListeners = new Set<() => void>()
  private readonly waiting: AppLaunch[] = []
  private readonly composing: Extract<LaunchIntent, { kind: 'compose' }>[] = []
  private launchedFrom: string | undefined = location.href
  private readonly updateListeners = new Set<() => void>()
  private deferredInstall: BeforeInstallPromptEvent | undefined
  private installed = isStandalone() || remembered(INSTALLED_KEY) !== null
  private registration: ServiceWorkerRegistration | undefined
  private handler: ((launch: AppLaunch) => void) | undefined
  private offeredUpdate: ServiceWorker | undefined
  /** When the person put the offered update off; it is offered again on a later return. */
  private updateDeferredAt: number | undefined
  private channel: BroadcastChannel | undefined
  private lastUpdateCheck = Date.now()
  /** Whether the harness rendered; before that, a waiting version may take over without asking. */
  private booted = false
  private reloadGuard: (() => Promise<void>) | undefined

  /** @param toast - notice surface of the page. */
  constructor(private readonly toast: ToastFunction) {}

  /** Start listening for everything that can arrive before the harness renders. */
  start(): void {
    if (isStandalone()) remember(INSTALLED_KEY, '1')
    addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault()
      this.deferredInstall = event as BeforeInstallPromptEvent
      // Browsers offer the install only while the app is not installed, so an earlier install was removed.
      if (!isStandalone()) {
        forget(INSTALLED_KEY)
        this.installed = false
      }
      this.publishInstall()
    })
    addEventListener('appinstalled', () => {
      remember(INSTALLED_KEY, '1')
      this.installed = true
      this.deferredInstall = undefined
      this.publishInstall()
      // Browsers grant durable storage to installed apps, which they may have refused a page.
      void navigator.storage?.persist?.()
    })
    matchMedia('(display-mode: standalone)').addEventListener('change', () => {
      if (isStandalone()) remember(INSTALLED_KEY, '1')
      this.installed = isStandalone() || remembered(INSTALLED_KEY) !== null
      this.publishInstall()
    })
    void navigator.storage?.persist?.()
    this.watchConnectivity()
    this.registerServiceWorker()
    ;(globalThis as { launchQueue?: LaunchQueue }).launchQueue?.setConsumer((params) => {
      void this.acceptLaunch(params)
    })
  }

  /**
   * Read the intent carried by the opening URL and clear it from the address, so a
   * reload does not repeat it.
   */
  async readOpeningIntent(): Promise<LaunchIntent | undefined> {
    const url = new URL(location.href)
    const intent = await intentFromUrl(url).catch((error: unknown) => {
      console.warn('web platform: launch unavailable', error)
      return undefined
    })
    if (['share', 'session', 'action'].some(name => url.searchParams.has(name))) {
      for (const name of ['share', 'session', 'action']) url.searchParams.delete(name)
      history.replaceState(null, '', url)
    }
    if (url.pathname.endsWith('/share-target')) this.toast(copy.shareLost, [], 8000)
    return intent
  }

  /**
   * Offer an intent to the window holding the host.
   * @returns whether that window took it.
   */
  async handOver(intent: LaunchIntent): Promise<boolean> {
    if (typeof BroadcastChannel === 'undefined') return false
    const channel = new BroadcastChannel(LAUNCH_CHANNEL)
    const id = randomUUID()
    try {
      return await new Promise<boolean>((settle) => {
        const timer = setTimeout(() => { settle(false) }, HANDOVER_TIMEOUT_MS)
        channel.onmessage = (event: MessageEvent<{ t: string; id: string }>) => {
          if (event.data.t !== 'taken' || event.data.id !== id) return
          clearTimeout(timer)
          settle(true)
        }
        channel.postMessage({ t: 'intent', id, intent })
      })
    } finally {
      channel.close()
    }
  }

  /** Copy for the window whose launch went to another window. */
  get handedOverCopy(): { readonly title: string; readonly detail: string } {
    return { title: copy.sentTitle, detail: copy.sentDetail }
  }

  /** This window holds the host: serve hand-overs and service worker requests. */
  serveLaunches(): void {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(LAUNCH_CHANNEL)
      this.channel.onmessage = (event: MessageEvent<{ t: string; id: string; intent?: LaunchIntent }>) => {
        if (event.data.t !== 'intent' || event.data.intent === undefined) return
        this.channel?.postMessage({ t: 'taken', id: event.data.id })
        this.deliver(event.data.intent)
        window.focus()
      }
    }
    navigator.serviceWorker?.addEventListener('message', (event: MessageEvent<{ t?: string; sessionId?: string }>) => {
      if (event.data.t === 'open-session' && event.data.sessionId !== undefined) {
        this.deliver({ kind: 'session', sessionId: event.data.sessionId })
      }
    })
  }

  /** Carry out one intent as soon as the harness can. */
  deliver(intent: LaunchIntent): void {
    if (intent.kind !== 'compose') {
      this.dispatch(intent)
      return
    }
    this.composing.push(intent)
    this.dispatch({ kind: 'new' })
    this.flushComposing()
  }

  /**
   * Work to finish before a reload that switches versions, such as writing durable storage.
   * @param guard - resolves when reloading is safe; a slow guard is abandoned after a few seconds.
   */
  setReloadGuard(guard: () => Promise<void>): void {
    this.reloadGuard = guard
  }

  /** The harness rendered: fill the offline cache and consider offering the install. */
  ready(): void {
    this.booted = true
    void this.fillOffline()
    setTimeout(() => { this.offerInstall() }, INSTALL_OFFER_DELAY_MS)
  }

  /** The bridge handed to Settings and the attention watcher. */
  readonly bridge: WebAppBridge = {
    installState: () => {
      if (this.installed) return 'installed'
      if (this.deferredInstall !== undefined) return 'available'
      return isIos() ? 'manual-ios' : 'unavailable'
    },
    subscribeInstall: (listener) => {
      this.installListeners.add(listener)
      return () => { this.installListeners.delete(listener) }
    },
    install: () => this.promptInstall(),
    offlineReady: async () => (await this.askWorker<{ ready: boolean }>('offline-status'))?.ready,
    checkForUpdate: async () => {
      const registration = this.registration
      if (registration === undefined) return 'unavailable'
      // During the first install the installing worker is this version, not an update: wait for it to
      // finish (bounded, since a failed install never activates) before asking the server.
      if (registration.active === null) {
        await Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(resolve, FIRST_INSTALL_WAIT_MS))])
      }
      this.lastUpdateCheck = Date.now()
      await registration.update()
      this.publishUpdate()
      if (registration.waiting !== null) {
        this.offeredUpdate = undefined
        this.offerUpdate(registration.waiting)
      }
      return this.currentUpdateState() === 'idle' ? 'current' : 'available'
    },
    updateState: () => this.currentUpdateState(),
    subscribeUpdate: (listener) => {
      this.updateListeners.add(listener)
      return () => { this.updateListeners.delete(listener) }
    },
    applyUpdate: () => { this.applyUpdate() },
    version: async () => (await this.askWorker<{ version: string }>('offline-status'))?.version,
    storage: async () => {
      if (navigator.storage?.estimate === undefined) return undefined
      const { usage = 0, quota = 0 } = await navigator.storage.estimate()
      return { usage, quota, persisted: await navigator.storage.persisted?.() === true }
    },
    protectStorage: async () => await navigator.storage?.persist?.() === true,
    notificationState: () => {
      if (typeof Notification === 'undefined' || this.registration === undefined) return 'unavailable'
      if (Notification.permission === 'denied') return 'blocked'
      return Notification.permission === 'granted' && remembered(NOTIFICATIONS_KEY) === 'on' ? 'on' : 'off'
    },
    setNotifications: async (enabled) => {
      if (enabled && await Notification.requestPermission() !== 'granted') return
      remember(NOTIFICATIONS_KEY, enabled ? 'on' : 'off')
    },
    notify: (title, body, sessionId) => {
      if (this.bridge.notificationState() !== 'on') return
      void this.registration?.showNotification(title, { body, tag: sessionId, icon: './icon-192.png', data: { sessionId } })
    },
    setBadge: (count) => {
      if (!('setAppBadge' in navigator)) return
      void (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => undefined)
    },
    onLaunch: (handler) => {
      this.handler = handler
      for (const launch of this.waiting.splice(0)) handler(launch)
      this.flushComposing()
      return () => { this.handler = undefined }
    },
  }

  private dispatch(launch: AppLaunch): void {
    if (this.handler === undefined) this.waiting.push(launch)
    else this.handler(launch)
  }

  private flushComposing(): void {
    // The new session must exist first, or the draft lands in the session being left.
    if (this.handler === undefined) return
    for (const { text, files } of this.composing.splice(0)) {
      setTimeout(() => {
        void pasteIntoComposer(text, files, () => this.toast(copy.composeWaiting, [])).then((pasted) => {
          if (!pasted) this.toast(copy.composeFailed, [], 8000)
        })
      }, 200)
    }
  }

  private async acceptLaunch(params: { readonly targetURL?: string }): Promise<void> {
    // The launch that opened this page was already read from its address.
    const opening = this.launchedFrom
    this.launchedFrom = undefined
    if (params.targetURL === undefined || params.targetURL === opening) return
    const target = new URL(params.targetURL)
    if (target.pathname.endsWith('/share-target')) {
      this.toast(copy.shareLost, [], 8000)
      return
    }
    const intent = await intentFromUrl(target)
    if (intent !== undefined) this.deliver(intent)
  }

  private publishInstall(): void {
    for (const listener of this.installListeners) listener()
  }

  private async promptInstall(): Promise<void> {
    const event = this.deferredInstall
    if (event === undefined) return
    this.deferredInstall = undefined
    await event.prompt()
    const { outcome } = await event.userChoice
    // Declining the browser's own dialog counts as declining an offer, so the notice does not follow it.
    if (outcome === 'dismissed') recordInstallOffer()
    this.publishInstall()
  }

  /**
   * Offer the install a few times, weeks apart; Settings keeps the action available throughout.
   * Safari on iPhone and iPad installs only from its Share menu, so there the offer says how.
   */
  private offerInstall(): void {
    if (this.installed) return
    const offers = installOffers()
    if (offers.count >= INSTALL_OFFER_LIMIT || Date.now() - offers.at < INSTALL_OFFER_AGAIN_MS) return
    if (this.deferredInstall !== undefined) {
      recordInstallOffer()
      this.toast(copy.install, [
        { label: copy.installAction, run: () => { void this.promptInstall() } },
        { label: copy.notNow, run: () => undefined },
      ], INSTALL_OFFER_MS)
    } else if (isIos()) {
      recordInstallOffer()
      this.toast(copy.installIos, [{ label: copy.notNow, run: () => undefined }], INSTALL_OFFER_MS)
    }
  }

  private watchConnectivity(): void {
    let remove: (() => void) | undefined
    const show = (): void => {
      remove ??= this.toast(copy.offline, [])
    }
    addEventListener('offline', show)
    addEventListener('online', () => {
      remove?.()
      remove = undefined
      this.checkForUpdateQuietly()
    })
    if (!navigator.onLine) show()
  }

  /** Registers the service worker that makes the app installable and available offline. */
  private registerServiceWorker(): void {
    if (!('serviceWorker' in navigator) || !isSecureContext) return
    // The first claim changes nothing the page loaded; every later controller is an accepted update.
    let controlled = navigator.serviceWorker.controller !== null
    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!controlled) {
        controlled = true
        return
      }
      if (reloading) return
      reloading = true
      void this.prepareReload().finally(() => { location.reload() })
    })
    navigator.serviceWorker.register('./sw.js').then((registration) => {
      this.registration = registration
      const follow = (worker: ServiceWorker | null): void => {
        worker?.addEventListener('statechange', () => {
          this.publishUpdate()
          if (worker.state === 'installed' && navigator.serviceWorker.controller !== null) this.updateArrived(worker)
        })
      }
      follow(registration.installing)
      if (registration.waiting !== null && navigator.serviceWorker.controller !== null) this.updateArrived(registration.waiting)
      registration.addEventListener('updatefound', () => {
        follow(registration.installing)
        this.publishUpdate()
      })
      this.publishUpdate()
      // An installed window can stay open for weeks without the navigation that normally finds updates.
      setInterval(() => { this.checkForUpdateQuietly() }, UPDATE_INTERVAL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (Date.now() - this.lastUpdateCheck > UPDATE_ON_RETURN_MS) this.checkForUpdateQuietly()
        // An update put off earlier comes back once the person has been away for a while.
        const waiting = registration.waiting
        if (waiting !== null && this.updateDeferredAt !== undefined && Date.now() - this.updateDeferredAt > UPDATE_ON_RETURN_MS) {
          this.updateDeferredAt = undefined
          this.offeredUpdate = undefined
          this.offerUpdate(waiting)
        }
      })
    }).catch((error: unknown) => {
      // The app works without offline support, for example on a static host without the worker file.
      console.warn('web platform: service worker unavailable', error)
    })
  }

  private checkForUpdateQuietly(): void {
    if (!navigator.onLine) return
    this.lastUpdateCheck = Date.now()
    void this.registration?.update().catch(() => undefined)
  }

  private currentUpdateState(): UpdateState {
    const registration = this.registration
    // Without a running version, an installing worker is the first install rather than an update.
    if (registration === undefined || registration.active === null) return 'idle'
    if (registration.waiting !== null) return 'ready'
    return registration.installing === null ? 'idle' : 'downloading'
  }

  private publishUpdate(): void {
    for (const listener of this.updateListeners) listener()
  }

  /**
   * A new version finished installing. Before the harness starts nothing is lost by switching, so it
   * takes over at once when this is the only window; otherwise the person is asked.
   */
  private updateArrived(worker: ServiceWorker): void {
    this.publishUpdate()
    if (this.booted) {
      this.offerUpdate(worker)
      return
    }
    void this.activateIfAlone(worker).then((activated) => {
      if (!activated) this.offerUpdate(worker)
    })
  }

  private async activateIfAlone(worker: ServiceWorker): Promise<boolean> {
    return await new Promise<boolean>((settle) => {
      const { port1, port2 } = new MessageChannel()
      const timer = setTimeout(() => { settle(false) }, ACTIVATE_ANSWER_MS)
      port1.onmessage = (event: MessageEvent<{ activated?: boolean }>) => {
        clearTimeout(timer)
        settle(event.data.activated === true)
      }
      worker.postMessage('activate-if-alone', [port2])
    })
  }

  private applyUpdate(): void {
    this.updateDeferredAt = undefined
    this.registration?.waiting?.postMessage('skip-waiting')
  }

  private async prepareReload(): Promise<void> {
    const guard = this.reloadGuard
    if (guard === undefined) return
    await Promise.race([guard(), new Promise(settle => setTimeout(settle, RELOAD_GUARD_MS))]).catch(() => undefined)
  }

  private offerUpdate(worker: ServiceWorker): void {
    if (this.offeredUpdate === worker) return
    this.offeredUpdate = worker
    this.toast(copy.update, [
      { label: copy.reload, run: () => { this.applyUpdate() } },
      { label: copy.later, run: () => { this.updateDeferredAt = Date.now() } },
    ])
  }

  private async askWorker<T>(message: string): Promise<T | undefined> {
    if (!('serviceWorker' in navigator) || this.registration === undefined) return undefined
    const worker = (await navigator.serviceWorker.ready).active
    if (worker === null) return undefined
    return await new Promise<T>((settle) => {
      const { port1, port2 } = new MessageChannel()
      port1.onmessage = (event: MessageEvent<T>) => { settle(event.data) }
      worker.postMessage(message, [port2])
    })
  }

  private async fillOffline(): Promise<void> {
    // A person on a metered connection asked for less data, so these files keep loading only when used.
    if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true) return
    const status = await this.askWorker<{ ready: boolean }>('fill-offline')
    if (status?.ready !== true || remembered(OFFLINE_TOLD_KEY) !== null) return
    remember(OFFLINE_TOLD_KEY, '1')
    this.toast(copy.offlineReady, [], 6000)
  }
}
