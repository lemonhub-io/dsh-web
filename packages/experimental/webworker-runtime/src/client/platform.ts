/**
 * The page half of the Web platform: everything between opening the URL and the
 * harness answering. It keeps one host per origin across tabs, shows boot progress,
 * asks for workspace names on the host's behalf, and starts the installed
 * application layer ({@link WebApp}). The harness itself still starts through {@link connectWorkerHost}.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/client/platform
 */

import type { HostToPageFrame, PageToHostFrame, PlatformRequest, PlatformStatus } from '../platform/protocol.ts'
import { connectWorkerHost, holdWorkerHostBoot } from './index.ts'
import { WebApp, type LaunchIntent, type ToastFunction, type WebAppBridge } from './pwa.ts'

const HOST_LOCK = 'dsh-web-host'
/** Held handles to host folders in earlier versions; nothing reads it any more. */
const RETIRED_FOLDER_DATABASE = 'dsh-web'

const COPY = {
  en: {
    starting: 'Starting',
    downloading: 'Downloading the runtime',
    restoring: 'Restoring your data',
    booting: 'Starting the agent',
    failed: 'Could not start',
    retry: 'Try again',
    otherTab: 'Already open in another tab',
    otherTabDetail: 'One tab at a time can use your data here',
    useHere: 'Use this tab',
    movedTab: 'Moved to another tab',
    reload: 'Reload',
    nameTitle: 'New workspace',
    nameDetail: 'Workspaces are kept in this browser\'s private storage A name that already exists opens that workspace',
    nameLabel: 'Workspace name',
    create: 'Create',
    cancel: 'Cancel',
    storageFailed: (message: string) => `Your data is no longer being saved: ${message}`,
  },
  zh: {
    starting: '正在启动',
    downloading: '正在下载运行环境',
    restoring: '正在恢复你的数据',
    booting: '正在启动智能体',
    failed: '启动失败',
    retry: '重试',
    otherTab: '已在其他标签页打开',
    otherTabDetail: '同一时间只有一个标签页可以使用这里的数据',
    useHere: '在此标签页使用',
    movedTab: '已转到其他标签页',
    reload: '重新加载',
    nameTitle: '新建工作区',
    nameDetail: '工作区保存在此浏览器的私有存储中 如果名称已存在，则打开该工作区',
    nameLabel: '工作区名称',
    create: '创建',
    cancel: '取消',
    storageFailed: (message: string) => `数据已停止保存：${message}`,
  },
}

const copy = navigator.language.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en

const STYLE = `
  [data-dsh-web-boot] {
    --boot-bg: #fff; --boot-fg: #0f1115; --boot-muted: #6b7280; --boot-line: rgb(0 0 0 / 10%); --boot-accent: #4d6bfe;
    position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
    padding: 24px; box-sizing: border-box; color: var(--boot-fg); background: var(--boot-bg);
    font: 14px/22px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    [data-dsh-web-boot] { --boot-bg: #15171a; --boot-fg: #f2f3f5; --boot-muted: #9ca3af; --boot-line: rgb(255 255 255 / 12%); }
  }
  [data-dsh-web-boot] > div { width: min(360px, 100%); }
  [data-dsh-web-boot] h1 { margin: 0 0 6px; font-size: 16px; line-height: 24px; font-weight: 600; }
  [data-dsh-web-boot] p { margin: 0 0 16px; color: var(--boot-muted); overflow-wrap: anywhere; }
  [data-dsh-web-boot] ul { margin: 0 0 16px; padding: 0; list-style: none; }
  [data-dsh-web-boot] li { padding: 6px 0; border-top: 1px solid var(--boot-line); overflow-wrap: anywhere; }
  [data-dsh-web-boot] [role=progressbar] { height: 4px; border-radius: 2px; overflow: hidden; background: var(--boot-line); }
  [data-dsh-web-boot] [role=progressbar] > i { display: block; height: 100%; width: 100%; transform-origin: left; background: var(--boot-accent); transition: transform 120ms linear; }
  [data-dsh-web-boot] [role=progressbar][data-indeterminate] > i { animation: dsh-boot-slide 1.2s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { [data-dsh-web-boot] [role=progressbar][data-indeterminate] > i { animation: none; } }
  @keyframes dsh-boot-slide { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  [data-dsh-web-boot] input {
    display: block; width: 100%; min-height: 40px; margin: 0 0 16px; padding: 0 12px; box-sizing: border-box; border: 1px solid var(--boot-line);
    border-radius: 8px; color: inherit; background: transparent; font: inherit;
  }
  [data-dsh-web-boot] input:focus-visible { outline: 2px solid #4d6bfe; outline-offset: 1px; }
  [data-dsh-web-boot] button, [data-dsh-toast] button {
    min-height: 40px; margin: 0 8px 0 0; padding: 0 16px; border: 1px solid var(--boot-line, rgb(128 128 128 / 40%));
    border-radius: 8px; color: inherit; background: transparent; font: inherit; cursor: pointer;
  }
  [data-dsh-web-boot] button[data-primary] { border-color: var(--boot-accent); color: #fff; background: var(--boot-accent); }
  [data-dsh-web-boot] button:focus-visible, [data-dsh-toast] button:focus-visible { outline: 2px solid #4d6bfe; outline-offset: 2px; }
  [data-dsh-toasts] {
    position: fixed; left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); z-index: 2147483001; display: flex; flex-direction: column; align-items: center; gap: 8px;
    width: max-content; max-width: calc(100vw - 32px); transform: translateX(-50%);
  }
  [data-dsh-toast] {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px; box-sizing: border-box; border-radius: 10px;
    color: #fff; background: #23262b; box-shadow: 0 6px 24px rgb(0 0 0 / 24%);
    font: 14px/20px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  [data-dsh-toast] button { min-height: 32px; margin: 0; padding: 0 12px; border-color: rgb(255 255 255 / 30%); }
`

