/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import { FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Longest fade-out animation plus its delay and a margin; the copy is removed by then at the latest. */
const OUTRO_MS = 700
/** Frames to wait for the renderer to replace the page before dissolving anyway (about 8s at 60Hz). */
const HANDOFF_WAIT_FRAMES = 480

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Create an SVG element with attributes. */
function svg(tag: string, attributes: Readonly<Record<string, string>>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
  return el
}

/** Build the self-drawing whale: an outline path that draws itself over a fill path that fades in. */
function mark(): SVGElement {
  const root = svg('svg', {
    class: css.mark ?? '',
    viewBox: `0 0 ${String(FISH_LOGO_VIEWBOX.width)} ${String(FISH_LOGO_VIEWBOX.height)}`,
    'aria-hidden': 'true',
  })
  root.append(
    svg('path', { d: FISH_LOGO_PATH, class: css.markFill ?? '' }),
    svg('path', { d: FISH_LOGO_PATH, class: css.markStroke ?? '', pathLength: '1' }),
  )
  return root
}

/** The handoff copy, its pending frame, and its removal fallback once the dissolve plays. */
interface Outro {
  readonly element: HTMLElement
  frame: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly mark: SVGElement
  private readonly wordmark: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly progress: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined
  private outro: Outro | undefined

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.mark = mark()
    this.wordmark = div(css.wordmark, 'DSH')
    this.status = div(css.status)
    this.progress = div(css.progress)
    this.progress.dataset.dshBootProgress = ''
    this.progress.setAttribute('role', 'progressbar')
    this.progress.append(document.createElement('i'))
    const hint = div(css.hint, 'Loading plugins…')
    this.progress.setAttribute('aria-label', hint.textContent ?? '')
    this.status.append(hint, this.progress)
    this.card.append(this.mark, this.wordmark, this.status)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
  }

  /**
   * Set the number of loader entries represented by the progress bar.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /**
   * Fade the page out over the application the renderer is mounting. A copy
   * of the page is laid over the document, so the original stays in the
   * mount point for the renderer's hydration handoff. The copy holds still
   * until the renderer has replaced the original (or a frame budget runs
   * out), waits one more frame so the application paints beneath it, then
   * plays its fade-out and is removed when that ends. Hidden documents run
   * no frames, so a backgrounded boot dissolves when it is shown again. The
   * copy takes no pointer events.
   */
  handoff(): void {
    if (this.outro !== undefined || this.failure !== undefined) return
    const element = this.root.cloneNode(true) as HTMLElement
    delete element.dataset.dshBoot
    if (css.outro !== undefined) element.classList.add(css.outro)
    element.setAttribute('aria-hidden', 'true')
    this.root.ownerDocument.body.append(element)
    const outro: Outro = { element, frame: 0, timer: undefined }
    this.outro = outro
    const play = (): void => {
      if (css.outroPlay !== undefined) element.classList.add(css.outroPlay)
      element.addEventListener('animationend', (event) => {
        if (event.target === element) this.removeOutro()
      })
      outro.timer = setTimeout(() => { this.removeOutro() }, OUTRO_MS)
    }
    let waited = 0
    const wait = (): void => {
      waited += 1
      outro.frame = requestAnimationFrame(this.root.isConnected && waited < HANDOFF_WAIT_FRAMES ? wait : play)
    }
    outro.frame = requestAnimationFrame(wait)
  }

  /** Detach the page and any handoff copy. */
  dispose(): void {
    this.removeOutro()
    this.root.remove()
  }

  /** Remove the handoff copy if it is still on the document. */
  private removeOutro(): void {
    if (this.outro === undefined) return
    cancelAnimationFrame(this.outro.frame)
    clearTimeout(this.outro.timer)
    this.outro.element.remove()
    this.outro = undefined
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.status.parentElement !== this.card) {
        this.card.replaceChildren(this.mark, this.wordmark, this.status)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.card.replaceChildren(this.mark, this.wordmark, report)
  }

  /** Grow the bar monotonically as loader entries activate; the mount completes it. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    const value = Math.round(6 + ratio * 86) / 100
    this.progress.style.setProperty('--dsh-boot-progress', String(value))
    this.progress.setAttribute('aria-valuenow', String(Math.round(value * 100)))
  }
}
