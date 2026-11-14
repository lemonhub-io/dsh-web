/** Cloud development panel: the chain's health, job submission, connection settings and job history. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, Input, Modal,
  IconCheckCircleFillRegular, IconLoadingOutlineRegular, IconRefreshOutlineRegular, IconRightUpOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudDevSettings, CloudDevStatus, CloudJob, CloudJobResult, CloudRunRequest, CloudStartedJob } from '../types.ts'
import css from './CloudPage.module.css'

/** Remote calls unwrapped to values; failures throw an Error whose message is safe to show. */
export interface CloudDevFace {
  status(): Promise<CloudDevStatus>
  configure(settings: CloudDevSettings): Promise<void>
  saveToken(token: string): Promise<void>
  setup(): Promise<'created' | 'updated' | 'unchanged'>
  start(request: CloudRunRequest): Promise<CloudStartedJob>
  jobs(): Promise<CloudJob[]>
  cancel(id: string): Promise<CloudJob>
  collect(id: string, directory?: string): Promise<CloudJobResult>
}
/** Inputs from the slot renderer and the client plugin. */
export type CloudPageProps = PropsRuntime<'main'> & PropsLocale<'cloudDev'> & InjectFace<CloudDevFace>

type Tone = 'ok' | 'warn' | 'bad' | 'idle'
const lines = (value: string): string[] => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)

function Spinner(): ReactNode {
  return <IconLoadingOutlineRegular size={14} className={css.spin} />
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return new Date(iso).toLocaleDateString()
}

/**
 * Render the panel.
 * @param props - localized face over the cloudDev Remote.
 * @returns the cloud development page.
 */
