/** Discovery and review of ordinary Cordis bundles The host manager owns their inventory. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BundleInfo,
  WebBundleInspection,
  WebPackageLimits,
  ChangeResult,
} from '@deepseek-ai/dsh-plugin-manager/types'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import css from './CommunityPage.module.css'
import { CommunitySourceError, downloadCommunityBytes as download } from './community-download.ts'
import {
  discoverGitHub,
  githubPackages,
  downloadGitHubPackage,
  type GitHubRepository,
  type GitHubPackage,
} from './github-community.ts'

/** Plain callbacks preserve Cordis ownership outside the rendered page. */
export interface CordisCommunityFace {
  policy(): Promise<WebPackageLimits | null>
  list(): Promise<BundleInfo[]>
  inspect(encoded: string): Promise<WebBundleInspection>
  install(encoded: string, trusted: boolean): Promise<ChangeResult>
  enable(name: string, enabled: boolean): Promise<ChangeResult>
  remove(name: string): Promise<ChangeResult>
}
interface Listing {
  name: string
  version: string
  description: string
  url: string
  sha256: string
}
interface Candidate {
  encoded: string
  report: WebBundleInspection
  source?: string
}
type Props = PropsLocale<'pluginCommunity'> & InjectFace<CordisCommunityFace>

function catalog(value: unknown, base: string): Listing[] {
  const parsed = parseMarketIndex(value, base)
  if (parsed.plugins.length > 100) throw new Error('Too many catalog entries')
  return parsed.plugins.flatMap(plugin =>
    plugin.versions.flatMap(version =>
      version.web === undefined
        ? []
        : [
          {
            name: plugin.name,
            version: version.version,
            description: typeof plugin.description === 'string' ? plugin.description : (plugin.description?.en ?? ''),
            ...version.web,
          },
        ],
    ),
  )
}
function sourceFailure(error: unknown): keyof typeof import('./cordis-community-locales.ts').cordisZh {
  if (!(error instanceof CommunitySourceError)) return 'cordisFailed'
  switch (error.code) {
    case 'rate':
      return 'githubRate'
    case 'missing':
      return 'githubMissing'
    case 'empty':
      return 'githubEmpty'
    case 'size':
      return 'cordisSize'
    case 'invalid':
      return 'githubInvalid'
    case 'network':
      return 'cordisDownloadFailed'
  }
}
/** Render catalog downloads and the shared manager inventory.
 * @param props Localized callbacks for the existing plugin manager.
 * @returns Community sections without a separate runtime or installation database.
 */
