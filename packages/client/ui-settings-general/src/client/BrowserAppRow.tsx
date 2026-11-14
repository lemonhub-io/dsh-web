/** General Settings controls for the installed web application: install, updates, storage, notifications. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { browserDataBridge } from './BrowserDataRow.tsx'
import css from './BrowserDataRow.module.css'

const GIGABYTE = 1_000_000_000

function formatBytes(bytes: number): string {
  const format = (unit: 'gigabyte' | 'megabyte', value: number, digits: number): string =>
    new Intl.NumberFormat(undefined, { style: 'unit', unit, maximumFractionDigits: digits }).format(value)
  return bytes >= GIGABYTE ? format('gigabyte', bytes / GIGABYTE, 1) : format('megabyte', bytes / 1_000_000, 0)
}

/**
 * Render the application rows.
 * @param props - localized copy.
 * @returns The rows, or nothing on a Node-hosted page.
 */
export function BrowserAppRow({ t }: PropsRuntime<'settings.general.item'> & PropsLocale<'settings'>) {
  const app = browserDataBridge()?.app
  const install = useSyncExternalStore(
    listener => app?.subscribeInstall(listener) ?? (() => undefined),
    () => app?.installState(),
  )
  const [offline, setOffline] = useState<boolean>()
  const [update, setUpdate] = useState<'current' | 'available'>()
  const [storage, setStorage] = useState<Awaited<ReturnType<NonNullable<typeof app>['storage']>>>()
  const [refused, setRefused] = useState(false)
  const [notifications, setNotifications] = useState(() => app?.notificationState())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (app === undefined) return
    void app.offlineReady().then(setOffline, () => undefined)
    void app.storage().then(setStorage, () => undefined)
  }, [app])

  if (app === undefined) return null
  const run = (action: () => Promise<void>): void => {
    setBusy(true)
    void action().catch(() => undefined).finally(() => { setBusy(false) })
  }
  const installCopy = install === 'installed' ? 'webApp.installed'
    : install === 'available' ? 'webApp.available'
      : install === 'manual-ios' ? 'webApp.ios' : 'webApp.unavailable'
  return <div className={css.section}>
    <div className={css.row}>
      <div>
        <div className={css.title}>{t('webApp.title')}</div>
        <div className={css.description}>{t(installCopy)}</div>
        {offline !== undefined && <div className={css.description}>{t(offline ? 'webApp.offlineReady' : 'webApp.offlinePreparing')}</div>}
        {update !== undefined && <div role="status" className={css.description}>{t(update === 'current' ? 'webApp.current' : 'webApp.updateAvailable')}</div>}
      </div>
      <div className={css.actions}>
        {install === 'available' && <Button variant="outline" size="sm" disabled={busy} onClick={() => { run(() => app.install()) }}>{t('webApp.install')}</Button>}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => {
          run(async () => {
            const result = await app.checkForUpdate()
            if (result !== 'unavailable') setUpdate(result)
            // The check waits for a first install to finish, so offline readiness may have changed.
            setOffline(await app.offlineReady())
          })
        }}>{t('webApp.check')}</Button>
      </div>
    </div>
    {storage !== undefined && <div className={css.row}>
      <div>
        <div className={css.title}>{t('webApp.storageTitle')}</div>
        <div className={css.description}>{t('webApp.storageUsage', { used: formatBytes(storage.usage), quota: formatBytes(storage.quota) })}</div>
        <div className={css.description}>{t(storage.persisted ? 'webApp.storageProtected' : refused ? 'webApp.protectRefused' : 'webApp.storageUnprotected')}</div>
      </div>
      {!storage.persisted && <Button variant="outline" size="sm" disabled={busy} onClick={() => {
        run(async () => {
          setRefused(!await app.protectStorage())
          setStorage(await app.storage())
        })
      }}>{t('webApp.protect')}</Button>}
    </div>}
    {notifications !== undefined && notifications !== 'unavailable' && <div className={css.row}>
      <div>
        <div className={css.title}>{t('webApp.notifyTitle')}</div>
        <div className={css.description}>{t(notifications === 'blocked' ? 'webApp.notifyBlocked' : 'webApp.notifyDescription')}</div>
      </div>
      {notifications !== 'blocked' && <Button variant="outline" size="sm" disabled={busy} onClick={() => {
        run(async () => {
          await app.setNotifications(notifications === 'off')
          setNotifications(app.notificationState())
        })
      }}>{t(notifications === 'on' ? 'webApp.notifyOff' : 'webApp.notifyOn')}</Button>}
    </div>}
  </div>
}
