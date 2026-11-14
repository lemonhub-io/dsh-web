/** One-time cloud connection and observation of AI-controlled computing tasks. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudDevSettings, CloudDevStatus, CloudJob } from '../types.ts'
import css from './CloudPage.module.css'

/** Account connection and read-only job observation The Agent owns task execution. */
export interface CloudDevFace {
  status(): Promise<CloudDevStatus>
  configure(settings: CloudDevSettings): Promise<void>
  saveToken(token: string): Promise<void>
  setup(): Promise<'created' | 'updated' | 'unchanged'>
  jobs(): Promise<CloudJob[]>
}
/** Framework-supplied locale and connection callbacks. */
export type CloudPageProps = PropsRuntime<'main'> & PropsLocale<'cloudDev'> & InjectFace<CloudDevFace>

/** Render connection settings and the AI's cloud task history.
 * @param props Locale and account connection operations.
 * @returns A monitor without manual command submission or artifact collection controls.
 */
export function CloudPage(props: CloudPageProps): ReactNode {
  const { t } = props
  const [status, setStatus] = useState<CloudDevStatus>()
  const [settings, setSettings] = useState<CloudDevSettings>({
    gatewayUrl: '',
    repository: '',
    workflow: 'dsh-cloud-run.yml',
  })
  const [token, setToken] = useState('')
  const [jobs, setJobs] = useState<CloudJob[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const alive = useRef(false)
  const generation = useRef(0)
  const connected =
    status?.tokenPresent === true &&
    status.gateway === 'ok' &&
    (status.settings.repository === '' ? status.repository === 'unset' : status.repository === 'ok')

  const refresh = async (first = false, signal?: AbortSignal): Promise<void> => {
    const request = ++generation.current
    const current = await props.status()
    const list = current.repository === 'ok' && current.workflow === 'installed' ? await props.jobs() : []
    if (!alive.current || signal?.aborted === true || request !== generation.current) return
    setStatus(current)
    setJobs(list)
    if (first) setSettings(current.settings)
    setProblem(undefined)
  }
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (first: boolean): Promise<void> => {
      try {
        await refresh(first, controller.signal)
      } catch (error) {
        if (alive.current) setProblem(error instanceof Error ? error.message : t('failedRefresh'))
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void poll(false)
          }, 5000)
      }
    }
    void poll(true)
    return () => {
      alive.current = false
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  const jobState = (job: CloudJob): string =>
    job.status !== 'completed'
      ? t(job.status === 'in_progress' ? 'running' : 'queued')
      : t(job.conclusion === 'success' ? 'success' : job.conclusion === 'cancelled' ? 'cancelled' : 'failed')

  return (
    <div className={css.page}>
      <div className={css.content}>
        <header className={css.hero}>
          <div className={css.heading}>
            <h1>{t('title')}</h1>
            <Tag>{t(status === undefined ? 'loading' : connected ? 'stateOk' : 'stateUnset')}</Tag>
          </div>
          <p>{t('intro')}</p>
          <div className={css.flow}>
            <section>
              <h2>{t('planTitle')}</h2>
              <p>{t('planText')}</p>
            </section>
            <section>
              <h2>{t('computeTitle')}</h2>
              <p>{t('computeText')}</p>
            </section>
            <section>
              <h2>{t('returnTitle')}</h2>
              <p>{t('returnText')}</p>
            </section>
          </div>
        </header>
        <p className={css.note}>{t('automatic')}</p>
        {problem !== undefined && (
          <p className={css.alert} role="alert">
            {problem}
          </p>
        )}
        <form
          className={css.card}
          onSubmit={(event) => {
            event.preventDefault()
            if (busy) return
            setBusy(true)
            setProblem(undefined)
            void (async () => {
              await props.configure(settings)
              if (token.trim() !== '') await props.saveToken(token.trim())
              await props.setup()
              if (!alive.current) return
              setToken('')
              await refresh(true)
            })()
              .catch((error: unknown) => {
                if (alive.current) setProblem(error instanceof Error ? error.message : t('failedConnect'))
              })
              .finally(() => {
                if (alive.current) setBusy(false)
              })
          }}
        >
          <h2>{t('settingsTitle')}</h2>
          <p className={css.note}>{t('connectionHelp')}</p>
          <label className={css.field}>
            <span>{t('token')}</span>
            <Input
              type="password"
              value={token}
              autoComplete="off"
              placeholder={status?.tokenPresent === true ? t('tokenSaved') : t('tokenHint')}
              onChange={(event) => {
                setToken(event.target.value)
              }}
            />
          </label>
          <details className={css.advanced}>
            <summary>{t('advanced')}</summary>
            <div className={css.fields}>
              <label className={css.field}>
                <span>{t('repository')}</span>
                <Input
                  value={settings.repository}
                  placeholder={t('repositoryHint')}
                  onChange={(event) => {
                    setSettings({ ...settings, repository: event.target.value })
                  }}
                />
              </label>
              <label className={css.field}>
                <span>{t('gatewayUrl')}</span>
                <Input
                  value={settings.gatewayUrl}
                  onChange={(event) => {
                    setSettings({ ...settings, gatewayUrl: event.target.value })
                  }}
                />
              </label>
              <label className={css.field}>
                <span>{t('workflow')}</span>
                <Input
                  value={settings.workflow}
                  onChange={(event) => {
                    setSettings({ ...settings, workflow: event.target.value })
                  }}
                />
              </label>
            </div>
          </details>
          <div className={css.actions}>
            <Button
              type="submit"
              disabled={busy || status === undefined || (token.trim() === '' && !status.tokenPresent)}
            >
              {t(busy ? 'connecting' : connected ? 'save' : 'connect')}
            </Button>
          </div>
        </form>
        <section className={css.jobs} aria-labelledby="cloud-jobs">
          <div className={css.heading}>
            <h2 id="cloud-jobs">{t('jobsTitle')}</h2>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                void refresh().catch((error: unknown) => {
                  if (alive.current) setProblem(error instanceof Error ? error.message : t('failedRefresh'))
                })
              }}
            >
              {t('refresh')}
            </Button>
          </div>
          {jobs.length === 0 ? (
            <p className={css.empty}>{t('noJobs')}</p>
          ) : (
            <ul className={css.list}>
              {jobs.map(job => (
                <li key={job.id} className={css.job}>
                  <div className={css.jobMain}>
                    <h3>{job.command}</h3>
                    <p className={css.note}>{job.id}</p>
                  </div>
                  <Tag>{jobState(job)}</Tag>
                  {job.url !== null && (
                    <a href={job.url} target="_blank" rel="noreferrer">
                      {t('openRun')}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