export function CordisCommunityPage(props: Props): ReactNode {
  const { t } = props
  const [limits, setLimits] = useState<WebPackageLimits | null>(),
    [bundles, setBundles] = useState<BundleInfo[]>([])
  const [listings, setListings] = useState<Listing[]>([]),
    [candidate, setCandidate] = useState<Candidate>()
  const [repositories, setRepositories] = useState<GitHubRepository[]>([])
  const [githubPlugins, setGithubPlugins] = useState<GitHubPackage[]>([])
  const [githubQuery, setGithubQuery] = useState('')
  const [source, setSource] = useState('/plugin-community/cordis/index.json'),
    [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<keyof typeof import('./cordis-community-locales.ts').cordisZh>()
  const [trusted, setTrusted] = useState(false),
    [search, setSearch] = useState('')
  const file = useRef<HTMLInputElement>(null),
    lifetime = useRef(new AbortController())
  const load = async (signal = lifetime.current.signal): Promise<void> => {
    const [policy, inventory] = await Promise.all([props.policy(), props.list()])
    if (!signal.aborted) {
      setLimits(policy)
      setBundles(inventory.filter(b => b.installed))
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setBusy(true)
    void Promise.all([
      load(controller.signal),
      discoverGitHub('', AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])).then((items) => {
        if (!controller.signal.aborted) setRepositories(items)
      }),
    ])
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProblem(sourceFailure(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => {
      controller.abort()
    }
  }, [])
  const work = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    try {
      await action()
    } catch (error) {
      if (!lifetime.current.signal.aborted) setProblem(sourceFailure(error))
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false)
    }
  }
  const review = async (
    bytes: Uint8Array,
    release?: Pick<Listing, 'name' | 'version'> & { sha256?: string },
    origin?: string,
  ): Promise<void> => {
    if (limits === null || limits === undefined || bytes.length > limits.archiveBytes) {
      setProblem('cordisSize')
      return
    }
    if (release?.sha256 !== undefined) {
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
      if ([...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') !== release.sha256) {
        setProblem('cordisIntegrity')
        return
      }
    }
    const encoded = bytesToBase64(bytes),
      report = await props.inspect(encoded)
    if (
      release !== undefined &&
      report.compatible &&
      (report.name !== release.name || report.version !== release.version)
    ) {
      setProblem('cordisIntegrity')
      return
    }
    if (lifetime.current.signal.aborted) return
    setTrusted(false)
    setCandidate({ encoded, report, ...(origin === undefined ? {} : { source: origin }) })
  }
  const result = async (action: Promise<ChangeResult>): Promise<void> => {
    const value = await action
    await load()
    if (value.application === 'failed' || value.application === 'cancelled') throw new Error('Manager operation failed')
  }
  const failure = (code?: string): keyof typeof import('./cordis-community-locales.ts').cordisZh => {
    switch (code) {
      case 'version':
        return 'cordisVersion'
      case 'lowering':
        return 'cordisLowering'
      case 'capability':
        return 'cordisCapability'
      case 'dependency':
        return 'cordisDependency'
      case 'native':
        return 'cordisNative'
      case 'size':
        return 'cordisSize'
      case 'installed':
        return 'cordisAlready'
      default:
        return 'cordisInvalid'
    }
  }
  return (
    <section className={css.section}>
      <h2>{t('cordisTitle')}</h2>
      <p className={css.note}>{t('cordisIntro')}</p>
      {limits === null && <p role="alert">{t('cordisUnavailable')}</p>}
      <form
        className={css.form}
        onSubmit={(event) => {
          event.preventDefault()
          void work(async () => {
            const items = await discoverGitHub(
              githubQuery,
              AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(15000)]),
            )
            if (!lifetime.current.signal.aborted) {
              setRepositories(items)
              setGithubPlugins([])
            }
          })
        }}
      >
        <label htmlFor="github-query">{t('githubSearch')}</label>
        <div className={css.row}>
          <Input
            id="github-query"
            value={githubQuery}
            placeholder={t('githubHint')}
            onChange={event =>{  setGithubQuery(event.target.value); }}
          />
          <Button type="submit" variant="outline" disabled={busy}>
            {t('githubFind')}
          </Button>
        </div>
      </form>
      <p className={css.note}>{t('githubScope')}</p>
      <div className={css.feedback} aria-live="polite">
        {busy && <span role="status">{t('loading')}</span>}
        {problem !== undefined && <p role="alert">{t(problem)}</p>}
      </div>
      {!busy && repositories.length === 0 && <p className={css.note}>{t('githubNoResults')}</p>}
      <div className={css.grid}>
        {repositories.map(repo => (
          <article key={repo.name + repo.directory} className={css.card}>
            <h3>{repo.name}</h3>
            <p>{repo.description}</p>
            {repo.directory !== '' && <p className={css.note}>{repo.directory}</p>}
            <div className={css.actions}>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || limits == null}
                onClick={() => {
                  void work(async () => {
                    const items = await githubPackages(
                      repo,
                      AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(60000)]),
                    )
                    if (!lifetime.current.signal.aborted) setGithubPlugins(items)
                  })
                }}
              >
                {t('githubPackages')}
              </Button>
              <a href={'https://github.com/' + repo.name} target="_blank" rel="noreferrer">
                {t('githubRepository')}
              </a>
            </div>
          </article>
        ))}
      </div>
      <div className={css.grid}>
        {githubPlugins.map(pkg => (
          <article key={pkg.repository + pkg.directory + pkg.commit} className={css.card}>
            <div className={css.heading}>
              <h3>{pkg.name}</h3>
              <Tag>{pkg.version}</Tag>
            </div>
            <p>{pkg.description}</p>
            <p className={css.note}>{pkg.repository + ' ' + pkg.commit.slice(0, 12)}</p>
            <div className={css.actions}>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || limits == null}
                onClick={() => {
                  void work(async () => {
                    if (limits == null) return
                    const bytes = await downloadGitHubPackage(
                      pkg,
                      limits,
                      AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(120000)]),
                    )
                    await review(bytes, pkg, pkg.repository + ' ' + pkg.commit)
                  })
                }}
              >
                {t('githubInstall')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || limits == null}
                onClick={() => {
                  void work(async () => {
                    if (limits == null) return
                    const bytes = await downloadGitHubPackage(
                      pkg,
                      limits,
                      AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(120000)]),
                    )
                    if (lifetime.current.signal.aborted) return
                    const href = URL.createObjectURL(
                      new Blob([new Uint8Array(bytes)], {
                        type: 'application/gzip',
                      }),
                    )
                    try {
                      const link = document.createElement('a')
                      link.href = href
                      link.download = pkg.name.replaceAll('/', '-') + '-' + pkg.version + '.tgz'
                      link.click()
                    } finally {
                      URL.revokeObjectURL(href)
                    }
                  })
                }}
              >
                {t('download')}
              </Button>
            </div>
          </article>
        ))}
      </div>
      <details className={css.section}>
        <summary>{t('githubAdvanced')}</summary>

        <form
          className={css.form}
          onSubmit={(event) => {
            event.preventDefault()
            void work(async () => {
              const bytes = await download(
                source,
                512 * 1024,
                AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(15000)]),
              )
              setListings(catalog(JSON.parse(new TextDecoder().decode(bytes)), new URL(source, location.href).href))
            })
          }}
        >
          <label htmlFor="cordis-source">{t('cordisCatalog')}</label>
          <div className={css.row}>
            <Input id="cordis-source" value={source} onChange={event =>{  setSource(event.target.value); }} />
            <Button type="submit" variant="outline" disabled={busy || source.trim() === ''}>
              {t('cordisLoad')}
            </Button>
          </div>
        </form>
        <form
          className={css.form}
          onSubmit={(event) => {
            event.preventDefault()
            void work(async () => {
              if (limits == null) return
              await review(
                await download(
                  url,
                  limits.archiveBytes,
                  AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(15000)]),
                ),
              )
            })
          }}
        >
          <label htmlFor="cordis-url">{t('cordisUrl')}</label>
          <div className={css.row}>
            <Input id="cordis-url" value={url} onChange={event =>{  setUrl(event.target.value); }} />
            <Button type="submit" variant="outline" disabled={busy || limits == null || url.trim() === ''}>
              {t('cordisCheck')}
            </Button>
            <Button variant="outline" disabled={busy || limits == null} onClick={() => file.current?.click()}>
              {t('cordisFile')}
            </Button>
          </div>
          <input
            ref={file}
            type="file"
            className={css.file}
            accept=".tgz,.tar.gz,application/gzip"
            aria-label={t('cordisFile')}
            onChange={(event) => {
              const selected = event.target.files?.[0]
              event.target.value = ''
              if (selected !== undefined)
                void work(async () => {
                  if (limits == null || selected.size > limits.archiveBytes) {
                    setProblem('cordisSize')
                    return
                  }
                  await review(new Uint8Array(await selected.arrayBuffer()))
                })
            }}
          />
        </form>
      </details>
      <Input
        type="search"
        aria-label={t('search')}
        placeholder={t('searchHint')}
        value={search}
        onChange={event =>{  setSearch(event.target.value); }}
      />
      <div className={css.heading}>
        <h2>{t('cordisInstalled')}</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            void work(() => load())
          }}
        >
          {t('cordisRefresh')}
        </Button>
      </div>
      {bundles.length === 0 && <p className={css.note}>{t('cordisEmpty')}</p>}
      <div className={css.grid}>
        {bundles
          .filter(b => `${b.name} ${b.description ?? ''}`.toLowerCase().includes(search.toLowerCase()))
          .map(b => (
            <article key={b.name} className={css.card}>
              <div className={css.heading}>
                <h3>{b.name}</h3>
                <Tag>{b.version ?? ''}</Tag>
              </div>
              <p>{b.description}</p>
              <Tag>{t(b.enabled ? 'cordisEnabled' : 'cordisDisabled')}</Tag>
              <div className={css.actions}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void work(() => result(props.enable(b.name, !b.enabled)))
                  }}
                >
                  {t(b.enabled ? 'cordisDisable' : 'cordisEnable')}
                </Button>
                <details>
                  <summary>{t('cordisRemove')}</summary>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || !b.removable}
                    onClick={() => {
                      void work(() => result(props.remove(b.name)))
                    }}
                  >
                    {t('cordisConfirmRemove')}
                  </Button>
                </details>
              </div>
            </article>
          ))}
      </div>
      {listings.length > 0 && <h2>{t('available')}</h2>}
      <div className={css.grid}>
        {listings
          .filter(b => `${b.name} ${b.description ?? ''}`.toLowerCase().includes(search.toLowerCase()))
          .map(b => (
            <article key={b.name + b.version} className={css.card}>
              <h3>{b.name}</h3>
              <Tag>{b.version}</Tag>
              <p>{b.description}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || limits == null}
                onClick={() => {
                  void work(async () => {
                    if (limits != null)
                      await review(
                        await download(
                          b.url,
                          limits.archiveBytes,
                          AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(15000)]),
                        ),
                        b,
                      )
                  })
                }}
              >
                {t('cordisCheck')}
              </Button>
              <a href={b.url} download rel="noreferrer">
                {t('download')}
              </a>
            </article>
          ))}
      </div>
      {candidate !== undefined && (
        <Modal
          open
          onClose={() => {
            if (!busy) setCandidate(undefined)
          }}
          closeLabel={t('cordisCancel')}
          title={t('cordisReview')}
        >
          <div className={css.section}>
            <h3>{candidate.report.name}</h3>
            {candidate.source !== undefined && <p className={css.note}>{candidate.source}</p>}
            <p>{candidate.report.version}</p>
            <p>{candidate.report.compatible ? t('cordisReady') : t(failure(candidate.report.problem))}</p>
            {candidate.report.compatible && (
              <>
                <p>{t('cordisWarning')}</p>
                <label className={css.row}>
                  <input type="checkbox" checked={trusted} onChange={event =>{  setTrusted(event.target.checked); }} />
                  {t('cordisTrust')}
                </label>
              </>
            )}
            {problem !== undefined && <p role="alert">{t(problem)}</p>}
            <div className={css.actions}>
              <Button variant="outline" disabled={busy} onClick={() =>{  setCandidate(undefined); }}>
                {t('cordisCancel')}
              </Button>
              <Button
                disabled={busy || !candidate.report.compatible || !trusted}
                onClick={() => {
                  void work(async () => {
                    await result(props.install(candidate.encoded, trusted))
                    setCandidate(undefined)
                  })
                }}
              >
                {t('cordisInstall')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
