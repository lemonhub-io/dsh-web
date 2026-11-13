/** The sidebar's Plugin community entry icon, distinct from the Plugins pinwheel. */

import type { ReactNode } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the discovery glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function CommunityPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconGlobeOutlineRegular size={size} />
}