/** One action button of a boot screen. */
interface ScreenAction {
  readonly label: string
  readonly primary?: boolean
  run(): void
}

/** The full-page surface shown until the harness renders. */
class BootScreen {
  private readonly root = document.createElement('div')
  private bar: HTMLElement | undefined

  constructor() {
    if (document.querySelector('style[data-dsh-web-boot-style]') === null) {
      const style = document.createElement('style')
      style.dataset.dshWebBootStyle = ''
      style.textContent = STYLE
      document.head.append(style)
    }
    this.root.dataset.dshWebBoot = ''
    document.body.append(this.root)
  }

  /** Show a titled message with optional list and actions. */
  message(title: string, detail: string, actions: readonly ScreenAction[], items: readonly string[] = []): void {
    this.bar = undefined
    const panel = document.createElement('div')
    const heading = document.createElement('h1')
    heading.textContent = title
    const text = document.createElement('p')
    text.textContent = detail
    panel.append(heading, text)
    if (items.length > 0) {
      const list = document.createElement('ul')
      for (const item of items) {
        const row = document.createElement('li')
        row.textContent = item
        list.append(row)
      }
      panel.append(list)
    }
    for (const action of actions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = action.label
      if (action.primary === true) button.dataset.primary = ''
      button.addEventListener('click', () => { action.run() })
      panel.append(button)
    }
    this.root.replaceChildren(panel)
  }

  /**
   * Ask for one line of text.
   * @returns What was entered, or null when the person cancels.
   */
  async ask(title: string, detail: string, label: string, confirm: string, cancel: string): Promise<string | null> {
    return await new Promise((settle) => {
      this.message(title, detail, [
        { label: confirm, primary: true, run: () => { submit() } },
        { label: cancel, run: () => { settle(null) } },
      ])
      const panel = this.root.firstElementChild as HTMLElement
      const input = document.createElement('input')
      input.setAttribute('aria-label', label)
      input.autocomplete = 'off'
      const submit = (): void => {
        if (input.value.trim() !== '') settle(input.value)
      }
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit()
        else if (event.key === 'Escape') settle(null)
      })
      panel.querySelector('p')?.after(input)
      input.focus()
    })
  }

  /** Show boot progress; `fraction` is undefined when the amount is unknown. */
  progress(label: string, fraction?: number): void {
    if (this.bar === undefined) {
      const panel = document.createElement('div')
      const heading = document.createElement('h1')
      heading.textContent = copy.starting
      const text = document.createElement('p')
      const bar = document.createElement('div')
      bar.setAttribute('role', 'progressbar')
      bar.append(document.createElement('i'))
      panel.append(heading, text, bar)
      this.root.replaceChildren(panel)
      this.bar = bar
    }
    const bar = this.bar
    const text = bar.previousElementSibling as HTMLElement
    text.textContent = label
    bar.setAttribute('aria-label', label)
    const fill = bar.firstElementChild as HTMLElement
    if (fraction === undefined) {
      bar.dataset.indeterminate = ''
      bar.removeAttribute('aria-valuenow')
      fill.style.transform = ''
    } else {
      delete bar.dataset.indeterminate
      bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)))
      fill.style.transform = `scaleX(${String(fraction)})`
    }
  }

  /** Remove the surface; the harness has rendered. */
  close(): void {
    this.root.remove()
  }
}

