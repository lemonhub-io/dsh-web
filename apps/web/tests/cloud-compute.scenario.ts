/** AI programming acceptance through the real Worker with a scripted model and optional live cloud runner. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import type { BrowserContext, Page, Route } from 'playwright'
import { zipSync } from 'fflate'
import { workerRemote as remote } from './worker-rpc.ts'

const GATEWAY = 'https://dsh-gw.openhub.today'
const BUILD = `import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
if(process.env.DSH_CLOUD_SETUP!=='ready')throw new Error('Cloud setup environment was lost');
const answer=Number(execFileSync(process.execPath,['-e','process.stdout.write(String(6*7))'],{encoding:'utf8'}));
writeFileSync('report.json',JSON.stringify({answer,node:process.versions.node}));
console.log('Native process computed',answer);
`
const SETUP = 'export DSH_CLOUD_SETUP=ready\nnode --version'

/** Execute the installed workflow's task and output steps as the external runner fixture. */
async function runFixture(workflow: string, command: string): Promise<Uint8Array> {
  const document = load(workflow) as { jobs: { run: { steps: { name?: string; run?: string }[] } } }
  const root = await mkdtemp(join(tmpdir(), 'dsh-cloud-runner-'))
  try {
    await mkdir(join(root, 'workspace'))
    await writeFile(join(root, 'workspace', 'build.mjs'), BUILD)
    for (const name of ['Run command', 'Collect outputs']) {
      const script = document.jobs.run.steps.find(step => step.name === name)?.run
      if (script === undefined) throw new Error('Runner workflow step missing ' + name)
      await promisify(execFile)('bash', ['-e', '-o', 'pipefail', '-c', script], {
        cwd: root,
        env: {
          PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''),
          GITHUB_WORKSPACE: root,
          DSH_SETUP: SETUP,
          DSH_COMMAND: command,
          DSH_WORKDIR: '.',
          DSH_OUTPUTS: 'report.json',
        },
        timeout: 30000,
      })
    }
    const files: Record<string, Uint8Array> = {}
    for (const path of ['output.log', 'exit-code', 'duration-seconds', 'files/report.json'])
      files[path] = await readFile(join(root, '.dsh-cloud', path))
    if (new TextDecoder().decode(files['exit-code']).trim() !== '0')
      throw new Error('Cloud runner command failed')
    return zipSync(files)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
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
  const expectedEnvironment = await readFile(new URL('../../../packages/experimental/cloud-dev/tests/expected/browser-environment.expected.md', import.meta.url), 'utf8')
  const expectedGuidance = await readFile(new URL('../../../packages/experimental/cloud-dev/tests/expected/browser-guidance.expected.md', import.meta.url), 'utf8')
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
  let fixtureResult: Uint8Array | undefined
  let repositoryPrivate = false
  const visibilityUpdates: boolean[] = []
  let healthReads = 0
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
      request.method() === 'POST' || request.method() === 'PUT' || request.method() === 'PATCH'
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
        inputs.setup !== SETUP ||
        inputs.node_version !== '24' ||
        inputs.outputs !== 'report.json'
      )
        throw new Error('AI task configuration did not reach the runner')
      if (token !== undefined && !path.startsWith('repos/lemonhub-io/'))
        throw new Error('Live acceptance must only use lemonhub-io')
      run = { id: inputs.job, command: 'Validate native Node process', status: 'completed', conclusion: 'success' }
      if (token === undefined) fixtureResult = await runFixture(workflow, inputs.command)
    }
    if (token !== undefined) {
      await route.continue()
      return
    }
    if (url.pathname === '/health') {
      if (healthReads++ === 0) {
        await json(route, 503, {})
        return
      }
      await json(route, 200, { service: 'dsh-cloud-gateway' })
      return
    }
    if (path === 'user') {
      await json(route, 200, { login: 'cloud-fixture' })
      return
    }
    if (path === 'user/repos') {
      if (body.private !== false || body.auto_init !== true)
        throw new Error('The public runner choice did not reach repository creation')
      repository = true
      await json(route, 201, { private: false, default_branch: 'main' })
      return
    }
    if (path === 'repos/cloud-fixture/dsh-cloud-runner') {
      if (request.method() === 'PATCH') {
        if (!repository || typeof body.private !== 'boolean')
          throw new Error('Invalid repository visibility update')
        repositoryPrivate = body.private
        visibilityUpdates.push(repositoryPrivate)
      }
      await json(
        route,
        repository ? 200 : 404,
        repository ? { private: repositoryPrivate, default_branch: 'main' } : { message: 'Not found' },
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
      if (fixtureResult === undefined) throw new Error('Runner fixture did not produce an artifact')
      await route.fulfill({ status: 200, headers, body: Buffer.from(fixtureResult) })
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
      system?: string | { type: string; text?: string }[]
      tools?: { name: string }[]
      messages: unknown[]
    }
    const names = (body.tools ?? []).map(tool => tool.name),
      history = JSON.stringify(body.messages),
      last = JSON.stringify(body.messages.at(-1))
    const lastMessage = body.messages.at(-1) as {
      content?: { type: string; content?: { type: string; text?: string }[] }[]
    }
    const lastOutput = (lastMessage.content ?? []).flatMap(block => block.content ?? []).map(block => block.text ?? '').join('\n')
    let call: { name: string; args: object } | undefined
    if (names.includes('cloud_run') && history.includes('CLOUD-AI-COMPUTE')) {
      const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map(block => block.text ?? '').join('\n')
      if (!history.includes(expectedEnvironment.trimEnd()) || !system.includes(expectedGuidance.trimEnd()))
        throw new Error('Browser environment or cloud programming guidance differs from recorded text')
      if (stage === 0) {
        call = { name: 'cloud_status', args: {} }
        stage++
      } else if (stage === 1) {
        if (token === undefined && (!lastOutput.includes('"problem":"gateway"') || !lastOutput.includes('"status":"failed"')))
          throw new Error('A transient cloud failure was classified as a connection problem')
        call = { name: 'cloud_status', args: {} }
        stage++
      } else if (stage === 2) {
        if (!lastOutput.includes('"status":"ready"')) throw new Error('Cloud readiness did not recover')
        call = { name: 'write', args: { file_path: 'build.mjs', content: BUILD } }
        stage++
      } else if (stage === 3) {
        call = { name: 'write', args: { file_path: '.env', content: 'DUMMY_SECRET=must-not-upload' } }
        stage++
      } else if (stage === 4) {
        call = {
          name: 'cloud_run',
          args: {
            description: 'Validate native Node process',
            command: 'node build.mjs',
            setup: SETUP,
            node_version: '24',
            include: ['build.mjs', '.env'],
            outputs: ['report.json'],
            wait: false,
          },
        }
        stage++
      } else {
        let value: { status?: string; jobId?: string; directory?: string; exitCode?: number } | undefined
        for (const block of lastMessage.content ?? [])
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
  const openPanel = async (): Promise<void> => {
    for (const dialog of await page.getByRole('dialog').all()) {
      const close = dialog.getByRole('button', { name: /^(关闭|Close)$/ }).first()
      if (await close.isVisible()) await close.click()
    }
    if (await page.getByRole('heading', { name: '云原生开发', exact: true }).isVisible()) return
    const entry = page.getByRole('button', { name: '云原生开发', exact: true })
    if (!(await entry.isVisible())) await page.getByRole('button', { name: '更多', exact: true }).first().click()
    await page.getByText('云原生开发', { exact: true }).click()
  }
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-composer-input]').first().waitFor({ timeout: 150000 })
    const notice = page.getByRole('button', { name: '继续', exact: true })
    if (await notice.isVisible()) await notice.click()
    await remote(page, 'credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-cloud-compute-fixture' })
    await remote(page, 'credentials/set', { ref: 'DSH_CLOUD_GITHUB_TOKEN', value: token ?? 'cloud-fixture-token' })
    if (token === undefined) {
      await openPanel()
      await page.getByRole('button', { name: '修改', exact: true }).click()
      const choice = page.getByRole('switch', { name: '公开运行仓库', exact: true })
      if ((await choice.getAttribute('aria-checked')) !== 'false')
        throw new Error('Existing settings without visibility did not default to private')
      await choice.click()
      await page.getByText('公开仓库中的工作区快照和运行日志可被任何人查看', { exact: true }).waitFor()
      await page.setViewportSize({ width: 390, height: 844 })
      await choice.scrollIntoViewIfNeeded()
      await capture?.(page, 'cloud-public-connection')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.getByRole('heading', { name: 'AI 计算任务', exact: true }).waitFor()
      const connected = await remote<{ settings: { visibility: string }; visibility: string; problem: string }>(page, 'cloudDev/status', {})
      if (connected.problem !== 'none' || connected.settings.visibility !== 'public' || connected.visibility !== 'public')
        throw new Error('The public runner connection or saved visibility was lost')
      checks.push('Legacy settings default to private and the UI creates and saves a public runner with an exposure notice')
      await page.getByRole('button', { name: '修改', exact: true }).click()
      if ((await choice.getAttribute('aria-checked')) !== 'true')
        throw new Error('The settings control did not reflect actual GitHub visibility')
      await page.getByText('使用已有仓库', { exact: true }).click()
      await page.getByPlaceholder('owner/name 或仓库链接', { exact: true }).fill('cloud-fixture/dsh-cloud-runner')
      await choice.click()
      await capture?.(page, 'cloud-existing-visibility')
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.getByRole('heading', { name: '修改连接', exact: true }).waitFor({ state: 'hidden' })
      const privateStatus = await remote<{ visibility: string }>(page, 'cloudDev/status', {})
      if (privateStatus.visibility !== 'private') throw new Error('Settings did not make the named repository private')
      await page.getByRole('button', { name: '修改', exact: true }).click()
      if ((await choice.getAttribute('aria-checked')) !== 'false')
        throw new Error('The confirmed private state did not survive reopening settings')
      await choice.click()
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.getByRole('heading', { name: '修改连接', exact: true }).waitFor({ state: 'hidden' })
      const publicStatus = await remote<{ visibility: string }>(page, 'cloudDev/status', {})
      if (publicStatus.visibility !== 'public' || JSON.stringify(visibilityUpdates) !== '[true,false]')
        throw new Error('Settings did not apply and confirm both visibility changes')
      checks.push('Settings change a named existing repository to private and back to public with confirmed GitHub state')
      await page.setViewportSize({ width: 1280, height: 960 })
      healthReads = 0
    }
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
    if (token === undefined && JSON.stringify(visibilityUpdates) !== '[true,false]')
      throw new Error('AI compute changed the repository visibility outside an explicit settings save')
    checks.push('The AI wrote code locally and selected cloud computing through logged tool calls')
    checks.push('The assembled model request contains the recorded browser restrictions and complete cloud programming guidance')
    checks.push('A transient cloud outage reports failed and recovers without requesting credentials or local execution')
    checks.push('The installed runner workflow preserves setup exports through native task execution and output collection')
    checks.push('The runner and workflow were prepared automatically and an existing public runner accepts compute tasks')
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
    await openPanel()
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
