/**
 * Harness half of the installed web application: carries out launches from the
 * operating system and tells the person when a Session needs them while the app is
 * in the background, through notifications and the app badge.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** A launch the page hands to the harness UI. */
export type WebAppLaunch =
  | { readonly kind: 'new' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'session'; readonly sessionId: string }

/** The application surface of the page's platform layer. */
export interface WebAppBridge {
  installState(): 'installed' | 'available' | 'manual-ios' | 'unavailable'
  subscribeInstall(listener: () => void): () => void
  install(): Promise<void>
  offlineReady(): Promise<boolean | undefined>
  checkForUpdate(): Promise<'current' | 'available' | 'unavailable'>
  updateState(): 'idle' | 'downloading' | 'ready'
  subscribeUpdate(listener: () => void): () => void
  applyUpdate(): void
  version(): Promise<string | undefined>
  storage(): Promise<{ readonly usage: number; readonly quota: number; readonly persisted: boolean } | undefined>
  protectStorage(): Promise<boolean>
  notificationState(): 'on' | 'off' | 'blocked' | 'unavailable'
  setNotifications(enabled: boolean): Promise<void>
  notify(title: string, body: string, sessionId: string): void
  setBadge(count: number): void
  onLaunch(handler: (launch: WebAppLaunch) => void): () => void
}

/** The Session facts attention follows, typed structurally for the same reason as the bridge. */
interface AttentionStatus {
  readonly running: boolean | undefined
  readonly pendingInteraction: unknown
  readonly completionUnread: boolean
}

/** The harness services the application layer drives. */
export interface WebAppServices {
  readonly sessionStatus: ObservableSnapshot<ReadonlyMap<string, AttentionStatus>>
  readonly sessionList: ObservableSnapshot<{
    readonly byId: Readonly<Record<string, { readonly title?: string | null; readonly subagent?: unknown } | undefined>>
  }>
  readonly workspace: {
    startSession(): void
    openSession(sessionId: string): void
  }
  t(key: 'webApp.finished' | 'webApp.needsYou' | 'webApp.untitled'): string
  openSettings(): void
}

function isAway(): boolean {
  return document.visibilityState === 'hidden' || !document.hasFocus()
}

/**
 * Serve launches and watch for Sessions that need the person.
 * @param app - the page's application surface.
 * @param services - harness services.
 * @returns disposer.
 */
export function serveWebApp(app: WebAppBridge, services: WebAppServices): () => void {
  const stopLaunches = app.onLaunch((launch) => {
    if (launch.kind === 'new') services.workspace.startSession()
    else if (launch.kind === 'settings') services.openSettings()
    else services.workspace.openSession(launch.sessionId)
  })

  // Sessions that finished unseen. The harness marks only those outside the main
  // view as unread, but the main view is also unseen while the window is away.
  const unseen = new Set<string>()
  let previous = services.sessionStatus.getSnapshot()

  const publishBadge = (): void => {
    let count = 0
    for (const [id, status] of services.sessionStatus.getSnapshot()) {
      if (status.pendingInteraction !== undefined || status.completionUnread || unseen.has(id)) count += 1
    }
    app.setBadge(count)
  }

  const observe = (): void => {
    const current = services.sessionStatus.getSnapshot()
    const { byId } = services.sessionList.getSnapshot()
    for (const [id, status] of current) {
      const entry = byId[id]
      // A subagent reports through its parent Session, which is the one the person follows.
      if (entry === undefined || (entry.subagent !== undefined && entry.subagent !== null)) continue
      const before = previous.get(id)
      const title = entry.title ?? services.t('webApp.untitled')
      if (status.pendingInteraction !== undefined && before?.pendingInteraction === undefined) {
        if (isAway()) app.notify(services.t('webApp.needsYou'), title, id)
      } else if (before?.running === true && status.running === false && status.pendingInteraction === undefined && isAway()) {
        unseen.add(id)
        app.notify(services.t('webApp.finished'), title, id)
      }
    }
    previous = current
    publishBadge()
  }

  const returned = (): void => {
    if (isAway()) return
    unseen.clear()
    publishBadge()
  }

  const stopStatus = services.sessionStatus.subscribe(observe)
  document.addEventListener('visibilitychange', returned)
  addEventListener('focus', returned)
  publishBadge()
  return () => {
    stopLaunches()
    stopStatus()
    document.removeEventListener('visibilitychange', returned)
    removeEventListener('focus', returned)
    app.setBadge(0)
  }
}
