/**
 * Assemble the static site of the browser-hosted harness from a finished
 * `build:preview` output: the worker page becomes the site root and a generated
 * service worker precaches what a first launch needs. The Node-served index page,
 * source maps, and packaging fixtures stay out.
 *
 * Usage: tsx scripts/pack-web-platform.ts [--out dist-site]
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const webRoot = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { out: { type: 'string', default: 'dist-site' } } })
const source = join(webRoot, 'dist')
const out = resolve(webRoot, values.out)

if (!existsSync(join(source, 'preview.html'))) {
  throw new Error('pack-web-platform: dist/preview.html is missing; run build:preview first')
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(source, out, {
  recursive: true,
  filter: (path) => {
    const name = relative(source, path)
    return name === '' || (!name.endsWith('.map') && name !== 'index.html')
  },
})
renameSync(join(out, 'preview.html'), join(out, 'index.html'))

// The site is an independent build, so it must not present itself as the official application.
const manifest = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>
writeFileSync(join(out, 'manifest.webmanifest'), `${JSON.stringify({
  ...manifest,
  name: 'DSH Web',
  short_name: 'DSH Web',
  description: 'An unofficial browser build of DSH. It is built on DeepSeek Harness and is not affiliated with DeepSeek.',
  lang: 'en',
  dir: 'ltr',
  categories: ['developer', 'productivity', 'utilities'],
  // One host runs per origin, so a launch joins the open window instead of opening one that must wait.
  launch_handler: { client_mode: ['focus-existing', 'auto'] },
  shortcuts: [
    { name: 'New session', url: './?action=new', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] },
    { name: 'Settings', url: './?action=settings', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] },
  ],
  share_target: {
    action: './share-target',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: {
      title: 'title',
      text: 'text',
      url: 'url',
      files: [{ name: 'files', accept: ['image/*', 'text/*', 'application/json', 'application/pdf'] }],
    },
  },
  screenshots: [
    { src: 'screenshots/wide.png', sizes: '1280x800', type: 'image/png', form_factor: 'wide', label: 'DSH Web on a desktop' },
    { src: 'screenshots/narrow.png', sizes: '780x1688', type: 'image/png', form_factor: 'narrow', label: 'DSH Web on a phone' },
  ],
}, null, 2)}\n`)
cpSync(join(webRoot, 'platform', 'screenshots'), join(out, 'screenshots'), { recursive: true })

// Install metadata the shared application page leaves to each product, and a dark first paint for dark systems.
const page = readFileSync(join(out, 'index.html'), 'utf8')
writeFileSync(join(out, 'index.html'), page
  .replace('<meta name="apple-mobile-web-app-title" content="DSH" />', [
    '<meta name="apple-mobile-web-app-title" content="DSH Web" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
    '<meta name="application-name" content="DSH Web" />',
    '<meta name="description" content="An unofficial browser build of DSH. It is built on DeepSeek Harness and is not affiliated with DeepSeek." />',
    '<style>@media (prefers-color-scheme: dark) { html { background: #15171a } }</style>',
  ].join('\n    ')))

/** List every file under a directory, relative to the site root. */
function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? listFiles(path) : [relative(out, path)]
  })
}

// Fixture overlays exist for packaging regressions, which run against dist/.
for (const name of readdirSync(join(out, 'preview'))) {
  if (name.includes('fixture')) rmSync(join(out, 'preview', name), { recursive: true, force: true })
}

const files = listFiles(out).sort()
const hash = createHash('sha256')
const hashes = new Map<string, string>()
for (const file of files) {
  const bytes = readFileSync(join(out, file))
  hash.update(file).update(bytes)
  hashes.set(file, createHash('sha256').update(bytes).digest('hex').slice(0, 16))
}
const version = hash.digest('hex').slice(0, 16)

const fileMap = (names: readonly string[]): string => JSON.stringify(Object.fromEntries(names.map(file => [`./${file}`, hashes.get(file)])))
// Grammars and page chunks are not needed to start, so they fill in after boot; store screenshots are never used offline.
const isLazy = (file: string): boolean => file.startsWith('assets/langs/') || file.startsWith('preview/lazy/') || file.startsWith('assets/fonts/KaTeX')
const cached = files.filter(file => !file.startsWith('screenshots/'))
const precache = cached.filter(file => !isLazy(file))
const template = readFileSync(join(webRoot, 'platform', 'sw.js'), 'utf8')
writeFileSync(join(out, 'sw.js'), template
  .replace('__DSH_SITE_VERSION__', version)
  .replace('__DSH_PRECACHE__', fileMap(precache))
  .replace('__DSH_LAZY__', fileMap(cached.filter(isLazy))))
// Cloudflare consumes this file during upload, so it stays outside the offline cache.
cpSync(join(webRoot, 'platform', '_headers'), join(out, '_headers'))

const bytes = files.reduce((total, file) => total + statSync(join(out, file)).size, 0)
console.log(`pack-web-platform: ${String(files.length)} files, ${String(Math.round(bytes / 1048576))} MiB, ${String(precache.length)} precached, version ${version}, in ${relative(process.cwd(), out)}`)
