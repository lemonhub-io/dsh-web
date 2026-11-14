/** AI programming acceptance through the real Worker with a scripted model and optional live cloud runner. */
import { randomUUID } from 'node:crypto'
import type { BrowserContext, Page, Route } from 'playwright'
import { zipSync, strToU8 } from 'fflate'
import { workerRemote as remote } from './worker-rpc.ts'

const GATEWAY = 'https://dsh-gw.openhub.today'
const BUILD = `import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const answer=Number(execFileSync(process.execPath,['-e','process.stdout.write(String(6*7))'],{encoding:'utf8'}));
writeFileSync('report.json',JSON.stringify({answer,node:process.versions.node}));
console.log('Native process computed',answer);
`
function modelResponse(model: string, call?: { name: string; args: object }): string {
  const events: string[] = []
  const emit = (type: string, data: object): void => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  }
  emit('message_start', {
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  if (call !== undefined) {
    emit('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: randomUUID(), name: call.name, input: {} },
    })
    emit('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) },
    })
  } else {
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Cloud task inspected' } })
  }
  emit('content_block_stop', { index: 0 })
  emit('message_delta', {
    delta: { stop_reason: call === undefined ? 'end_turn' : 'tool_use' },
    usage: { output_tokens: 1 },
  })
  emit('message_stop', {})
  return events.join('')
}
interface Run {
  id: string
  command: string
  status: string
  conclusion: string | null
}

/** Drive an AI from local code creation through cloud execution and artifact inspection.
 * @param context Fresh caller-owned browser context.
 * @param origin Built static site.
 * @param token Optional live GitHub credential It is placed only in the ephemeral browser credential store.
 * @param capture Optional rendered evidence callback.
 * @returns Verified cloud job identity and native computation output.
 */
