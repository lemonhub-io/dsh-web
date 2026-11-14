/**
 * Image layout contract shared by the packer and the worker host: the virtual
 * root, where the manifest sits inside the image, where lazy archives sit beside
 * it, and the working directories every image carries empty. One definition, two
 * consumers — the packer writes this layout, the worker host mounts it.
 */

/** Default virtual root; the runtime mounts the image here unless told otherwise. */
export const DEFAULT_ROOT = '/dsh'

/**
 * Leaf name of the packed base image: one gzip member holding the ustar archive.
 * The app build writes it beside the page and the page's boot fetches it from
 * there, so the extension is part of what a deployment serves.
 */
export const IMAGE_FILE_NAME = 'vfs-image.tar.gz'

/** Image path of the manifest the runtime reads before it wraps a single module. */
export const IMAGE_MANIFEST_PATH = 'config/vfs-manifest.json'

/**
 * Directory, relative to the base image URL, holding the lazy chunk archives:
 * `lazy/<sha256 of the archive>.tar.gz`, one page chunk each.
 */
export const IMAGE_LAZY_DIRECTORY = 'lazy'

/** Home directory under the root; the process shim's `DSH_HOME`/`HOME` default. */
export const IMAGE_HOME_DIRECTORY = 'home'

/**
 * Config fields the Worker requires on Loader rows, by row id. The packer writes them into the image's home patch
 * (`home/cordis.patch.yml`) over each row's composed config: the Worker carries no Zstandard codec, so JSONL Session
 * logs stay plaintext.
 */
export const PLATFORM_ENTRY_CONFIG: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // The browser shell runs no programs, so cloud development tells the model to run all code in the cloud.
  'cloud-dev': { workspace: 'browser' },
  'session-persistence-jsonl': { compression: 'none' },
  'ui-settings-account': { loginEnabled: false },
  // A Worker has no operating system to ask for a Documents folder, and every workspace belongs in durable storage.
  'workspace-controller': { documentsDirectory: `${DEFAULT_ROOT}/workspace` },
}

/**
 * Loader rows the image's home patch disables: telemetry exporters, and features that need a Node Host and only
 * report a refusal in the Worker. Each costs boot time, and a visible one offers something that cannot work.
 */
export const PLATFORM_DISABLED_ENTRIES: readonly string[] = [
  'otel', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics',
  'llm-pi-ai', 'open-in-app', 'ui-open-in-app', 'office-to-pdf',
  'deepseek-account', 'account-controller', 'llm-deepseek-account',
]

/**
 * Rows removed from every Agent preset: the Worker cannot run PTC Node programs, so a preset composing them would
 * offer the model a tool that always fails. Disabling the provider instead leaves the preset's consumers waiting.
 */
export const PLATFORM_PRESET_REMOVED_ROWS: readonly string[] = ['workflow-ptc', 'tool-workflow']

/** Working directories the host tree expects to exist, empty. */
export const IMAGE_EMPTY_DIRECTORIES: readonly string[] = ['home/', 'workspace/', 'tmp/']

/**
 * Top-level directories an overlay archive may populate. Runtime code,
 * configuration, and the lowering manifest remain owned by the base image.
 */
export const IMAGE_OVERLAY_DIRECTORIES: readonly string[] = ['home', 'workspace']

/**
 * Identity of the lowered code shape, recorded in the image manifest by the
 * packer and required by the worker host: an image lowered by an older transform
 * would otherwise run against newer wrapper semantics. Bump on any change to
 * emitted code or to {@link WRAPPER_PARAMS}.
 */
export const LOWERING_VERSION = 'dsh-worker-transform/1'

/**
 * Free variables a lowered body expects from its wrapper, in order.
 *
 * Part of the image layout rather than of the transform, because the loader
 * wraps bodies it never parses: the packer emits against these names and the
 * worker binds them, with no compiler in the worker bundle to agree with.
 */
export const WRAPPER_PARAMS = [
  'exports', 'require', 'module', '__filename', '__dirname', '__dsh$meta', '__als',
] as const
