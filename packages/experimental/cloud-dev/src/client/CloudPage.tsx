/** One-time cloud connection and observation of AI-controlled computing tasks. */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Button,
  IconRightUpOutlineRegular,
  IconShieldOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  StateDot,
  Tag,
  relativeTime,
  type StateDotState,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudConnectRequest, CloudDevProblem, CloudDevStatus, CloudJob } from '../types.ts'
import type { CloudDevKey } from './locales.ts'
import css from './CloudPage.module.css'

/** A failed panel operation; a known `problem` selects localized copy, otherwise the message is shown. */
export class CloudPanelError extends Error {
  /**
   * @param message - host diagnostic shown when no localized cause applies.
   * @param problem - known cause reported by the host.
   */
  constructor(message: string, readonly problem?: CloudDevProblem) {
    super(message)
    this.name = 'CloudPanelError'
  }
}

/** Account connection and read-only job observation The Agent owns task execution. */
export interface CloudDevFace {
  status(): Promise<CloudDevStatus>
  connect(request: CloudConnectRequest): Promise<CloudDevStatus>
  disconnect(): Promise<CloudDevStatus>
  jobs(): Promise<CloudJob[]>
}
/** Framework-supplied locale and connection callbacks. */
export type CloudPageProps = PropsRuntime<'main'> & PropsLocale<'cloudDev'> & InjectFace<CloudDevFace>

/** Classic token creation with the two scopes the runner needs already selected. */
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=DSH%20cloud%20compute'
const ACTIVE_POLL_MS = 5000
const IDLE_POLL_MS = 30000

const PROBLEM_KEY: Record<Exclude<CloudDevProblem, 'none'>, CloudDevKey> = {
  'token-missing': 'problemTokenMissing',
  'token-invalid': 'problemTokenInvalid',
  'token-scopes': 'problemTokenScopes',
  'gateway': 'problemGateway',
  'runner-missing': 'problemRunnerMissing',
  'runner-denied': 'problemRunnerDenied',
  'unknown': 'problemUnknown',
}

function stateTone(problem: CloudDevProblem): TagTone {
  if (problem === 'none') return 'success'
  return problem === 'token-missing' ? 'neutral' : 'warning'
}

function jobDot(job: CloudJob): StateDotState {
  if (job.status !== 'completed') return 'ongoing'
  if (job.conclusion === 'success') return 'done'
  return job.conclusion === 'cancelled' ? 'idle' : 'error'
}

/** Render the connection and the AI's cloud task history.
 * @param props Locale and account connection operations.
 * @returns A monitor without manual command submission or artifact collection controls.
 */
