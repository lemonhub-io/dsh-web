/** Preinstalled plugin community: GitHub discovery and installation through the shared plugin manager. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { CommunityPage, type CommunityFace } from './CommunityPage.tsx'
import { communityEn, communityZh } from './community-locales.ts'
import { PluginsPanelIcon } from './PluginsPanelIcon.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin community labels and installation refusals. */
    pluginCommunity: keyof typeof communityZh
  }
}

/** Built-in plugin identity visible in the client plugin tree. */
export const name = 'plugin-community'
/** Services needed independently of native profile installation access. */
export const inject = ['slots', 'locale', 'layout', 'remote', 'remote.pluginManager']

/**
 * Register the community as a separate main panel and sidebar entry.
 * @param ctx Owning browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('pluginCommunity', { en: communityEn, zh: communityZh }), 'plugin-community: dictionaries')
  const panel = 'plugin-community' as MainPanelId
  const t = ctx.locale.bind('pluginCommunity')
  const manager = ctx.remote.pluginManager
  const unwrap = <T>(result: RemoteResult<T>): T => { if (!result.ok) throw result.error; return result.value }
  const face: CommunityFace = {
    policy: async () => unwrap(await manager.webBundlePolicy()),
    list: async () => unwrap(await manager.listBundles()),
    inspect: async (encoded: string) => unwrap(await manager.inspectWebBundle(encoded)),
    install: async (encoded: string, trusted: boolean) => unwrap(await manager.importWebBundle(encoded, trusted)),
    // The Plugins panel provides navigation only while the profile may be managed.
    openManager: () => { ctx.get('pluginNavigation')?.openList() },
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel, locale: 'pluginCommunity', inject: () => face }, CommunityPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panel, order: 1, label: () => t('title'), locale: 'pluginCommunity' }, PluginsPanelIcon))
}
