/** Plugin community: discover Cordis bundles on GitHub and install them through the shared plugin manager. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Checkbox, Input, Modal, Tag,
  IconCheckCircleFillRegular, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular,
  IconDownloadOutlineRegular, IconLoadingOutlineRegular, IconRightUpOutlineRegular,
  IconSearchOutlineRegular, IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BundleInfo, ChangeResult, WebBundleInspection, WebPackageLimits } from '@deepseek-ai/dsh-plugin-manager/types'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import css from './CommunityPage.module.css'
import { CommunitySourceError, downloadCommunityBytes as download } from './community-download.ts'
import type { communityZh } from './community-locales.ts'
import { discoverGitHub, downloadGitHubPackage, githubPackages, type GitHubPackage, type GitHubRepository } from './github-community.ts'

/** Plain callbacks so the plugin manager keeps ownership of the installed inventory. */
export interface CommunityFace {
  policy(): Promise<WebPackageLimits | null>
  list(): Promise<BundleInfo[]>
  inspect(encoded: string): Promise<WebBundleInspection>
  install(encoded: string, trusted: boolean): Promise<ChangeResult>
  /** Show the Plugins page, where installed plugins are enabled and removed. */
  openManager(): void
}
/** Page inputs supplied by the slot renderer and the community plugin. */
export type CommunityPageProps = PropsRuntime<'main'> & PropsLocale<'pluginCommunity'> & InjectFace<CommunityFace>

type Problem = keyof typeof communityZh
interface Listing { name: string; version: string; description: string; url: string; sha256: string }
interface Candidate { encoded: string; report: WebBundleInspection; source?: string; done?: boolean }
type View = { kind: 'list' } | { kind: 'repository'; repository: GitHubRepository; packages: GitHubPackage[] }

const SEARCH_MS = 15000, INSPECT_MS = 60000, TRANSFER_MS = 120000