/** Show a notice above the harness; it stays until an action, a timeout, or the returned remover. */
const toast: ToastFunction = (text, actions, timeoutMs) => {
  let stack = document.querySelector<HTMLElement>('[data-dsh-toasts]')
  if (stack === null) {
    stack = document.createElement('div')
    stack.dataset.dshToasts = ''
    document.body.append(stack)
  }
  const node = document.createElement('div')
  node.dataset.dshToast = ''
  node.setAttribute('role', 'status')
  node.append(text)
  for (const action of actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = action.label
    button.addEventListener('click', () => {
      node.remove()
      action.run()
    })
    node.append(button)
  }
  stack.append(node)
  const remove = (): void => { node.remove() }
  if (timeoutMs !== undefined) setTimeout(remove, timeoutMs)
  return remove
}

/** Name a new workspace for the host, over everything else on the page. */
async function answerWorkspaceRequest(id: number, port: MessagePort): Promise<void> {
  const screen = new BootScreen()
  const name = await screen.ask(copy.nameTitle, copy.nameDetail, copy.nameLabel, copy.create, copy.cancel)
  screen.close()
  port.postMessage((name === null ? { t: 'named-nothing', id } : { t: 'named-workspace', id, name }) satisfies PageToHostFrame)
}

/** What Settings and other page surfaces can ask of the platform layer. */
export interface WebPlatformBridge {
  status(): Promise<PlatformStatus>
  /** Download a backup of home and workspace data. */
  exportData(): Promise<Uint8Array>
  /** Restore a backup and restart. */
  importData(archive: Uint8Array): Promise<void>
  /** Erase home and workspace data and restart. */
  resetData(): Promise<void>
  /** The installed-application surface. */
  readonly app: WebAppBridge
}

function startBridge(port: MessagePort, app: WebAppBridge): {
  bridge: WebPlatformBridge
  flush(): Promise<void>
  settleReply(frame: Extract<HostToPageFrame, { t: 'reply' }>): void
} {
  const pending = new Map<number, { settle(value: unknown): void; fail(reason: Error): void }>()
  let nextId = 0
  const request = async (operation: PlatformRequest, transfer: Transferable[] = []): Promise<unknown> => {
    nextId += 1
    const id = nextId
    return await new Promise((settle, fail) => {
      pending.set(id, { settle, fail })
      port.postMessage({ t: 'request', id, ...operation } satisfies PageToHostFrame, transfer)
    })
  }
  return {
    bridge: {
      app,
      status: async () => await request({ op: 'status' }) as PlatformStatus,
      exportData: async () => await request({ op: 'export' }) as Uint8Array,
      importData: async (archive) => {
        await request({ op: 'import', archive }, [archive.buffer as ArrayBuffer])
        location.reload()
      },
      resetData: async () => {
        await request({ op: 'reset' })
        location.reload()
      },
    },
    flush: async () => { await request({ op: 'flush' }) },
    settleReply: (frame) => {
      const waiter = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.failure === undefined) waiter?.settle(frame.value)
      else waiter?.fail(new Error(frame.failure))
    },
  }
}

/**
 * Hold the single-host lock for this tab's lifetime, asking first when another tab has it.
 * A launch that opened this window goes to the tab holding the lock instead of taking it.
 * @returns the opening intent, unless the tab holding the lock took it.
 */
