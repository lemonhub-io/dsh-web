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

/**
 * The DSH whale (ui-primitives `FISH_LOGO_PATH`, viewBox 23.16 x 17.04). This page half runs before any client
 * package loads, so it carries its own copy.
 */
const WHALE_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'
/** Rising motes drawn behind the boot screen. */
const MOTE_COUNT = 18
/** The closing crossfade; the client boot page below draws the same scene. */
const FADE_MS = 520

/*
 * The boot screen mirrors the client shell's boot page (dsh-client-web `boot-page.module.css`) in palette, geometry
 * and timing. It closes with a crossfade over that page, so the emblem, wordmark and status line stay in place while
 * the status text changes. Message screens (another tab, failure, naming a workspace) set a glass card on the scene.
 */
const STYLE = `
  [data-dsh-web-boot] {
    --boot-bg: #f3f6fb; --boot-glow: rgb(57 100 254 / 14%); --boot-fg: #0f1115; --boot-muted: #61666b;
    --boot-line: rgb(15 17 21 / 10%); --boot-track: rgb(15 17 21 / 8%); --boot-accent: #3964fe; --boot-accent-2: #6dccff;
    --boot-ray: rgb(57 100 254 / 5%); --boot-mote: rgb(57 100 254 / 45%); --boot-card: rgb(255 255 255 / 72%);
    position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
    padding: 24px; box-sizing: border-box; overflow: hidden; color: var(--boot-fg);
    background: radial-gradient(120% 80% at 50% -10%, var(--boot-glow), transparent 60%), var(--boot-bg);
    font: 14px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    transition: opacity ${FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  @media (prefers-color-scheme: dark) {
    [data-dsh-web-boot] {
      --boot-bg: #070a10; --boot-glow: rgb(57 100 254 / 24%); --boot-fg: #f2f5fa; --boot-muted: #8f97a3;
      --boot-line: rgb(255 255 255 / 12%); --boot-track: rgb(255 255 255 / 10%); --boot-accent: #7aaaff;
      --boot-ray: rgb(122 170 255 / 6%); --boot-mote: rgb(160 200 255 / 55%); --boot-card: rgb(20 24 33 / 72%);
    }
  }
  [data-dsh-web-boot][data-leaving] { opacity: 0; pointer-events: none; }
  [data-dsh-web-boot] [data-boot-scene] { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
  [data-dsh-web-boot] [data-boot-aurora] {
    position: absolute; inset: -20%;
    background: radial-gradient(30% 26% at 36% 44%, rgb(57 100 254 / 16%), transparent 70%),
      radial-gradient(26% 24% at 64% 56%, rgb(109 204 255 / 14%), transparent 70%),
      radial-gradient(34% 30% at 50% 72%, rgb(139 118 246 / 10%), transparent 72%);
    animation: dsh-web-boot-drift 18s ease-in-out infinite alternate;
  }
  [data-dsh-web-boot] [data-boot-rays] {
    position: absolute; inset: -10% -20% 30%; transform-origin: 50% 0;
    background: repeating-conic-gradient(from 168deg at 50% -8%, transparent 0deg, var(--boot-ray) 2deg 3.5deg, transparent 5deg 9deg);
    mask-image: linear-gradient(to bottom, #000, transparent 85%);
    animation: dsh-web-boot-sway 12s ease-in-out infinite alternate;
  }
  [data-dsh-web-boot] [data-boot-mote] {
    position: absolute; bottom: -12px; left: var(--x); width: var(--s); height: var(--s); border-radius: 50%;
    background: var(--boot-mote); opacity: 0; animation: dsh-web-boot-rise var(--d) linear var(--delay) infinite;
  }
  [data-dsh-web-boot] [data-boot-stage] { position: relative; display: flex; flex-direction: column; align-items: center; width: min(380px, 100%); padding: 24px; box-sizing: border-box; }
  [data-dsh-web-boot] [data-boot-emblem] { position: relative; display: grid; place-items: center; width: 128px; height: 128px; }
  [data-dsh-web-boot] [data-boot-halo] {
    position: absolute; inset: 8px; border-radius: 50%;
    background: radial-gradient(closest-side, rgb(57 100 254 / 32%), transparent);
    animation: dsh-web-boot-breathe 3.6s ease-in-out infinite;
  }
  [data-dsh-web-boot] [data-boot-ring] {
    position: absolute; inset: 24px; border: 1px solid var(--boot-accent); border-radius: 50%; opacity: 0;
    animation: dsh-web-boot-ping 3.6s cubic-bezier(0.2, 0.6, 0.35, 1) infinite;
  }
  [data-dsh-web-boot] [data-boot-ring]:nth-child(3) { animation-delay: 1.2s; }
  [data-dsh-web-boot] [data-boot-ring]:nth-child(4) { animation-delay: 2.4s; }
  [data-dsh-web-boot] [data-boot-mark] {
    position: relative; width: 60px; height: auto; overflow: visible;
    filter: drop-shadow(0 6px 18px rgb(57 100 254 / 35%));
    animation: dsh-web-boot-float 5s ease-in-out 1.8s infinite;
  }
  [data-dsh-web-boot] [data-boot-stroke] {
    fill: none; stroke: var(--boot-accent); stroke-width: 0.35; stroke-linejoin: round; stroke-dasharray: 1; stroke-dashoffset: 1;
    animation: dsh-web-boot-draw 1.6s cubic-bezier(0.65, 0, 0.35, 1) 0.15s forwards;
  }
  [data-dsh-web-boot] [data-boot-fill] { opacity: 0; animation: dsh-web-boot-fill 0.9s ease-out 1.1s forwards; }
  [data-dsh-web-boot] [data-boot-wordmark] {
    margin-top: 14px; padding-left: 0.42em; font: 500 20px/28px Montserrat, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0.42em; animation: dsh-web-boot-spread 1.4s cubic-bezier(0.22, 1, 0.36, 1) 0.5s backwards;
  }
  [data-dsh-web-boot] [data-boot-status] {
    display: flex; flex-direction: column; align-items: center; gap: 10px; margin-top: 26px;
    animation: dsh-web-boot-appear 0.8s ease-out 0.9s backwards;
  }
  [data-dsh-web-boot] [data-boot-label] { display: flex; gap: 8px; font-size: 12px; line-height: 18px; letter-spacing: 0.02em; color: var(--boot-muted); }
  [data-dsh-web-boot] [data-boot-percent] { font-variant-numeric: tabular-nums; color: var(--boot-fg); }
  [data-dsh-web-boot] [role=progressbar] { position: relative; width: 200px; height: 2px; border-radius: 999px; overflow: hidden; background: var(--boot-track); }
  [data-dsh-web-boot] [role=progressbar] > i {
    position: absolute; inset: 0; border-radius: inherit; transform-origin: left;
    background: linear-gradient(90deg, var(--boot-accent), var(--boot-accent-2));
    transform: scaleX(var(--boot-progress, 0.06)); transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  [data-dsh-web-boot] [role=progressbar]::after {
    content: ''; position: absolute; inset: 0; transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, rgb(255 255 255 / 70%), transparent);
    animation: dsh-web-boot-shimmer 1.8s ease-in-out infinite;
  }
  [data-dsh-web-boot] [role=progressbar][data-indeterminate] > i { transform: scaleX(0.32); animation: dsh-web-boot-slide 1.4s ease-in-out infinite; }
  [data-dsh-web-boot] [data-boot-card] {
    width: 100%; padding: 24px; box-sizing: border-box; border-radius: 20px; background: var(--boot-card);
    box-shadow: 0 0 0 0.5px var(--boot-line), 0 18px 48px -12px rgb(15 17 21 / 24%);
    backdrop-filter: blur(24px) saturate(150%); animation: dsh-web-boot-appear 0.5s cubic-bezier(0.22, 1, 0.36, 1) backwards;
  }
  [data-dsh-web-boot] h1 { margin: 0 0 6px; font-size: 16px; line-height: 24px; font-weight: 500; }
  [data-dsh-web-boot] p { margin: 0 0 16px; color: var(--boot-muted); overflow-wrap: anywhere; }
  [data-dsh-web-boot] ul { margin: 0 0 16px; padding: 0; list-style: none; }
  [data-dsh-web-boot] li { padding: 6px 0; border-top: 0.5px solid var(--boot-line); overflow-wrap: anywhere; }
  [data-dsh-web-boot] input {
    display: block; width: 100%; min-height: 40px; margin: 0 0 16px; padding: 0 12px; box-sizing: border-box; border: 0.5px solid var(--boot-line);
    border-radius: 12px; color: inherit; background: transparent; font: inherit;
  }
  [data-dsh-web-boot] input:focus-visible { outline: 2px solid var(--boot-accent); outline-offset: 1px; }
  [data-dsh-web-boot] button, [data-dsh-toast] button {
    min-height: 40px; margin: 0 8px 0 0; padding: 0 16px; border: 0.5px solid var(--boot-line, rgb(128 128 128 / 40%));
    border-radius: 12px; color: inherit; background: transparent; font: inherit; cursor: pointer;
  }
  [data-dsh-web-boot] button[data-primary] {
    border-color: transparent; color: #fff; background: linear-gradient(120deg, #3964fe, #398efe 55%, #6dccff);
    box-shadow: 0 6px 18px -6px rgb(57 100 254 / 55%);
  }
  [data-dsh-web-boot] button:focus-visible, [data-dsh-toast] button:focus-visible { outline: 2px solid #4d6bfe; outline-offset: 2px; }
  [data-dsh-toasts] {
    position: fixed; left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); z-index: 2147483001; display: flex; flex-direction: column; align-items: center; gap: 8px;
    width: max-content; max-width: calc(100vw - 32px); transform: translateX(-50%);
  }
  [data-dsh-toast] {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px; box-sizing: border-box; border-radius: 12px;
    color: #fff; background: rgb(27 32 44 / 92%); box-shadow: 0 0 0 0.5px rgb(255 255 255 / 10%), 0 12px 32px rgb(0 0 0 / 28%);
    backdrop-filter: blur(16px);
    font: 14px/20px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  [data-dsh-toast] button { min-height: 32px; margin: 0; padding: 0 12px; border-color: rgb(255 255 255 / 30%); }
  @keyframes dsh-web-boot-drift { 0% { transform: translate3d(0, 0, 0) rotate(0deg); } 100% { transform: translate3d(3%, -2%, 0) rotate(8deg); } }
  @keyframes dsh-web-boot-sway { 0% { transform: rotate(-3deg); } 100% { transform: rotate(3deg); } }
  @keyframes dsh-web-boot-rise {
    0% { opacity: 0; transform: translate3d(0, 0, 0); } 15% { opacity: 1; } 85% { opacity: 0.8; }
    100% { opacity: 0; transform: translate3d(var(--drift), -105vh, 0); }
  }
  @keyframes dsh-web-boot-breathe { 0%, 100% { opacity: 0.6; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.06); } }
  @keyframes dsh-web-boot-ping { 0% { opacity: 0.55; transform: scale(0.6); } 100% { opacity: 0; transform: scale(1.9); } }
  @keyframes dsh-web-boot-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
  @keyframes dsh-web-boot-draw { to { stroke-dashoffset: 0; } }
  @keyframes dsh-web-boot-fill { to { opacity: 1; } }
  @keyframes dsh-web-boot-spread { from { opacity: 0; letter-spacing: 1.1em; } }
  @keyframes dsh-web-boot-appear { from { opacity: 0; transform: translateY(6px); } }
  @keyframes dsh-web-boot-shimmer { 0% { transform: translateX(-100%); } 60%, 100% { transform: translateX(100%); } }
  @keyframes dsh-web-boot-slide { from { transform: translateX(-100%) scaleX(0.32); } to { transform: translateX(320%) scaleX(0.32); } }
  @media (prefers-reduced-motion: reduce) {
    [data-dsh-web-boot] *, [data-dsh-web-boot] *::after { animation: none !important; }
    [data-dsh-web-boot] [data-boot-mote], [data-dsh-web-boot] [data-boot-ring] { display: none; }
    [data-dsh-web-boot] [data-boot-stroke] { stroke-dashoffset: 0; }
    [data-dsh-web-boot] [data-boot-fill] { opacity: 1; }
  }
`

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Create an element carrying one boot-screen part marker. */
function part<K extends keyof HTMLElementTagNameMap>(tag: K, name: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.setAttribute(`data-boot-${name}`, '')
  if (text !== undefined) el.textContent = text
  return el
}

