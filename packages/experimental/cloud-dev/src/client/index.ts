/** Browser entry: the cloud development panel and its sidebar entry over the cloudDev Remote. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import remote from '@deepseek-ai/dsh-experimental-cloud-dev/remote'
import { CloudPage, CloudPanelError, type CloudDevFace } from './CloudPage.tsx'
import { CloudPanelIcon } from './CloudPanelIcon.tsx'
import { en, NS, zh, type CloudDevKey } from './locales.ts'

export { CloudPanelError } from './CloudPage.tsx'
export type { CloudDevFace, CloudPageProps } from './CloudPage.tsx'
export type { CloudDevKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { cloudDev: CloudDevKey }
}

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale']
/** Main panel id and sidebar entry id. */
export const PANEL_ID = 'cloud-dev' as MainPanelId

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'cloud-dev: dictionaries')
  const t = ctx.locale.bind(NS)
  const service = ctx.remote.cloudDev
  const unwrap = <T>(result: RemoteResult<T>): T => {
    if (result.ok) return result.value
    throw new CloudPanelError(
      result.error.message,
      result.error.code === 'cloudDev/failed' ? result.error.details.problem : undefined,
    )
  }
  const face: CloudDevFace = {
    status: async () => unwrap(await service.status()),
    connect: async request => unwrap(await service.connect(request)),
    disconnect: async () => unwrap(await service.disconnect()),
    jobs: async () => unwrap(await service.jobs()),
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => face }, CloudPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 2, label: () => t('title'), locale: NS }, CloudPanelIcon))
}

/**
 * Mount the cloudDev Remote, then the panel once the Remote is served.
 * @param ctx - browser plugin context.
 * @returns disposer withdrawing the UI before the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(remote)
  const ui = ctx.inject(['remote.cloudDev', 'slots', 'locale', 'layout'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await unmountRemote(); throw error }
  return async () => { await ui.dispose(); await unmountRemote() }
}
