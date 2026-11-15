/** Plugin community: discover Cordis bundles on GitHub and install them through the shared plugin manager. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Checkbox, Input, Modal, Pill, SegmentedControl, Tag,
  IconCheckCircleFillRegular, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconDownloadOutlineRegular, IconLoadingOutlineRegular, IconRefreshOutlineRegular, IconRightUpOutlineRegular,
  IconSearchOutlineRegular, IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BundleInfo, ChangeResult, WebBundleInspection, WebPackageLimits } from '@deepseek-ai/dsh-plugin-manager/types'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import css from './CommunityPage.module.css'
import { CommunitySourceError, communitySource, downloadCommunityBytes as download } from './community-download.ts'
import { age, byteSize, compactCount } from './community-format.ts'
import type { communityZh } from './community-locales.ts'
import {
  discoverGitHub, downloadGitHubPackage, githubPackages, GITHUB_PAGE_SIZE, GITHUB_RESULT_LIMIT,
  type GitHubPackage, type GitHubQuery, type GitHubRepository, type GitHubSearch, type GitHubSort,
} from './github-community.ts'

/** Plain callbacks so the plugin manager keeps ownership of the installed inventory. */
export interface CommunityFace {
  /** Public GitHub backend resolved from the plugin configuration. */
  backendUrl: string
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
interface Origin { label: string; link?: string; license?: string }
interface Candidate { encoded: string; size: number; report: WebBundleInspection; origin?: Origin; done?: boolean }
type View = { kind: 'list' } | { kind: 'repository'; repository: GitHubRepository; packages: GitHubPackage[] }
/** The loaded pages of the current discovery request. */
type Results = GitHubQuery & GitHubSearch

const SEARCH_MS = 15000, INSPECT_MS = 60000, TRANSFER_MS = 120000
const TOPIC_LIMIT = 10
const RETRYABLE: ReadonlySet<Problem> = new Set<Problem>(['failed', 'downloadFailed', 'githubRate', 'githubInvalid'])

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
/** The most frequent repository topics, excluding the discovery topic every result shares. */
function popularTopics(repositories: readonly GitHubRepository[]): string[] {
  const counts = new Map<string, number>()
  for (const repository of repositories) {
    for (const topic of new Set(repository.topics)) if (topic !== 'dsh-plugin') counts.set(topic, (counts.get(topic) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOPIC_LIMIT).map(([topic]) => topic)
}
function githubTree(repository: string, commit: string, directory: string): string {
  return `https://github.com/${repository}/tree/${commit}${directory === '' ? '' : '/' + directory.split('/').map(encodeURIComponent).join('/')}`
}
function httpsLink(value: string): string | undefined {
  try {
    const url = new URL(value, location.href)
    return url.protocol === 'https:' ? url.href : undefined
  } catch (_invalidUrl) {
    return undefined
  }
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
/** Dot-separated secondary facts; empty entries are skipped. */
function Facts({ items, className }: { items: readonly ReactNode[]; className?: string | undefined }): ReactNode {
  const present = items.filter(item => item !== null && item !== undefined && item !== false && item !== '')
  if (present.length === 0) return null
  const title = present.every(item => typeof item === 'string') ? present.join(' · ') : undefined
  return <p className={clsx(css.facts, className)} title={title}>{present.map((item, index) => <span key={index}>{item}</span>)}</p>
}

/**
 * Render search, repository drill-in, alternative sources and the install review.
 * @param props Localized callbacks for the existing plugin manager.
 * @returns The community page without a separate runtime or installation database.
 */
export function CommunityPage(props: CommunityPageProps): ReactNode {
  const { t } = props
  const sortId = useId()
  const [limits, setLimits] = useState<WebPackageLimits | null>()
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set())
  const [results, setResults] = useState<Results>({ query: '', sort: 'updated', topic: undefined, page: 1, repositories: [], total: 0, direct: false })
  const [topics, setTopics] = useState<string[]>([])
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
  const [retry, setRetry] = useState<{ run: () => void }>()
  const [dragging, setDragging] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const listScroll = useRef(0)
  const dragDepth = useRef(0)
  const lifetime = useRef(new AbortController())
  const busy = pending !== undefined
  const ready = limits != null
  const now = Date.now()
  const deadline = (ms: number): AbortSignal => AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(ms)])
  const alive = (): boolean => !lifetime.current.signal.aborted
  const { repositories, sort, topic } = results
  const loadable = Math.min(results.total, Math.floor(GITHUB_RESULT_LIMIT / GITHUB_PAGE_SIZE) * GITHUB_PAGE_SIZE)
  const more = !results.direct && repositories.length < loadable && (results.page + 1) * GITHUB_PAGE_SIZE <= GITHUB_RESULT_LIMIT
  const capped = !results.direct && !more && repositories.length < results.total

  const refresh = async (signal = lifetime.current.signal): Promise<void> => {
    const [policy, inventory] = await Promise.all([props.policy(), props.list()])
    if (signal.aborted) return
    setLimits(policy)
    setInstalled(new Set(inventory.filter(b => b.installed).map(b => b.name)))
  }

  const work = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setPending(key)
    setProblem(undefined)
    setRetry(undefined)
    try {
      await action()
    } catch (error) {
      if (!alive()) return
      const failure = sourceFailure(error)
      setProblem(failure)
      if (RETRYABLE.has(failure)) setRetry({ run: () => { void work(key, action) } })
    } finally {
      if (alive()) setPending(undefined)
    }
  }
  const loaded = (request: GitHubQuery, found: GitHubSearch): void => {
    setResults({ ...request, ...found })
    // Topic choices come from the unfiltered results, so they stay put while one topic is selected.
    if (request.topic === undefined) setTopics(popularTopics(found.repositories))
  }
  const search = (text: string, order: GitHubSort, filter?: string): void => {
    void work('search', async () => {
      const request = { query: text, sort: order, topic: filter, page: 1 }
      const found = await discoverGitHub(request, deadline(SEARCH_MS), props.backendUrl)
      if (!alive()) return
      loaded(request, found)
      setSearched(true)
      setView({ kind: 'list' })
    })
  }
  const loadMore = (): void => {
    void work('more', async () => {
      const request = { query: results.query, sort, topic, page: results.page + 1 }
      const found = await discoverGitHub(request, deadline(SEARCH_MS), props.backendUrl)
      if (!alive()) return
      const seen = new Set(repositories.map(repository => repository.name + '/' + repository.directory))
      loaded(request, {
        ...found,
        repositories: [...repositories, ...found.repositories.filter(repository => !seen.has(repository.name + '/' + repository.directory))],
      })
    })
  }

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setPending('search')
    const request: GitHubQuery = { query: '', sort: 'updated', topic: undefined, page: 1 }
    void Promise.all([
      refresh(controller.signal),
      discoverGitHub(request, AbortSignal.any([controller.signal, AbortSignal.timeout(SEARCH_MS)]), props.backendUrl).then((found) => {
        if (!controller.signal.aborted) loaded(request, found)
      }),
    ])
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const failure = sourceFailure(error)
        setProblem(failure)
        if (RETRYABLE.has(failure)) setRetry({ run: () => { search('', 'updated') } })
      })
      .finally(() => {
        if (controller.signal.aborted) return
        setSearched(true)
        setPending(undefined)
      })
    return () => { controller.abort() }
  }, [])

  // The list keeps its scroll position across a repository visit; a repository opens at the top.
  useLayoutEffect(() => {
    if (scroller.current !== null) scroller.current.scrollTop = view.kind === 'list' ? listScroll.current : 0
  }, [view.kind])

  const review = async (
    bytes: Uint8Array,
    release?: { name: string; version: string; sha256?: string },
    origin?: Origin,
  ): Promise<void> => {
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
    setCandidate({ encoded, size: bytes.length, report, ...(origin === undefined ? {} : { origin }) })
  }
  const openRepository = (repository: GitHubRepository, key: string): void => {
    void work(key, async () => {
      const packages = await githubPackages(repository, deadline(INSPECT_MS), props.backendUrl)
      if (!alive()) return
      listScroll.current = scroller.current?.scrollTop ?? 0
      setView({ kind: 'repository', repository, packages })
    })
  }
  const installGitHub = (pkg: GitHubPackage): void => {
    void work('pkg:' + pkg.name, async () => {
      if (limits == null) return
      const bytes = await downloadGitHubPackage(pkg, limits, deadline(TRANSFER_MS), props.backendUrl)
      await review(bytes, pkg, {
        label: `${pkg.repository} @ ${pkg.commit.slice(0, 7)}`,
        link: githubTree(pkg.repository, pkg.commit, pkg.directory),
        ...(pkg.license === '' ? {} : { license: pkg.license }),
      })
    })
  }
  const installListing = (listing: Listing): void => {
    void work('listing:' + listing.name, async () => {
      if (limits == null) return
      const link = httpsLink(listing.url)
      await review(await download(communitySource(listing.url, props.backendUrl), limits.archiveBytes, deadline(TRANSFER_MS)), listing, {
        label: listing.url,
        ...(link === undefined ? {} : { link }),
      })
    })
  }
  const importFile = (selected: File): void => {
    void work('file', async () => {
      if (limits == null || selected.size > limits.archiveBytes) { setProblem('size'); return }
      await review(new Uint8Array(await selected.arrayBuffer()), undefined, { label: selected.name })
    })
  }
  const closeReview = (): void => { if (!busy) setCandidate(undefined) }

  const acceptsFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files')
  const dropOpen = ready && !busy && candidate === undefined
  const dragHandlers = {
    onDragEnter: (event: DragEvent) => {
      if (!acceptsFiles(event)) return
      event.preventDefault()
      dragDepth.current += 1
      if (dropOpen) setDragging(true)
    },
    onDragOver: (event: DragEvent) => {
      if (!acceptsFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = dropOpen ? 'copy' : 'none'
    },
    onDragLeave: (event: DragEvent) => {
      if (!acceptsFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: (event: DragEvent) => {
      if (!acceptsFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const selected = event.dataTransfer.files[0]
      if (selected !== undefined && dropOpen) importFile(selected)
    },
  }

  const installButton = (name: string, key: string, onClick: () => void): ReactNode => installed.has(name)
    ? <Tag tone="success">{t('installed')}</Tag>
    : (
      <Button variant="primary" size="sm" disabled={busy || !ready} icon={pending === key ? <Spinner /> : undefined} onClick={onClick}>
        {t('install')}
      </Button>
    )
  const externalLink = (href: string, label: string): ReactNode => (
    <a className={css.external} href={href} target="_blank" rel="noreferrer" aria-label={label} title={label}>
      <IconRightUpOutlineRegular size={16} />
    </a>
  )
  const repositoryFacts = (repository: GitHubRepository): ReactNode[] => {
    const pushed = repository.pushed === undefined ? undefined : age(repository.pushed, now)
    return [
      repository.stars > 0 && t('stars', { n: compactCount(repository.stars) }),
      pushed !== undefined && t(pushed.key, { n: pushed.n }),
      repository.license,
    ]
  }
  const packageCard = (
    key: string, name: string, version: string, description: string, facts: ReactNode[], actions: ReactNode, source?: string,
  ): ReactNode => (
    <article key={key} className={css.card}>
      <div className={css.cardHead}>
        <Monogram name={name} />
        <div className={css.cardTitle}>
          <h3>{name}</h3>
          <span className={css.version}>{version}</span>
        </div>
        {source !== undefined && externalLink(source, t('viewSource'))}
      </div>
      <p className={clsx(css.description, description === '' && css.placeholder)}>{description === '' ? t('noDescription') : description}</p>
      <div className={css.cardFoot}>
        <Facts items={facts} className={css.mono} />
        <div className={css.actions}>{actions}</div>
      </div>
    </article>
  )

  const feedback = (
    <div className={css.feedback} aria-live="polite">
      {limits === null && <p className={css.alert} role="alert"><IconWarningTriangleOutlineRegular size={16} /><span>{t('unavailable')}</span></p>}
      {problem !== undefined && candidate === undefined && (
        <div className={css.alert} role="alert">
          <IconWarningTriangleOutlineRegular size={16} />
          <span>{t(problem)}</span>
          {retry !== undefined && (
            <Button variant="outline" size="sm" className={css.retry} disabled={busy} icon={<IconRefreshOutlineRegular size={14} />} onClick={retry.run}>
              {t('retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  )

  const repositoryList = (
    <section className={css.section} aria-labelledby="community-repositories">
      <div className={css.sectionHead}>
        <h2 id="community-repositories">{t('repositories')}</h2>
        {repositories.length > 0 && <span className={css.count}>{results.total.toLocaleString('en-US')}</span>}
        <SegmentedControl
          id={sortId}
          className={css.sort}
          label={t('sortLabel')}
          value={sort}
          disabled={busy}
          options={[{ value: 'updated', label: t('sortUpdated') }, { value: 'stars', label: t('sortStars') }]}
          onChange={(next) => { search(results.query, next, topic) }}
        />
      </div>
      {!results.direct && topics.length > 1 && (
        <div className={css.topics} role="group" aria-label={t('topicsLabel')}>
          <Pill
            className={css.topic}
            active={topic === undefined}
            aria-pressed={topic === undefined}
            disabled={busy}
            onClick={() => { if (topic !== undefined) search(results.query, sort) }}
          >
            {t('allTopics')}
          </Pill>
          {topics.map(item => (
            <Pill
              key={item}
              className={css.topic}
              active={topic === item}
              aria-pressed={topic === item}
              disabled={busy}
              onClick={() => { search(results.query, sort, topic === item ? undefined : item) }}
            >
              {item}
            </Pill>
          ))}
        </div>
      )}
      <div id={`${sortId}-${sort}-panel`} role="tabpanel" aria-labelledby={`${sortId}-${sort}`} className={css.panel}>
        {pending === 'search' && (
          <div className={css.grid} aria-label={t('loading')}>
            {Array.from({ length: 6 }, (_, index) => <div key={index} className={css.skeleton} />)}
          </div>
        )}
        {searched && pending !== 'search' && problem === undefined && repositories.length === 0 && (
          <div className={css.empty}><IconSearchOutlineRegular size={20} /><p>{t('noResults')}</p></div>
        )}
        {pending !== 'search' && repositories.length > 0 && (
          <div className={css.grid}>
            {repositories.map((repository) => {
              const key = 'repo:' + repository.name + repository.directory
              const tags = repository.topics.filter(item => item !== 'dsh-plugin').slice(0, 3)
              return (
                <article key={key} className={clsx(css.card, css.repository)}>
                  <div className={css.cardHead}>
                    <Monogram name={repository.name} />
                    <div className={css.cardTitle}>
                      <h3><RepositoryName name={repository.name} /></h3>
                      {repository.directory !== '' && <span className={css.meta}>{repository.directory}</span>}
                    </div>
                    {externalLink('https://github.com/' + repository.name, t('openGithub'))}
                  </div>
                  <p className={clsx(css.description, repository.description === '' && css.placeholder)}>
                    {repository.description === '' ? t('noDescription') : repository.description}
                  </p>
                  {tags.length > 0 && (
                    <div className={css.tags}>{tags.map(item => <Tag key={item} tone="neutral">{item}</Tag>)}</div>
                  )}
                  <div className={css.cardFoot}>
                    <Facts items={repositoryFacts(repository)} />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !ready}
                      icon={pending === key ? <Spinner /> : undefined}
                      onClick={() => { openRepository(repository, key) }}
                    >
                      {t('viewPlugins')}
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
      {pending !== 'search' && repositories.length > 0 && !results.direct && (
        <div className={css.pager}>
          <span className={css.pagerText}>
            {t('loadedOf', { shown: repositories.length.toLocaleString('en-US'), total: results.total.toLocaleString('en-US') })}
          </span>
          {more && (
            <Button variant="outline" disabled={busy} icon={pending === 'more' ? <Spinner /> : undefined} onClick={loadMore}>
              {t('loadMore')}
            </Button>
          )}
          {capped && <span className={css.pagerText}>{t('resultCap')}</span>}
        </div>
      )}
    </section>
  )

  const repositoryDetail = view.kind === 'repository' && (
    <section className={css.section} aria-labelledby="community-repository">
      <button type="button" className={css.back} onClick={() => { setView({ kind: 'list' }) }}>
        <IconChevronLeftOutlineRegular size={16} />{t('back')}
      </button>
      <div className={css.repoBanner}>
        <Monogram name={view.repository.name} large />
        <div className={css.bannerText}>
          <h2 id="community-repository"><RepositoryName name={view.repository.name} /></h2>
          {view.repository.description !== '' && <p className={css.bannerDescription}>{view.repository.description}</p>}
          <Facts items={[
            ...repositoryFacts(view.repository),
            view.packages[0] !== undefined && (
              <a
                className={css.commit}
                href={`https://github.com/${view.repository.name}/commit/${view.packages[0].commit}`}
                target="_blank"
                rel="noreferrer"
              >
                {t('pinned', { commit: view.packages[0].commit.slice(0, 7) })}
              </a>
            ),
          ]}
          />
        </div>
        {externalLink('https://github.com/' + view.repository.name, t('openGithub'))}
      </div>
      <div className={css.sectionHead}>
        <h2>{t('pluginsIn')}</h2>
        <span className={css.count}>{view.packages.length}</span>
      </div>
      <div className={css.grid}>
        {view.packages.map(pkg => packageCard(
          pkg.repository + pkg.directory + pkg.commit, pkg.name, pkg.version, pkg.description,
          [
            pkg.directory,
            t('files', { n: pkg.files.length }),
            byteSize(pkg.files.reduce((sum, item) => sum + item.size, 0)),
          ],
          installButton(pkg.name, 'pkg:' + pkg.name, () => { installGitHub(pkg) }),
          githubTree(pkg.repository, pkg.commit, pkg.directory),
        ))}
      </div>
    </section>
  )

  return (
    <div className={css.root} {...dragHandlers}>
      <div ref={scroller} className={css.page}>
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
                search(query, sort)
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
            <div className={css.heroFoot}>
              <p className={css.scope}>{t('scope')}</p>
              {installed.size > 0 && (
                <button type="button" className={css.installedLink} onClick={() => { props.openManager() }}>
                  <IconCheckCircleFillRegular size={14} className={css.installedMark} />
                  <span>{t('installedCount', { n: installed.size })}</span>
                  <span className={css.manage}>{t('manageInstalled')}<IconChevronRightOutlineRegular size={14} /></span>
                </button>
              )}
            </div>
          </header>

          {feedback}

          {view.kind === 'list' ? repositoryList : repositoryDetail}

          <details className={css.more}>
            <summary>
              <span className={css.moreIcon}><IconDownloadOutlineRegular size={16} /></span>
              <span className={css.moreText}><span className={css.moreTitle}>{t('otherSources')}</span><span>{t('otherHint')}</span></span>
              <IconChevronDownOutlineRegular size={16} className={css.chevron} />
            </summary>
            <div className={css.sources}>
              <form
                className={css.source}
                onSubmit={(event) => {
                  event.preventDefault()
                  void work('catalog', async () => {
                    const bytes = await download(communitySource(catalogUrl, props.backendUrl), 512 * 1024, deadline(SEARCH_MS))
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
                    const link = httpsLink(packageUrl)
                    const bytes = await download(communitySource(packageUrl, props.backendUrl), limits.archiveBytes, deadline(TRANSFER_MS))
                    await review(bytes, undefined, {
                      label: packageUrl,
                      ...(link === undefined ? {} : { link }),
                    })
                  })
                }}
              >
                <label htmlFor="community-package">{t('packageUrl')}</label>
                <Input id="community-package" value={packageUrl} placeholder={t('packageHint')} onChange={(event) => { setPackageUrl(event.target.value) }} />
                <Button type="submit" variant="outline" size="sm" disabled={busy || !ready || packageUrl.trim() === ''} icon={pending === 'url' ? <Spinner /> : undefined}>
                  {t('packageCheck')}
                </Button>
              </form>
              <div className={css.source}>
                <span className={css.sourceLabel}>{t('localFile')}</span>
                <button type="button" className={css.drop} disabled={busy || !ready} onClick={() => file.current?.click()}>
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
                    listing.name + listing.version, listing.name, listing.version, listing.description, [new URL(listing.url).host],
                    installButton(listing.name, 'listing:' + listing.name, () => { installListing(listing) }),
                  ))}
                </div>
              </div>
            )}
          </details>
        </div>
      </div>

      {dragging && (
        <div className={css.dropOverlay} aria-hidden="true">
          <div className={css.dropCard}>
            <span className={css.dropIcon}><IconDownloadOutlineRegular size={20} /></span>
            <span className={css.dropTitle}>{t('dropTitle')}</span>
            <span className={css.dropHint}>{t('dropHint')}</span>
          </div>
        </div>
      )}

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
              <Monogram name={candidate.report.name || (candidate.origin?.label ?? '')} large />
              <div className={css.cardTitle}>
                <h3>{candidate.report.name || candidate.origin?.label}</h3>
                {candidate.report.version !== '' && <span className={css.version}>{candidate.report.version}</span>}
              </div>
            </div>
            {candidate.report.description !== '' && <p className={css.reviewDescription}>{candidate.report.description}</p>}
            {candidate.done === true
              ? (
                <div className={clsx(css.status, css.statusOk)}>
                  <IconCheckCircleFillRegular size={18} />
                  <div><p className={css.statusTitle}>{t('doneTitle')}</p><p>{t('doneHint')}</p></div>
                </div>
              )
              : (
                <>
                  <dl className={css.details}>
                    {candidate.origin !== undefined && (
                      <div>
                        <dt>{t('reviewSource')}</dt>
                        <dd>
                          {candidate.origin.link === undefined
                            ? <span className={css.detailValue} title={candidate.origin.label}>{candidate.origin.label}</span>
                            : (
                              <a className={css.detailValue} href={candidate.origin.link} target="_blank" rel="noreferrer" title={candidate.origin.link}>
                                {candidate.origin.label}
                              </a>
                            )}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>{t('reviewSize')}</dt>
                      <dd><span className={css.detailValue}>{byteSize(candidate.size)}</span></dd>
                    </div>
                    {candidate.origin?.license !== undefined && (
                      <div>
                        <dt>{t('reviewLicense')}</dt>
                        <dd><span className={css.detailValue}>{candidate.origin.license}</span></dd>
                      </div>
                    )}
                    {candidate.report.compatible && (
                      <div>
                        <dt>{t('reviewRequires')}</dt>
                        <dd>
                          {candidate.report.requires.length === 0
                            ? <span className={css.detailMuted}>{t('reviewRequiresNone')}</span>
                            : <span className={css.modules}>{candidate.report.requires.map(item => <code key={item}>{item}</code>)}</span>}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <div className={clsx(css.status, candidate.report.compatible ? css.statusOk : css.statusBad)}>
                    {candidate.report.compatible
                      ? <IconCheckCircleFillRegular size={18} />
                      : <IconWarningTriangleOutlineRegular size={18} />}
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
                  {problem !== undefined && <p className={css.alert} role="alert"><IconWarningTriangleOutlineRegular size={16} /><span>{t(problem)}</span></p>}
                </>
              )}
          </div>
        </Modal>
      )}
    </div>
  )
}