/** Create an SVG element with attributes. */
function svgPart(tag: string, attributes: Readonly<Record<string, string>>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
  return el
}

/** The decorative water: drifting washes, light shafts and rising motes on fixed lanes. */
function bootScene(): HTMLElement {
  const root = part('div', 'scene')
  root.setAttribute('aria-hidden', 'true')
  let seed = 7
  const next = (): number => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  root.append(part('div', 'aurora'), part('div', 'rays'))
  for (let index = 0; index < MOTE_COUNT; index += 1) {
    const mote = part('i', 'mote')
    mote.style.setProperty('--x', `${(4 + next() * 92).toFixed(1)}%`)
    mote.style.setProperty('--s', `${(2 + next() * 3).toFixed(1)}px`)
    mote.style.setProperty('--d', `${(9 + next() * 10).toFixed(1)}s`)
    mote.style.setProperty('--delay', `${(-next() * 18).toFixed(1)}s`)
    mote.style.setProperty('--drift', `${((next() - 0.5) * 80).toFixed(0)}px`)
    root.append(mote)
  }
  return root
}

/** The emblem: halo, sonar rings and the whale whose outline draws before its body fills. */
function bootEmblem(): HTMLElement {
  const root = part('div', 'emblem')
  root.setAttribute('aria-hidden', 'true')
  const mark = svgPart('svg', { 'data-boot-mark': '', viewBox: '0 0 23.16 17.04' })
  const defs = svgPart('defs', {})
  const gradient = svgPart('linearGradient', { id: 'dsh-web-boot-whale', x1: '0', y1: '0', x2: '1', y2: '1' })
  gradient.append(
    svgPart('stop', { offset: '0', 'stop-color': '#3964fe' }),
    svgPart('stop', { offset: '0.55', 'stop-color': '#398efe' }),
    svgPart('stop', { offset: '1', 'stop-color': '#6dccff' }),
  )
  defs.append(gradient)
  mark.append(
    defs,
    svgPart('path', { d: WHALE_PATH, 'data-boot-fill': '', fill: 'url(#dsh-web-boot-whale)' }),
    svgPart('path', { d: WHALE_PATH, 'data-boot-stroke': '', pathLength: '1' }),
  )
  root.append(part('div', 'halo'), part('div', 'ring'), part('div', 'ring'), part('div', 'ring'), mark)
  return root
}

