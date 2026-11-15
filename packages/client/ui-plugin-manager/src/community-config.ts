/** Shared Host and Client configuration for the plugin community backend. */
import z from '@deepseek-ai/schemastery'

/** HTTPS backend URL validated before the community is mounted. */
export const communityBackendUrl = z.string()
  .pattern(/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^?#\s]*)?$/)
  .default('https://dsh-community.openhub.today')

/** Resolved client configuration shared with the Host configuration fields. */
export interface CommunityConfig {
  /** Worker serving public GitHub discovery and immutable source reads. */
  communityBackendUrl: string
}
