/** Sidebar glyph for cloud development: a cloud carrying an upward arrow. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the cloud glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share.
 * @returns the icon element.
 */
export function CloudPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 18.5h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.4 9.1 4.75 4.75 0 0 0 7 18.5Z" />
      <path d="M12 16v-5.5M9.75 12.5 12 10.25l2.25 2.25" />
    </svg>
  )
}