function catalog(value: unknown, base: string): Listing[] {
  const parsed = parseMarketIndex(value, base)
  if (parsed.plugins.length > 100) throw new Error('Too many catalog entries')
  return parsed.plugins.flatMap(plugin => plugin.versions.flatMap(version => version.web === undefined ? [] : [{
    name: plugin.name,
    version: version.version,
    description: typeof plugin.description === 'string' ? plugin.description : (plugin.description?.en ?? ''),
    ...version.web,
  }]))
}
function sourceFailure(error: unknown): Problem {
  if (!(error instanceof CommunitySourceError)) return 'failed'
  switch (error.code) {
    case 'rate': return 'githubRate'
    case 'missing': return 'githubMissing'
    case 'empty': return 'githubEmpty'
    case 'size': return 'size'
    case 'invalid': return 'githubInvalid'
    case 'network': return 'downloadFailed'
  }
}
function inspectionFailure(code?: string): Problem {
  switch (code) {
    case 'version': case 'lowering': case 'capability': case 'dependency': case 'native': case 'size': return code
    case 'installed': return 'already'
    default: return 'invalid'
  }
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** A stable colored initial tile, so cards are recognisable without fetching remote images. */
function Monogram({ name, large = false }: { name: string; large?: boolean }): ReactNode {
  const label = (name.split('/').at(-1) ?? name).replace(/^@/, '')
  const initials = label.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase()
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return (
    <span className={clsx(css.monogram, large && css.monogramLarge)} style={{ '--hue': String(hash % 360) } as CSSProperties} aria-hidden="true">
      {initials === '' ? label.slice(0, 1) : initials}
    </span>
  )
}
function RepositoryName({ name }: { name: string }): ReactNode {
  const slash = name.indexOf('/')
  return <><span className={css.owner}>{name.slice(0, slash + 1)}</span>{name.slice(slash + 1)}</>
}
function Spinner(): ReactNode {
  return <IconLoadingOutlineRegular size={14} className={css.spin} />
}

/**
 * Render search, repository drill-in, alternative sources and the install review.
 * @param props Localized callbacks for the existing plugin manager.
 * @returns The community page without a separate runtime or installation database.
 */
export function CommunityPage(props: CommunityPageProps): ReactNode {
  const { t } = props
  const [limits, setLimits] = useState<WebPackageLimits | null>()
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set())
  const [repositories, setRepositories] = useState<GitHubRepository[]>([])
  const [searched, setSearched] = useState(false)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [query, setQuery] = useState('')
  const [catalogUrl, setCatalogUrl] = useState('/plugin-community/cordis/index.json')
  const [listings, setListings] = useState<Listing[]>([])
  const [packageUrl, setPackageUrl] = useState('')
  const [candidate, setCandidate] = useState<Candidate>()
  const [trusted, setTrusted] = useState(false)
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<Problem>()
  const [dragging, setDragging] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const lifetime = useRef(new AbortController())
  const busy = pending !== undefined
  const ready = limits != null
  const deadline = (ms: number): AbortSignal => AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(ms)])
  const alive = (): boolean => !lifetime.current.signal.aborted

  const refresh = async (signal = lifetime.current.signal): Promise<void> => {
    const [policy, inventory] = await Promise.all([props.policy(), props.list()])
    if (signal.aborted) return
    setLimits(policy)
    setInstalled(new Set(inventory.filter(b => b.installed).map(b => b.name)))
  }
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setPending('search')
    void Promise.all([
      refresh(controller.signal),
      discoverGitHub('', AbortSignal.any([controller.signal, AbortSignal.timeout(SEARCH_MS)])).then((items) => {
        if (!controller.signal.aborted) setRepositories(items)
      }),
    ])
      .catch((error: unknown) => { if (!controller.signal.aborted) setProblem(sourceFailure(error)) })
      .finally(() => {
        if (controller.signal.aborted) return
        setSearched(true)
        setPending(undefined)
      })
    return () => { controller.abort() }
  }, [])

  const work = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setPending(key)
    setProblem(undefined)
    try {
      await action()
    } catch (error) {
      if (alive()) setProblem(sourceFailure(error))
    } finally {
      if (alive()) setPending(undefined)
    }
  }
  const review = async (bytes: Uint8Array, release?: { name: string; version: string; sha256?: string }, origin?: string): Promise<void> => {
    if (limits == null || bytes.length > limits.archiveBytes) { setProblem('size'); return }
    if (release?.sha256 !== undefined && await sha256(bytes) !== release.sha256) { setProblem('integrity'); return }
    const encoded = bytesToBase64(bytes)
    const report = await props.inspect(encoded)
    if (release !== undefined && report.compatible && (report.name !== release.name || report.version !== release.version)) {
      setProblem('integrity')
      return
    }
    if (!alive()) return
    setTrusted(false)
    setCandidate({ encoded, report, ...(origin === undefined ? {} : { source: origin }) })
  }
  const installGitHub = (pkg: GitHubPackage): void => {
    void work('pkg:' + pkg.name, async () => {
      if (limits == null) return
      const bytes = await downloadGitHubPackage(pkg, limits, deadline(TRANSFER_MS))
      await review(bytes, pkg, `${pkg.repository} @ ${pkg.commit.slice(0, 12)}`)
    })
  }
  const installListing = (listing: Listing): void => {
    void work('listing:' + listing.name, async () => {
      if (limits == null) return
      await review(await download(listing.url, limits.archiveBytes, deadline(SEARCH_MS)), listing, listing.url)
    })
  }
  const importFile = (selected: File): void => {
    void work('file', async () => {
      if (limits == null || selected.size > limits.archiveBytes) { setProblem('size'); return }
      await review(new Uint8Array(await selected.arrayBuffer()), undefined, selected.name)
    })
  }
  const closeReview = (): void => { if (!busy) setCandidate(undefined) }

  const installButton = (name: string, key: string, onClick: () => void): ReactNode => installed.has(name)
    ? <Tag tone="success">{t('installed')}</Tag>
    : (
        <Button variant="primary" size="sm" disabled={busy || !ready} icon={pending === key ? <Spinner /> : undefined} onClick={onClick}>
          {t('install')}
        </Button>
      )
  const packageCard = (key: string, name: string, version: string, description: string, meta: string, action: ReactNode): ReactNode => (
    <article key={key} className={css.card}>
      <div className={css.cardHead}>
        <Monogram name={name} />
        <div className={css.cardTitle}>
          <h3>{name}</h3>
          <span className={css.version}>{version}</span>
        </div>
      </div>
      {description !== '' && <p className={css.description}>{description}</p>}
      <div className={css.cardFoot}>
        <span className={css.meta} title={meta}>{meta}</span>
        {action}
      </div>
    </article>
  )

  const feedback = (
    <div className={css.feedback} aria-live="polite">
      {limits === null && <p className={css.alert} role="alert"><IconWarningTriangleOutlineRegular size={16} />{t('unavailable')}</p>}
      {problem !== undefined && candidate === undefined && (
        <p className={css.alert} role="alert"><IconWarningTriangleOutlineRegular size={16} />{t(problem)}</p>
      )}
    </div>
  )

  return (
    <div className={css.page}>
      <div className={css.content}>
        <header className={css.hero}>
          <div className={css.heroText}>
            <h1>{t('title')}</h1>
            <p>{t('intro')}</p>
          </div>
          <form
            className={css.search}
            role="search"
            onSubmit={(event) => {
              event.preventDefault()
              void work('search', async () => {
                const items = await discoverGitHub(query, deadline(SEARCH_MS))
                if (!alive()) return
                setRepositories(items)
                setSearched(true)
                setView({ kind: 'list' })
              })
            }}
          >
            <Input
              className={clsx(css.searchInput)}
              icon={<IconSearchOutlineRegular size={16} />}
              type="search"
              aria-label={t('searchLabel')}
              placeholder={t('searchHint')}
              value={query}
              onChange={(event) => { setQuery(event.target.value) }}
            />
            <Button type="submit" variant="primary" disabled={busy} icon={pending === 'search' ? <Spinner /> : undefined}>
              {t('searchAction')}
            </Button>
          </form>
          <p className={css.scope}>{t('scope')}</p>
        </header>

        {feedback}

        {view.kind === 'list'
          ? (
              <section className={css.section} aria-labelledby="community-repositories">
                <div className={css.sectionHead}>
                  <h2 id="community-repositories">{t('repositories')}</h2>
                  {repositories.length > 0 && <span className={css.count}>{repositories.length}</span>}
                </div>
                {pending === 'search' && repositories.length === 0 && (
                  <div className={css.grid} aria-label={t('loading')}>
                    {Array.from({ length: 6 }, (_, index) => <div key={index} className={css.skeleton} />)}
                  </div>
                )}
                {searched && pending !== 'search' && repositories.length === 0 && (
                  <div className={css.empty}><IconSearchOutlineRegular size={20} /><p>{t('noResults')}</p></div>
                )}
                {repositories.length > 0 && (
                  <div className={css.grid}>
                    {repositories.map((repository) => {
                      const key = 'repo:' + repository.name + repository.directory
                      return (
                        <article key={key} className={clsx(css.card, css.repository)}>
                          <div className={css.cardHead}>
                            <Monogram name={repository.name} />
                            <div className={css.cardTitle}>
                              <h3><RepositoryName name={repository.name} /></h3>
                              {repository.directory !== '' && <span className={css.meta}>{repository.directory}</span>}
                            </div>
                            <a
                              className={css.external}
                              href={'https://github.com/' + repository.name}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={t('openGithub')}
                              title={t('openGithub')}
                            >
                              <IconRightUpOutlineRegular size={16} />
                            </a>
                          </div>
                          {repository.description !== '' && <p className={css.description}>{repository.description}</p>}
                          <div className={css.cardFoot}>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy || !ready}
                              icon={pending === key ? <Spinner /> : undefined}
                              onClick={() => {
                                void work(key, async () => {
                                  const packages = await githubPackages(repository, deadline(INSPECT_MS))
                                  if (alive()) setView({ kind: 'repository', repository, packages })
                                })
                              }}
                            >
                              {t('viewPlugins')}
                            </Button>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          : (
              <section className={css.section} aria-labelledby="community-repository">
                <button type="button" className={css.back} onClick={() => { setView({ kind: 'list' }) }}>
                  <IconChevronLeftOutlineRegular size={16} />{t('back')}
                </button>
                <div className={css.repoBanner}>
                  <Monogram name={view.repository.name} large />
                  <div className={css.cardTitle}>
                    <h2 id="community-repository"><RepositoryName name={view.repository.name} /></h2>
                    {view.repository.description !== '' && <p className={css.description}>{view.repository.description}</p>}
                  </div>
                  <a className={css.external} href={'https://github.com/' + view.repository.name} target="_blank" rel="noreferrer" aria-label={t('openGithub')} title={t('openGithub')}>
                    <IconRightUpOutlineRegular size={16} />
                  </a>
                </div>
                <div className={css.sectionHead}>
                  <h2>{t('pluginsIn')}</h2>
                  <span className={css.count}>{view.packages.length}</span>
                </div>
                <div className={css.grid}>
                  {view.packages.map(pkg => packageCard(
                    pkg.repository + pkg.directory + pkg.commit, pkg.name, pkg.version, pkg.description,
                    (pkg.directory === '' ? '' : pkg.directory + ' · ') + pkg.commit.slice(0, 7),
                    installButton(pkg.name, 'pkg:' + pkg.name, () => { installGitHub(pkg) }),
                  ))}
                </div>
              </section>
            )}

        <details className={css.more}>
          <summary>
            <span className={css.moreIcon}><IconDownloadOutlineRegular size={16} /></span>
            <span className={css.moreText}><strong>{t('otherSources')}</strong><span>{t('otherHint')}</span></span>
            <IconChevronDownOutlineRegular size={16} className={css.chevron} />
          </summary>
          <div className={css.sources}>
            <form
              className={css.source}
              onSubmit={(event) => {
                event.preventDefault()
                void work('catalog', async () => {
                  const bytes = await download(catalogUrl, 512 * 1024, deadline(SEARCH_MS))
                  setListings(catalog(JSON.parse(new TextDecoder().decode(bytes)), new URL(catalogUrl, location.href).href))
                })
              }}
            >
              <label htmlFor="community-catalog">{t('catalog')}</label>
              <Input id="community-catalog" value={catalogUrl} onChange={(event) => { setCatalogUrl(event.target.value) }} />
              <Button type="submit" variant="outline" size="sm" disabled={busy || catalogUrl.trim() === ''} icon={pending === 'catalog' ? <Spinner /> : undefined}>
                {t('catalogLoad')}
              </Button>
            </form>
            <form
              className={css.source}
              onSubmit={(event) => {
                event.preventDefault()
                void work('url', async () => {
                  if (limits == null) return
                  await review(await download(packageUrl, limits.archiveBytes, deadline(SEARCH_MS)), undefined, packageUrl)
                })
              }}
            >
              <label htmlFor="community-package">{t('packageUrl')}</label>
              <Input id="community-package" value={packageUrl} placeholder="https://" onChange={(event) => { setPackageUrl(event.target.value) }} />
              <Button type="submit" variant="outline" size="sm" disabled={busy || !ready || packageUrl.trim() === ''} icon={pending === 'url' ? <Spinner /> : undefined}>
                {t('packageCheck')}
              </Button>
            </form>
            <div className={css.source}>
              <span className={css.sourceLabel}>{t('localFile')}</span>
              <button
                type="button"
                className={clsx(css.drop, dragging && css.dropActive)}
                disabled={busy || !ready}
                onClick={() => file.current?.click()}
                onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
                onDragLeave={() => { setDragging(false) }}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  const selected = event.dataTransfer.files[0]
                  if (selected !== undefined) importFile(selected)
                }}
              >
                {pending === 'file' ? <Spinner /> : <IconDownloadOutlineRegular size={16} />}
                {t('localFileAction')}
              </button>
              <input
                ref={file}
                type="file"
                className={css.file}
                accept=".tgz,.tar.gz,application/gzip"
                aria-label={t('localFile')}
                onChange={(event) => {
                  const selected = event.target.files?.[0]
                  event.target.value = ''
                  if (selected !== undefined) importFile(selected)
                }}
              />
            </div>
          </div>
          {listings.length > 0 && (
            <div className={css.section}>
              <div className={css.sectionHead}>
                <h2>{t('catalogEntries')}</h2>
                <span className={css.count}>{listings.length}</span>
              </div>
              <div className={css.grid}>
                {listings.map(listing => packageCard(
                  listing.name + listing.version, listing.name, listing.version, listing.description, new URL(listing.url).host,
                  installButton(listing.name, 'listing:' + listing.name, () => { installListing(listing) }),
                ))}
              </div>
            </div>
          )}
        </details>
      </div>

      {candidate !== undefined && (
        <Modal
          open
          onClose={closeReview}
          closeLabel={t('cancel')}
          title={t('reviewTitle')}
          footer={candidate.done === true
            ? (
                <div className={css.modalActions}>
                  <Button variant="outline" onClick={() => { setCandidate(undefined); props.openManager() }}>{t('openManager')}</Button>
                  <Button variant="primary" onClick={() => { setCandidate(undefined) }}>{t('done')}</Button>
                </div>
              )
            : (
                <div className={css.modalActions}>
                  <Button variant="outline" disabled={busy} onClick={closeReview}>{t('cancel')}</Button>
                  <Button
                    variant="primary"
                    disabled={busy || !candidate.report.compatible || !trusted}
                    icon={pending === 'install' ? <Spinner /> : undefined}
                    onClick={() => {
                      void work('install', async () => {
                        const outcome = await props.install(candidate.encoded, trusted)
                        await refresh()
                        if (outcome.application === 'failed' || outcome.application === 'cancelled') throw new Error('Manager operation failed')
                        if (alive()) setCandidate({ ...candidate, done: true })
                      })
                    }}
                  >
                    {t('installAction')}
                  </Button>
                </div>
              )}
        >
          <div className={css.review}>
            <div className={css.reviewHead}>
              <Monogram name={candidate.report.name} large />
              <div className={css.cardTitle}>
                <h3>{candidate.report.name}</h3>
                <span className={css.version}>{candidate.report.version}</span>
                {candidate.source !== undefined && <span className={css.meta} title={candidate.source}>{candidate.source}</span>}
              </div>
            </div>
            {candidate.done === true
              ? (
                  <div className={clsx(css.status, css.statusOk)}>
                    <IconCheckCircleFillRegular size={18} />
                    <div><strong>{t('doneTitle')}</strong><p>{t('doneHint')}</p></div>
                  </div>
                )
              : (
                  <>
                    <div className={clsx(css.status, candidate.report.compatible ? css.statusOk : css.statusBad)}>
                      {candidate.report.compatible ? <IconCheckCircleFillRegular size={18} /> : <IconWarningTriangleOutlineRegular size={18} />}
                      <p>{candidate.report.compatible ? t('compatible') : t(inspectionFailure(candidate.report.problem))}</p>
                    </div>
                    {candidate.report.compatible && (
                      <>
                        <div className={css.warning}>
                          <IconWarningTriangleOutlineRegular size={16} />
                          <p>{t('warning')}</p>
                        </div>
                        <Checkbox checked={trusted} onChange={setTrusted} label={t('trust')} />
                      </>
                    )}
                    {problem !== undefined && <p className={css.alert} role="alert"><IconWarningTriangleOutlineRegular size={16} />{t(problem)}</p>}
                  </>
                )}
          </div>
        </Modal>
      )}
    </div>
  )
}