/** One action button of a boot screen. */
interface ScreenAction {
  readonly label: string
  readonly primary?: boolean
  run(): void
}

/** The full-page surface shown until the harness renders. */
class BootScreen {
  private readonly root = document.createElement('div')
  private readonly stage = part('div', 'stage')
  private bar: HTMLElement | undefined
  private closed = false

  constructor() {
    if (document.querySelector('style[data-dsh-web-boot-style]') === null) {
      const style = document.createElement('style')
      style.dataset.dshWebBootStyle = ''
      style.textContent = STYLE
      document.head.append(style)
    }
    this.root.dataset.dshWebBoot = ''
    this.root.append(bootScene(), this.stage)
    document.body.append(this.root)
  }

  /** Show a titled message with optional list and actions. */
  message(title: string, detail: string, actions: readonly ScreenAction[], items: readonly string[] = []): void {
    this.bar = undefined
    const panel = part('div', 'card')
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
    this.stage.replaceChildren(panel)
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
      const panel = this.stage.firstElementChild as HTMLElement
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
      const status = part('div', 'status')
      const caption = part('div', 'label')
      caption.append(part('span', 'text'), part('span', 'percent'))
      const bar = document.createElement('div')
      bar.setAttribute('role', 'progressbar')
      bar.append(document.createElement('i'))
      status.append(caption, bar)
      this.stage.replaceChildren(bootEmblem(), part('div', 'wordmark', 'DSH'), status)
      this.bar = bar
    }
    const bar = this.bar
    const caption = bar.previousElementSibling as HTMLElement
    const [text, percent] = [caption.firstElementChild as HTMLElement, caption.lastElementChild as HTMLElement]
    text.textContent = label
    bar.setAttribute('aria-label', label)
    if (fraction === undefined) {
      bar.dataset.indeterminate = ''
      bar.removeAttribute('aria-valuenow')
      bar.style.removeProperty('--boot-progress')
      percent.textContent = ''
    } else {
      delete bar.dataset.indeterminate
      const value = Math.round(fraction * 100)
      bar.setAttribute('aria-valuenow', String(value))
      bar.style.setProperty('--boot-progress', String(Math.max(fraction, 0.06)))
      percent.textContent = `${String(value)}%`
    }
  }

  /** Fade the surface out over the client boot page, then remove it; the harness has rendered. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.root.dataset.leaving = ''
    setTimeout(() => { this.root.remove() }, FADE_MS)
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
