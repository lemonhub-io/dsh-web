// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BootPage } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.textContent).toContain('DSH')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const progress = el.querySelector<HTMLElement>('[data-dsh-boot-progress]')
    expect(progress?.style.getPropertyValue('--dsh-boot-progress')).toBe('0.06')
    page.setState('a', 'active')
    expect(progress?.style.getPropertyValue('--dsh-boot-progress')).toBe('0.49')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-progress]')).toBe(progress)
    page.setState('b', 'active')
    expect(progress?.style.getPropertyValue('--dsh-boot-progress')).toBe('0.92')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('holds a copy over the mount point until the renderer replaces the page, then dissolves it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    try {
      const { el, page } = mount()
      page.handoff()
      const copy = document.body.lastElementChild
      expect(copy?.getAttribute('aria-hidden')).toBe('true')
      expect(copy?.hasAttribute('data-dsh-boot')).toBe(false)
      vi.advanceTimersByTime(2000)
      expect(el.querySelector('[data-dsh-boot]')).not.toBeNull()
      expect(document.body.contains(copy ?? null)).toBe(true)
      el.replaceChildren()
      vi.advanceTimersByTime(2000)
      expect(document.body.contains(copy ?? null)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.handoff()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
    expect(document.body.children).toHaveLength(1)
  })
})