export function CloudPage(props: CloudPageProps): ReactNode {
  const { t } = props
  const [status, setStatus] = useState<CloudDevStatus>()
  const [editing, setEditing] = useState(false)
  const [token, setToken] = useState('')
  const [repository, setRepository] = useState('')
  const [busy, setBusy] = useState<'connect' | 'disconnect'>()
  const [checking, setChecking] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [jobs, setJobs] = useState<CloudJob[]>()
  const [jobsFailed, setJobsFailed] = useState(false)
  const alive = useRef(true)
  const editingRef = useRef(false)
  editingRef.current = editing

  const describe = (error: unknown, fallback: CloudDevKey): string => {
    if (error instanceof CloudPanelError && error.problem !== undefined && error.problem !== 'none')
      return t(PROBLEM_KEY[error.problem])
    return error instanceof Error && error.message !== '' ? error.message : t(fallback)
  }
  const accept = (next: CloudDevStatus): void => {
    setStatus(next)
    // A background refresh never replaces what the person is typing.
    if (!editingRef.current) setRepository(next.settings.repository)
  }
  const readStatus = async (): Promise<void> => {
    setChecking(true)
    try {
      const next = await props.status()
      if (alive.current) accept(next)
    } catch (error) {
      if (alive.current) setProblem(describe(error, 'failedStatus'))
    } finally {
      if (alive.current) setChecking(false)
    }
  }
  useEffect(() => {
    alive.current = true
    void readStatus()
    return () => {
      alive.current = false
    }
  }, [])

  const ready = status?.problem === 'none'
  const runner = status?.runner ?? null
  useEffect(() => {
    if (!ready) {
      setJobs(undefined)
      return
    }
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      clearTimeout(timer)
      if (running || stopped) return
      running = true
      let active = false
      try {
        if (document.visibilityState !== 'hidden') {
          const list = await props.jobs()
          active = list.some(job => job.status !== 'completed')
          if (!stopped) {
            setJobs(list)
            setJobsFailed(false)
          }
        }
      } catch (_readFailed) {
        // The notice stays beside the last list; the next poll retries and the status shows a lasting cause.
        if (!stopped) {
          setJobsFailed(true)
          setJobs(previous => previous ?? [])
          void readStatus()
        }
      } finally {
        running = false
      }
      if (!stopped) timer = setTimeout(() => void tick(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    }
    const visible = (): void => {
      if (document.visibilityState === 'visible') void tick()
    }
    void tick()
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [ready, runner])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (busy !== undefined) return
    setBusy('connect')
    setProblem(undefined)
    props
      .connect({ token: token.trim(), repository: repository.trim() })
      .then((next) => {
        if (!alive.current) return
        editingRef.current = false
        setEditing(false)
        setToken('')
        accept(next)
      })
      .catch((error: unknown) => {
        if (alive.current) setProblem(describe(error, 'failedConnect'))
      })
      .finally(() => {
        if (alive.current) setBusy(undefined)
      })
  }
  const disconnect = (): void => {
    if (busy !== undefined) return
    setBusy('disconnect')
    setProblem(undefined)
    props
      .disconnect()
      .then((next) => {
        if (!alive.current) return
        editingRef.current = false
        setEditing(false)
        setToken('')
        accept(next)
      })
      .catch((error: unknown) => {
        if (alive.current) setProblem(describe(error, 'failedConnect'))
      })
      .finally(() => {
        if (alive.current) setBusy(undefined)
      })
  }

  const tokenStored = status !== undefined && status.problem !== 'token-missing'
  const showForm = status !== undefined && (status.problem === 'token-missing' || editing)
  const now = Date.now()

  const timeLabel = (iso: string): string => {
    const { unit, n } = relativeTime(Date.parse(iso), now)
    if (unit === 'now') return t('timeNow')
    const key: Record<typeof unit, CloudDevKey> = {
      minutes: 'timeMinutes',
      hours: 'timeHours',
      days: 'timeDays',
      months: 'timeMonths',
      years: 'timeYears',
    }
    return t(key[unit], { n })
  }
  const jobLabel = (job: CloudJob): string => {
    if (job.status !== 'completed') return t(job.status === 'in_progress' ? 'running' : 'queued')
    if (job.conclusion === 'success') return t('success')
    return t(job.conclusion === 'cancelled' ? 'cancelled' : 'failed')
  }

  const connectForm = (
    <form className={css.card} onSubmit={submit} aria-labelledby="cloud-connect">
      <div className={css.cardHead}>
        <h2 id="cloud-connect">{t(editing ? 'editTitle' : 'connectTitle')}</h2>
        <p className={css.muted}>{t('connectLead')}</p>
      </div>
      <ol className={css.steps}>
        <li className={css.step}>
          <span className={css.stepNumber} aria-hidden="true">1</span>
          <div className={css.stepText}>
            <span className={css.stepTitle}>{t('stepCreate')}</span>
            <p className={css.muted}>{t('stepCreateHint')}</p>
          </div>
          <a className={css.linkButton} href={TOKEN_URL} target="_blank" rel="noreferrer">
            {t('createToken')}
            <IconRightUpOutlineRegular size={14} />
          </a>
        </li>
        <li className={css.step}>
          <span className={css.stepNumber} aria-hidden="true">2</span>
          <label className={css.stepField}>
            <span className={css.stepTitle}>{t('stepPaste')}</span>
            <Input
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder={tokenStored ? t('tokenKept') : t('tokenPlaceholder')}
              onChange={(event) => {
                setToken(event.target.value)
              }}
            />
          </label>
        </li>
      </ol>
      <details className={css.advanced} open={status?.settings.repository !== ''}>
        <summary>{t('existingRepo')}</summary>
        <label className={css.field}>
          <span className={css.srOnly}>{t('runner')}</span>
          <Input
            value={repository}
            spellCheck={false}
            placeholder={t('repositoryPlaceholder')}
            onChange={(event) => {
              setRepository(event.target.value)
            }}
          />
          <span className={css.muted}>{t('repositoryHint')}</span>
        </label>
      </details>
      {problem !== undefined && (
        <p className={css.error} role="alert">
          <IconWarningOutlineRegular size={16} />
          <span>{problem}</span>
        </p>
      )}
      <div className={css.formFooter}>
        <p className={css.privacy}>
          <IconShieldOutlineRegular size={14} />
          <span>{t('privacy')}</span>
        </p>
        <div className={css.actions}>
          {editing && tokenStored && (
            <Button variant="ghost" disabled={busy !== undefined} onClick={disconnect}>
              {t(busy === 'disconnect' ? 'disconnecting' : 'disconnect')}
            </Button>
          )}
          {editing && (
            <Button
              variant="outline"
              disabled={busy !== undefined}
              onClick={() => {
                setEditing(false)
                setToken('')
                setProblem(undefined)
                setRepository(status?.settings.repository ?? '')
              }}
            >
              {t('cancel')}
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={busy !== undefined || (token.trim() === '' && !tokenStored)}
          >
            {t(busy === 'connect' ? 'connecting' : editing ? 'save' : 'connect')}
          </Button>
        </div>
      </div>
    </form>
  )

  const connection = status !== undefined && (
    <section className={css.card} aria-label={t('connectionLabel')}>
      <div className={css.summary}>
        <dl className={css.facts}>
          {status.account !== null && (
            <div>
              <dt>{t('account')}</dt>
              <dd>{status.account}</dd>
            </div>
          )}
          {status.runner !== null && (
            <div>
              <dt>{t('runner')}</dt>
              <dd>
                <a href={`https://github.com/${status.runner}`} target="_blank" rel="noreferrer">
                  {status.runner}
                  <IconRightUpOutlineRegular size={14} />
                </a>
              </dd>
            </div>
          )}
        </dl>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setProblem(undefined)
            setEditing(true)
          }}
        >
          {t('edit')}
        </Button>
      </div>
      {status.problem !== 'none' && status.problem !== 'token-missing' && (
        <div className={css.notice} role="status">
          <IconWarningOutlineRegular size={16} />
          <span>{t(PROBLEM_KEY[status.problem])}</span>
          {(status.problem === 'gateway' || status.problem === 'unknown') && (
            <Button variant="ghost" size="sm" disabled={checking} onClick={() => void readStatus()}>
              {t('retry')}
            </Button>
          )}
        </div>
      )}
      {problem !== undefined && (
        <p className={css.error} role="alert">
          <IconWarningOutlineRegular size={16} />
          <span>{problem}</span>
        </p>
      )}
    </section>
  )

  return (
    <div className={css.page}>
      <div className={css.content}>
        <header className={css.heading}>
          <div className={css.titleRow}>
            <h1>{t('title')}</h1>
            {status !== undefined && (
              <Tag tone={stateTone(status.problem)}>
                {t(status.problem === 'none' ? 'stateReady' : status.problem === 'token-missing' ? 'stateNeeded' : 'stateProblem')}
              </Tag>
            )}
          </div>
          <p className={css.lead}>{t('intro')}</p>
        </header>
        {status === undefined ? (
          problem === undefined ? (
            <div className={css.loading}>
              <StateDot state="ongoing" size={20} />
            </div>
          ) : (
            <div className={css.notice} role="alert">
              <IconWarningOutlineRegular size={16} />
              <span>{problem}</span>
              <Button variant="ghost" size="sm" disabled={checking} onClick={() => void readStatus()}>
                {t('retry')}
              </Button>
            </div>
          )
        ) : showForm ? connectForm : connection}
        {ready && (
          <section className={css.jobs} aria-labelledby="cloud-jobs">
            <h2 id="cloud-jobs">{t('jobsTitle')}</h2>
            {jobsFailed && <p className={css.muted}>{t('failedJobs')}</p>}
            {jobs === undefined ? (
              <ul className={css.list} aria-busy="true">
                {[0, 1, 2].map(row => (
                  <li key={row} className={css.skeletonRow}>
                    <span className={css.skeletonDot} />
                    <span className={css.skeletonText} />
                  </li>
                ))}
              </ul>
            ) : jobs.length === 0 ? (
              <p className={css.empty}>{t('noJobs')}</p>
            ) : (
              <ul className={css.list}>
                {jobs.map((job) => {
                  const body = (
                    <>
                      <span className={css.rowGlyph}>
                        <StateDot state={jobDot(job)} />
                      </span>
                      <span className={css.rowContent}>
                        <span className={css.rowTitle}>{job.command === '' ? job.id : job.command}</span>
                        <span className={css.rowSummary}>
                          <span>{jobLabel(job)}</span>
                          <span>{timeLabel(job.createdAt)}</span>
                          <span>{job.id}</span>
                        </span>
                      </span>
                      {job.url !== null && (
                        <span className={css.rowAction} aria-hidden="true">
                          <IconRightUpOutlineRegular size={14} />
                        </span>
                      )}
                    </>
                  )
                  return (
                    <li key={job.id}>
                      {job.url === null ? (
                        <div className={css.row}>{body}</div>
                      ) : (
                        <a className={css.row} href={job.url} target="_blank" rel="noreferrer" title={t('openRun')}>
                          {body}
                        </a>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