async function acquireHostLock(
  screen: BootScreen,
  app: WebApp,
  opening: LaunchIntent | undefined,
  onLost: () => void,
): Promise<LaunchIntent | undefined> {
  if (!('locks' in navigator)) return opening
  const hold = (options: LockOptions): Promise<boolean> => new Promise((acquired, failed) => {
    navigator.locks.request(HOST_LOCK, options, async (lock) => {
      acquired(lock !== null)
      if (lock !== null) await new Promise(() => {})
    }).catch((error: unknown) => {
      // A later tab stole the lock; before acquisition this is a real failure.
      failed(error)
      onLost()
    })
  })
  if (await hold({ ifAvailable: true })) return opening
  const handedOver = opening !== undefined && await app.handOver(opening)
  if (handedOver) window.close()
  await new Promise<void>((settle) => {
    const { title, detail } = handedOver ? app.handedOverCopy : { title: copy.otherTab, detail: copy.otherTabDetail }
    screen.message(title, detail, [{
      label: copy.useHere,
      primary: true,
      run: () => {
        screen.progress(copy.booting)
        void hold({ steal: true }).then(() => { settle() })
      },
    }])
  })
  return handedOver ? undefined : opening
}

/** Inputs for {@link startWebPlatform}. */
export interface WebPlatformOptions {
  /** Base VFS image URL. */
  readonly image: string
  /** Constructs the host worker, so the page's bundler resolves its URL. */
  createWorker(): Worker
}

/**
 * Start the harness in this page.
 * @param options - Image location and worker constructor.
 * @returns Resolves when the host serves the page; failures are shown on the boot screen and rethrown.
 */
export async function startWebPlatform(options: WebPlatformOptions): Promise<void> {
  holdWorkerHostBoot()
  const screen = new BootScreen()
  screen.progress(copy.starting)
  const app = new WebApp(toast)
  app.start()
  const opening = await app.readOpeningIntent()
  let worker: Worker | undefined
  try {
    const intent = await acquireHostLock(screen, app, opening, () => {
      worker?.terminate()
      screen.close()
      new BootScreen().message(copy.movedTab, '', [{ label: copy.reload, primary: true, run: () => { location.reload() } }])
    })
    app.serveLaunches()
    if (intent !== undefined) app.deliver(intent)
    // Drops the access earlier versions kept to host folders, along with the handles.
    if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(RETIRED_FOLDER_DATABASE)
    const channel = new MessageChannel()
    const { port1: port, port2: remote } = channel
    const { bridge, flush, settleReply } = startBridge(port, app.bridge)
    // Switching versions reloads the page, so durable storage is written first.
    app.setReloadGuard(flush)
    ;(globalThis as { __DSH_WEB_PLATFORM__?: WebPlatformBridge }).__DSH_WEB_PLATFORM__ = bridge
    port.onmessage = (event: MessageEvent<HostToPageFrame>) => {
      const frame = event.data
      switch (frame.t) {
        case 'progress':
          if (frame.stage === 'download') screen.progress(copy.downloading, frame.total === undefined || frame.loaded === undefined ? undefined : Math.min(frame.loaded / frame.total, 1))
          else if (frame.stage === 'restore') screen.progress(copy.restoring)
          else if (frame.stage === 'start') screen.progress(copy.booting)
          return
        case 'name-workspace':
          void answerWorkspaceRequest(frame.id, port)
          return
        case 'storage-failure':
          toast(copy.storageFailed(frame.message), [], 6000)
          return
        case 'reply':
          settleReply(frame)
          return
        default:
          console.warn('web platform: unknown host frame', frame)
      }
    }
    worker = options.createWorker()
    worker.postMessage({ t: 'platform-init', port: remote }, [remote])
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') port.postMessage({ t: 'request', id: 0, op: 'flush' } satisfies PageToHostFrame)
    })
    await connectWorkerHost(worker, {
      image: options.image,
      overlays: [],
      localizeSourceMaps: new URLSearchParams(location.search).has('debug-source-maps'),
    })
    screen.close()
    app.ready()
  } catch (reason) {
    worker?.terminate()
    screen.message(copy.failed, reason instanceof Error ? reason.message : String(reason), [
      { label: copy.retry, primary: true, run: () => { location.reload() } },
    ])
    throw reason
  }
}