export async function cloudComputeScenario(
  context: BrowserContext,
  origin: string,
  token?: string,
  capture?: (page: Page, name: string) => Promise<void>,
): Promise<{ jobId: string; report: string; checks: string[]; errors: string[] }> {
  const checks: string[] = [],
    errors: string[] = []
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  }
  let repository = false,
    workflow = '',
    run: Run | undefined,
    originRecord = '',
    dispatches = 0,
    runReads = 0
  let stage = 0,
    jobId = '',
    resultDirectory = '',
    report = '',
    complete = false,
    foreignDenied = false
  let resolveDone: (() => void) | undefined, resolveDenied: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const denied = new Promise<void>((resolve) => {
    resolveDenied = resolve
  })
  const json = async (route: Route, status: number, value: object): Promise<void> => {
    await route.fulfill({
      status,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
  }
  const cloudRoute = async (route: Route): Promise<void> => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.hostname === 'api.github.com' ? url.pathname.slice(1) : url.pathname.slice('/github/'.length)
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers })
      return
    }
    const body =
      request.method() === 'POST' || request.method() === 'PUT'
        ? (request.postDataJSON() as Record<string, unknown>)
        : {}
    if (path.endsWith('/git/trees') && request.method() === 'POST') {
      const entries = body.tree as { path: string; content?: string }[]
      if (entries.some(entry => entry.path === 'workspace/.env'))
        throw new Error('Cloud snapshot leaked an environment file')
      const record = entries.find(entry => entry.path === '.dsh-cloud-request.json')
      if (record?.content !== undefined) originRecord = record.content
    }
    if (path.endsWith('/dispatches')) {
      dispatches++
      console.log('Cloud task dispatched ' + String((body.inputs as { job: string }).job))
      const inputs = body.inputs as {
        job: string
        command: string
        setup: string
        node_version: string
        outputs: string
      }
      if (
        inputs.command !== 'node build.mjs' ||
        inputs.setup !== 'node --version' ||
        inputs.node_version !== '24' ||
        inputs.outputs !== 'report.json'
      )
        throw new Error('AI task configuration did not reach the runner')
      if (token !== undefined && !path.startsWith('repos/lemonhub-io/'))
        throw new Error('Live acceptance must only use lemonhub-io')
      run = { id: inputs.job, command: 'Validate native Node process', status: 'completed', conclusion: 'success' }
    }
    if (token !== undefined) {
      await route.continue()
      return
    }
    if (url.pathname === '/health') {
      await json(route, 200, { service: 'dsh-cloud-gateway' })
      return
    }
    if (path === 'user') {
      await json(route, 200, { login: 'cloud-fixture' })
      return
    }
    if (path === 'user/repos') {
      if (body.private !== true || body.auto_init !== true)
        throw new Error('Automatic runner was not private and initialized')
      repository = true
      await json(route, 201, { private: true, default_branch: 'main' })
      return
    }
    if (path === 'repos/cloud-fixture/dsh-cloud-runner') {
      await json(
        route,
        repository ? 200 : 404,
        repository ? { private: true, default_branch: 'main' } : { message: 'Not found' },
      )
      return
    }
    if (path.includes('/contents/.github/workflows/')) {
      if (request.method() === 'PUT') {
        workflow = Buffer.from(String(body.content), 'base64').toString()
        if (!workflow.includes('DSH_SETUP') || !workflow.includes('persist-credentials: false'))
          throw new Error('Wrong runner workflow')
        await json(route, 201, { content: { sha: 'workflow' } })
        return
      }
      await json(
        route,
        workflow === '' ? 404 : 200,
        workflow === ''
          ? { message: 'Not found' }
          : { sha: 'workflow', content: Buffer.from(workflow).toString('base64') },
      )
      return
    }
    if (path.endsWith('/contents/.dsh-cloud-request.json')) {
      await json(route, 200, { content: Buffer.from(originRecord).toString('base64') })
      return
    }
    if (path.includes('/git/ref/heads/')) {
      await json(route, 200, { object: { sha: 'head' } })
      return
    }
    if (path.endsWith('/git/commits/head')) {
      await json(route, 200, { tree: { sha: 'base' } })
      return
    }
    if (path.endsWith('/git/trees') || path.endsWith('/git/commits')) {
      await json(route, 201, { sha: path.endsWith('/git/trees') ? 'tree' : 'snapshot' })
      return
    }
    if (path.endsWith('/git/refs')) {
      await json(route, 201, { ref: body.ref })
      return
    }
    if (path.includes('/git/refs/heads/')) {
      await route.fulfill({ status: 204, headers })
      return
    }
    if (path.endsWith('/actions/workflows/dsh-cloud-run.yml')) {
      await json(route, workflow === '' ? 404 : 200, {})
      return
    }
    if (path.endsWith('/dispatches')) {
      await route.fulfill({ status: 204, headers })
      return
    }
    if (path.endsWith('/runs') && path.includes('/actions/workflows/')) {
      runReads++
      await json(route, 200, {
        workflow_runs:
          run === undefined || runReads === 1
            ? []
            : [
              {
                id: 99,
                head_branch: 'dsh-cloud/' + run.id,
                head_sha: 'snapshot',
                status: run.status,
                conclusion: run.conclusion,
                html_url: 'https://github.com/cloud-fixture/dsh-cloud-runner/actions/runs/99',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                head_commit: { message: 'dsh-cloud ' + run.id + ': ' + run.command },
              },
            ],
      })
      return
    }
    if (path.endsWith('/actions/runs/99/artifacts')) {
      await json(route, 200, { artifacts: [{ id: 7, name: 'dsh-cloud-result', expired: false }] })
      return
    }
    if (path.endsWith('/actions/artifacts/7/zip')) {
      const zip = zipSync({
        'output.log': strToU8('Native process computed 42'),
        'exit-code': strToU8('0'),
        'duration-seconds': strToU8('1'),
        'files/report.json': strToU8('{"answer":42,"node":"24.fixture"}'),
      })
      await route.fulfill({ status: 200, headers, body: Buffer.from(zip) })
      return
    }
    throw new Error('Unimplemented cloud fixture endpoint ' + request.method() + ' ' + path)
  }
  await context.route(GATEWAY + '/**', cloudRoute)
  await context.route('https://api.github.com/**', cloudRoute)

  await context.route('https://api.deepseek.com/**', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers })
      return
    }
    if (!route.request().url().endsWith('/messages')) {
      await json(route, 200, { object: 'list', data: [] })
      return
    }
    const body = route.request().postDataJSON() as {
      model: string
      system?: unknown
      tools?: { name: string }[]
      messages: unknown[]
    }
    const names = (body.tools ?? []).map(tool => tool.name),
      history = JSON.stringify(body.messages),
      last = JSON.stringify(body.messages.at(-1))
    let call: { name: string; args: object } | undefined
    if (names.includes('cloud_run') && history.includes('CLOUD-AI-COMPUTE')) {
      if (!JSON.stringify(body.system).includes('Do not ask the user to type commands'))
        throw new Error('Cloud programming guidance missing from model request')
      if (stage === 0) {
        call = { name: 'write', args: { file_path: 'build.mjs', content: BUILD } }
        stage++
      } else if (stage === 1) {
        call = { name: 'write', args: { file_path: '.env', content: 'DUMMY_SECRET=must-not-upload' } }
        stage++
      } else if (stage === 2) {
        call = {
          name: 'cloud_run',
          args: {
            description: 'Validate native Node process',
            command: 'node build.mjs',
            setup: 'node --version',
            node_version: '24',
            include: ['build.mjs', '.env'],
            outputs: ['report.json'],
            wait: false,
          },
        }
        stage++
      } else {
        const message = body.messages.at(-1) as {
          content?: { type: string; content?: { type: string; text?: string }[] }[]
        }
        let value: { status?: string; jobId?: string; directory?: string; exitCode?: number } | undefined
        for (const block of message.content ?? [])
          for (const text of block.content ?? []) {
            if (text.type === 'text' && text.text?.startsWith('{')) {
              try {
                value = JSON.parse(text.text) as typeof value
              } catch (_nonJsonToolOutput) {
                /* File tools also return text. */
              }
            }
          }
        if (value?.jobId !== undefined) jobId = value.jobId
        if (value?.status === 'running') call = { name: 'cloud_job', args: { id: jobId, timeout_seconds: 60 } }
        else if (value?.status === 'completed' && value.directory !== undefined && value.exitCode === 0) {
          resultDirectory = value.directory
          call = { name: 'read', args: { file_path: resultDirectory + '/files/report.json' } }
        } else if (resultDirectory !== '' && last.includes('42') && last.includes('node')) {
          report = last
          complete = true
          resolveDone?.()
        } else throw new Error('AI cloud task did not return a usable result ' + last)
      }
    } else if (names.includes('cloud_job') && history.includes('CLOUD-FOREIGN')) {
      if (!last.includes('tool_result')) call = { name: 'cloud_job', args: { id: jobId, action: 'cancel' } }
      else {
        foreignDenied = last.includes('another Session or workspace') && last.includes('is_error')
        resolveDenied?.()
      }
    }
    await route.fulfill({
      status: 200,
      headers: { ...headers, 'content-type': 'text/event-stream' },
      body: modelResponse(body.model, call),
    })
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    errors.push(error.message)
  })
  const wait = async (promise: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('AI cloud task timed out'))
          }, 300000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-composer-input]').first().waitFor({ timeout: 150000 })
    const notice = page.getByRole('button', { name: '继续', exact: true })
    if (await notice.isVisible()) await notice.click()
    await remote(page, 'credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-cloud-compute-fixture' })
    await remote(page, 'credentials/set', { ref: 'DSH_CLOUD_GITHUB_TOKEN', value: token ?? 'cloud-fixture-token' })
    const session = await remote<{ sessionId: string }>(page, 'session/create', { request: {} })
    await remote(page, 'session/prompt', {
      request: {
        sessionId: session.sessionId,
        requestId: randomUUID(),
        mode: 'queue',
        content: [
          { type: 'text', text: 'CLOUD-AI-COMPUTE Build and inspect a native Node process task using cloud compute' },
        ],
      },
    })
    await wait(done)
    if (!complete || dispatches !== 1 || originRecord === '')
      throw new Error('Cloud task was duplicated or lost its immutable origin')
    checks.push('The AI wrote code locally and selected cloud computing through logged tool calls')
    checks.push('The private runner and workflow were prepared automatically without a manual setup action')
    checks.push('Setup commands toolchain versions and output selection reached one cloud dispatch')
    checks.push('Environment secrets were excluded and the immutable task origin was recorded')
    checks.push('The AI resumed a pending job collected its result and read the returned report with answer 42')
    const other = await remote<{ sessionId: string }>(page, 'session/create', { request: {} })
    await remote(page, 'session/prompt', {
      request: {
        sessionId: other.sessionId,
        requestId: randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text: 'CLOUD-FOREIGN Try to cancel the other Session cloud task' }],
      },
    })
    await wait(denied)
    if (!foreignDenied) throw new Error('A foreign Session controlled another task')
    checks.push('A different Session could not control the task')
    for (const dialog of await page.getByRole('dialog').all()) {
      const close = dialog.getByRole('button', { name: /^(关闭|Close)$/ }).first()
      if (await close.isVisible()) await close.click()
    }
    const entry = page.getByRole('button', { name: '云原生开发', exact: true })
    if (!(await entry.isVisible())) await page.getByRole('button', { name: '更多', exact: true }).first().click()
    await page.getByText('云原生开发', { exact: true }).click()
    await page.getByRole('heading', { name: 'AI 计算任务', exact: true }).waitFor()
    await page.getByText(jobId, { exact: true }).waitFor()
    if (
      (await page.getByRole('button', { name: '提交到云端', exact: true }).count()) !== 0 ||
      (await page.getByRole('button', { name: '取回结果', exact: true }).count()) !== 0
    )
      throw new Error('Manual task controls remain')
    await capture?.(page, 'cloud-compute-desktop')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    const collapse = page.getByRole('button', { name: '收起侧边栏', exact: true })
    if (await collapse.isVisible()) await collapse.click()
    await page.getByRole('heading', { name: '云原生开发', exact: true }).scrollIntoViewIfNeeded()
    await capture?.(page, 'cloud-compute-mobile')
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error('Cloud monitor overflowed mobile width')
    if (errors.length !== 0) throw new Error(errors.join('\n'))
    return { jobId, report, checks, errors }
  } catch (error) {
    await capture?.(page, 'cloud-compute-failed')
    if (jobId !== '' && !complete) {
      try {
        await remote(page, 'cloudDev/cancel', { id: jobId })
      } catch (_cancelUnconfirmed) {
        console.error('Cloud acceptance cleanup could not confirm cancellation for ' + jobId)
      }
    }
    throw error
  } finally {
    await page.close()
  }
}
