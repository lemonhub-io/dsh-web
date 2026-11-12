/** Browser-safe declarations for ordinary Web package distributions. */
/** Deployment limits applied before any package code is evaluated. */
export interface WebPackageLimits {
  archiveBytes: number
  expandedBytes: number
  files: number
}
/** Platform provider for the ordinary profile package installer. */
export interface WebPackageRuntime {
  readonly lowering: string
  readonly capabilities: readonly string[]
  /** Decode a bounded npm archive and prepare built JavaScript without evaluating it.
   * @param bytes Complete gzip tar bytes.
   * @param limits Compressed expanded and entry limits.
   * @returns Package-relative immutable file views.
   */
  unpack(bytes: Uint8Array, limits: WebPackageLimits): Promise<Record<string, Uint8Array>>
  /** Resolve declared static module requests without evaluating source.
   * @param directory Staged package directory.
   * @param modules Package-relative files and their static imports.
   */
  validate(directory: string, modules: Readonly<Record<string, readonly string[]>>): void
  /** Release cached package modules after all Cordis consumers stop.
   * @param directory Removed package directory.
   */
  invalidate(directory: string): void
  /** Wait for browser storage to persist every preceding filesystem mutation.
   * @returns Persistence acknowledgement or a storage failure.
   */
  flush(): Promise<void>
}
/** Readable preflight result shared by every installation entry. */
export interface WebBundleInspection {
  name: string
  version: string
  description: string
  compatible: boolean
  problem?: string
  requires: string[]
}