export function CloudPage(props: CloudPageProps): ReactNode {
  const { t } = props
  const [status, setStatus] = useState<CloudDevStatus>()
  const [settings, setSettings] = useState<CloudDevSettings>({ gatewayUrl: '', repository: '', workflow: 'dsh-cloud-run.yml' })
  const [token, setToken] = useState('')
  const [command, setCommand] = useState('')
  const [directory, setDirectory] = useState('')
  const [include, setInclude] = useState('')
  const [outputs, setOutputs] = useState('')
  const [workdir, setWorkdir] = useState('')
  const [jobs, setJobs] = useState<CloudJob[]>([])
  const [result, setResult] = useState<CloudJobResult>()
  const [pending, setPending] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const ready = status?.gateway === 'ok' && status.repository === 'ok' && status.workflow === 'installed'

  const loadJobs = useCallback(async (): Promise<void> => {
    const list = await props.jobs()
    if (alive.current) setJobs(list)
  }, [props])
  const loadStatus = useCallback(async (first = false): Promise<CloudDevStatus> => {
    const next = await props.status()
    if (!alive.current) return next
    setStatus(next)
    if (first) {
      setSettings(next.settings)
      setDirectory(current => current === '' ? next.defaultDirectory : current)
    }
    return next
  }, [props])

  const work = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (pending !== undefined) return
    setPending(key)
    setProblem(undefined)
    setNotice(undefined)
    try {
      await action()
    } catch (error) {
      if (alive.current) setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current) setPending(undefined)
    }
  }

  useEffect(() => {
    void work('load', async () => {
      const next = await loadStatus(true)
      if (next.gateway === 'ok' && next.repository === 'ok') await loadJobs()
    })
  }, [])

  // Poll while any job is still on its way; GitHub is the only record of progress.
  const active = jobs.some(job => job.status !== 'completed')
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => { void loadJobs().catch(() => undefined) }, 5000)
    return () => { clearInterval(timer) }
  }, [active, loadJobs])

  const gatewayTone: Tone = status === undefined ? 'idle' : status.gateway === 'ok' ? 'ok' : status.gateway === 'unset' ? 'idle' : 'bad'
  const actionsTone: Tone = status === undefined ? 'idle'
    : status.repository === 'ok' ? status.workflow === 'installed' ? 'ok' : 'warn'
      : status.repository === 'unset' ? 'idle' : 'bad'
  const actionsLabel = status === undefined ? t('loading')
    : status.repository === 'ok' ? status.workflow === 'installed' ? t('stateOk') : t('stateMissing')
      : status.repository === 'unset' ? t('stateUnset') : status.repository === 'unauthorized' ? t('stateDenied') : t('stateDown')
  const gatewayLabel = status === undefined ? t('loading') : status.gateway === 'ok' ? t('stateOk') : status.gateway === 'unset' ? t('stateUnset') : t('stateDown')

  const jobState = (job: CloudJob): { label: string; tone: Tone } => {
    if (job.status !== 'completed') return job.status === 'in_progress' ? { label: t('running'), tone: 'warn' } : { label: t('queued'), tone: 'idle' }
    if (job.conclusion === 'success') return { label: t('success'), tone: 'ok' }
    if (job.conclusion === 'cancelled') return { label: t('cancelled'), tone: 'idle' }
    return { label: t('failed'), tone: 'bad' }
  }

  const node = (name: string, role: string, tone: Tone, label: string): ReactNode => (
    <div className={css.node} data-tone={tone}>
      <span className={css.nodeName}>{name}</span>
      <span className={css.nodeRole}>{role}</span>
      <span className={css.nodeState}><span className={css.dot} />{label}</span>
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
          <div className={css.chain} aria-label={t('title')}>
            {node(t('chainWeb'), t('chainWebRole'), 'ok', t('stateOk'))}
            <span className={css.link} data-live={gatewayTone === 'ok'} aria-hidden="true" />
            {node(t('chainGateway'), t('chainGatewayRole'), gatewayTone, gatewayLabel)}
            <span className={css.link} data-live={actionsTone === 'ok'} aria-hidden="true" />
            {node(t('chainActions'), t('chainActionsRole'), actionsTone, actionsLabel)}
          </div>
        </header>

        <div className={css.feedback} aria-live="polite">
          {problem !== undefined && <p className={css.alert} role="alert"><IconWarningTriangleOutlineRegular size={16} />{problem}</p>}
          {notice !== undefined && <p className={css.notice} role="status"><IconCheckCircleFillRegular size={16} />{notice}</p>}
        </div>

        <div className={css.columns}>
          <form
            className={css.card}
            onSubmit={(event) => {
              event.preventDefault()
              void work('start', async () => {
                const started = await props.start({
                  command,
                  ...directory.trim() === '' ? {} : { directory: directory.trim() },
                  ...lines(include).length === 0 ? {} : { include: lines(include) },
                  ...lines(outputs).length === 0 ? {} : { outputs: lines(outputs) },
                  ...workdir.trim() === '' ? {} : { workdir: workdir.trim() },
                })
                if (!alive.current) return
                setNotice(t('started', { files: started.files }))
                setJobs(current => [started.job, ...current.filter(job => job.id !== started.job.id)])
              })
            }}
          >
            <h2>{t('runTitle')}</h2>
            <label className={css.field}>
              <span>{t('command')}</span>
              <textarea
                className={css.command}
                value={command}
                placeholder={t('commandHint')}
                rows={3}
                spellCheck={false}
                onChange={(event) => { setCommand(event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span>{t('directory')}</span>
              <Input value={directory} spellCheck={false} onChange={(event) => { setDirectory(event.target.value) }} />
            </label>
            <div className={css.pair}>
              <label className={css.field}>
                <span>{t('include')}</span>
                <Input value={include} placeholder={t('includeHint')} spellCheck={false} onChange={(event) => { setInclude(event.target.value) }} />
              </label>
              <label className={css.field}>
                <span>{t('outputs')}</span>
                <Input value={outputs} placeholder={t('outputsHint')} spellCheck={false} onChange={(event) => { setOutputs(event.target.value) }} />
              </label>
            </div>
            <label className={css.field}>
              <span>{t('workdir')}</span>
              <Input value={workdir} placeholder="." spellCheck={false} onChange={(event) => { setWorkdir(event.target.value) }} />
            </label>
            <div className={css.actions}>
              {!ready && status !== undefined && <span className={css.hint}>{t('notReady')}</span>}
              <Button type="submit" variant="primary" disabled={pending !== undefined || !ready || command.trim() === ''} icon={pending === 'start' ? <Spinner /> : undefined}>
                {pending === 'start' ? t('starting') : t('run')}
              </Button>
            </div>
          </form>

          <form
            className={css.card}
            onSubmit={(event) => {
              event.preventDefault()
              void work('save', async () => {
                await props.configure(settings)
                if (token.trim() !== '') await props.saveToken(token.trim())
                if (!alive.current) return
                setToken('')
                const next = await loadStatus()
                if (next.repository === 'ok') await loadJobs()
                setNotice(t('saved'))
              })
            }}
          >
            <h2>{t('settingsTitle')}</h2>
            <label className={css.field}>
              <span>{t('gatewayUrl')}</span>
              <Input value={settings.gatewayUrl} placeholder="https://gateway.example.com" spellCheck={false}
                onChange={(event) => { setSettings({ ...settings, gatewayUrl: event.target.value }) }} />
            </label>
            <label className={css.field}>
              <span>{t('repository')}</span>
              <Input value={settings.repository} placeholder="owner/dsh-cloud-runner" spellCheck={false}
                onChange={(event) => { setSettings({ ...settings, repository: event.target.value }) }} />
            </label>
            <label className={css.field}>
              <span>{t('token')}</span>
              <Input type="password" value={token} autoComplete="off"
                placeholder={status?.tokenPresent === true ? t('tokenSaved') : t('tokenHint')}
                onChange={(event) => { setToken(event.target.value) }} />
            </label>
            <label className={css.field}>
              <span>{t('workflow')}</span>
              <Input value={settings.workflow} spellCheck={false}
                onChange={(event) => { setSettings({ ...settings, workflow: event.target.value }) }} />
            </label>
            <div className={css.actions}>
              <Button
                variant="outline"
                disabled={pending !== undefined || status?.repository !== 'ok'}
                icon={pending === 'setup' ? <Spinner /> : status?.workflow === 'installed' ? <IconCheckCircleFillRegular size={14} /> : undefined}
                onClick={() => {
                  void work('setup', async () => {
                    await props.setup()
                    await loadStatus()
                    if (alive.current) setNotice(t('setupDone'))
                  })
                }}
              >
                {status?.workflow === 'installed' ? t('setupDone') : t('setup')}
              </Button>
              <Button type="submit" variant="primary" disabled={pending !== undefined} icon={pending === 'save' ? <Spinner /> : undefined}>
                {t('save')}
              </Button>
            </div>
          </form>
        </div>

        <section className={css.jobs} aria-labelledby="cloud-jobs">
          <div className={css.sectionHead}>
            <h2 id="cloud-jobs">{t('jobsTitle')}</h2>
            {jobs.length > 0 && <span className={css.count}>{jobs.length}</span>}
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('refresh')}
              title={t('refresh')}
              disabled={pending !== undefined || status?.repository !== 'ok'}
              onClick={() => { void work('jobs', loadJobs) }}
            >
              {pending === 'jobs' ? <Spinner /> : <IconRefreshOutlineRegular size={16} />}
            </button>
          </div>
          {jobs.length === 0
            ? <div className={css.empty}>{pending === 'load' ? t('loading') : t('noJobs')}</div>
            : (
              <ul className={css.list}>
                {jobs.map((job) => {
                  const state = jobState(job)
                  return (
                    <li key={job.id} className={css.job}>
                      <span className={css.pill} data-tone={state.tone}>
                        {job.status !== 'completed' && <span className={css.pulse} />}
                        {state.label}
                      </span>
                      <div className={css.jobMain}>
                        <code className={css.jobCommand} title={job.command}>{job.command}</code>
                        <span className={css.jobMeta}>{job.id} · {relativeTime(job.createdAt)}</span>
                      </div>
                      <div className={css.jobActions}>
                        {job.status === 'completed'
                          ? (
                            <Button variant="outline" size="sm" disabled={pending !== undefined} icon={pending === 'collect:' + job.id ? <Spinner /> : undefined}
                              onClick={() => {
                                void work('collect:' + job.id, async () => {
                                  const value = await props.collect(job.id, directory.trim() === '' ? undefined : directory.trim())
                                  if (alive.current) setResult(value)
                                })
                              }}
                            >
                              {t('collect')}
                            </Button>
                          )
                          : (
                            <Button variant="ghost" size="sm" disabled={pending !== undefined}
                              onClick={() => {
                                void work('cancel:' + job.id, async () => {
                                  const next = await props.cancel(job.id)
                                  if (alive.current) setJobs(current => current.map(item => item.id === next.id ? next : item))
                                })
                              }}
                            >
                              {t('cancel')}
                            </Button>
                          )}
                        {job.url !== null && (
                          <a className={css.iconButton} href={job.url} target="_blank" rel="noreferrer" aria-label={t('openRun')} title={t('openRun')}>
                            <IconRightUpOutlineRegular size={16} />
                          </a>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
        </section>
      </div>

      {result !== undefined && (
        <Modal
          open
          onClose={() => { setResult(undefined) }}
          closeLabel={t('close')}
          title={t('resultTitle')}
          footer={<Button variant="primary" onClick={() => { setResult(undefined) }}>{t('close')}</Button>}
        >
          <div className={css.result}>
            <div className={css.resultHead}>
              <span className={css.pill} data-tone={result.exitCode === 0 ? 'ok' : 'bad'}>{t('exitCode', { code: result.exitCode ?? '?' })}</span>
              {result.durationSeconds !== null && <span className={css.jobMeta}>{t('duration', { seconds: result.durationSeconds })}</span>}
              <code className={css.jobMeta}>{result.job.id}</code>
            </div>
            <div className={css.field}>
              <span>{t('resultDir')}</span>
              <code className={css.path}>{result.directory}</code>
            </div>
            <div className={css.field}>
              <span>{t('files')}</span>
              {result.files.length === 0
                ? <span className={css.hint}>{t('noFiles')}</span>
                : <ul className={css.files}>{result.files.map(file => <li key={file}><code>{file}</code></li>)}</ul>}
            </div>
            <div className={css.field}>
              <span>{t('output')}</span>
              <pre className={clsx(css.log)}>{result.log}</pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
