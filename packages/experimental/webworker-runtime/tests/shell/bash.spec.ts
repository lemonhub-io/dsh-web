/**
 * The shell a model reaches through `bash -c`: real bash grammar and commands over
 * the VFS, `git` included, and grants enforced on everything the run touches.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { setActiveVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/active.ts'
import { isShellCommand, MISSING_PROGRAM_HINT, runShellCommand, runShellProgram } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/interpret.ts'
import { hostFileSystem } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/fs-access.ts'
import { landlockFileSystem } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/landlock.ts'

const WORKSPACE = '/dsh/workspace'
let vfs: MemoryVfs

const run = async (source: string) => await runShellCommand(source, { cwd: WORKSPACE, env: { HOME: '/dsh/home' } })

beforeEach(() => {
  vfs = new MemoryVfs()
  vfs.seedDirectory(WORKSPACE)
  vfs.seedDirectory('/dsh/home')
  vfs.seedDirectory('/dsh/tmp')
  setActiveVfs(vfs)
})

describe('bash grammar and commands', () => {
  it('runs loops, functions, and case statements the previous grammar refused', async () => {
    const result = await run('greet() { case "$1" in a) echo first;; *) echo other;; esac; }; for v in a b; do greet "$v"; done')
    expect(result).toMatchObject({ exitCode: 0, stdout: 'first\nother\n' })
  })

  it('reads and writes the VFS through globs, pipes, and redirections', async () => {
    vfs.writeFileSync(`${WORKSPACE}/one.txt`, 'alpha\nbeta\n')
    vfs.writeFileSync(`${WORKSPACE}/two.txt`, 'beta\n')
    const result = await run('grep -l beta *.txt | sort -r | awk \'{ print toupper($0) }\' > out.txt; cat out.txt')
    expect(result.stdout).toBe('TWO.TXT\nONE.TXT\n')
    expect(vfs.readFileSync(`${WORKSPACE}/out.txt`, 'utf8')).toBe('TWO.TXT\nONE.TXT\n')
  })

  it('keeps binary bytes intact when copying', async () => {
    const bytes = new Uint8Array([0, 255, 128, 10])
    vfs.writeFileSync(`${WORKSPACE}/blob`, bytes)
    await run('cp blob copy')
    expect([...vfs.readFileSync(`${WORKSPACE}/copy`) as Uint8Array]).toEqual([...bytes])
  })

  it('maps /tmp onto the VFS temp directory', async () => {
    await run('echo scratch > /tmp/note')
    expect(vfs.readFileSync('/dsh/tmp/note', 'utf8')).toBe('scratch\n')
  })

  it('passes program arguments verbatim', async () => {
    const result = await runShellProgram(['printf', '%s', 'it\'s $HOME'], { cwd: WORKSPACE, env: {} })
    expect(result.stdout).toBe('it\'s $HOME')
  })

  it('names missing programs in bash wording and states once that the browser shell cannot run them', async () => {
    const result = await run('npm install; python3 -c 1')
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toBe(`bash: npm: command not found\nbash: python3: command not found\n${MISSING_PROGRAM_HINT}`)
  })

  it('reports which programs can start without a shell line', () => {
    expect(isShellCommand('grep')).toBe(true)
    expect(isShellCommand('git')).toBe(true)
    expect(isShellCommand('no-such-program')).toBe(false)
  })
})

describe('git', () => {
  it('records and reports a working tree', async () => {
    const script = [
      'git init -q .',
      'git config user.name tester',
      'git config user.email tester@example.test',
      'printf "one\\n" > file.txt',
      'git status --porcelain',
      'git add .',
      'git commit -m first',
      'printf "two\\n" > file.txt',
      'git status --porcelain',
      'git diff',
      'git log --oneline',
    ].join(' && ')
    const result = await run(script)
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('?? file.txt')
    expect(result.stdout).toContain(' M file.txt')
    expect(result.stdout).toContain('-one\n+two\n')
    expect(result.stdout).toMatch(/[0-9a-f]{7} first\n/u)
  })

  it('fails outside a repository', async () => {
    const result = await run('git status')
    expect(result.exitCode).not.toBe(0)
  })
})

describe('confinement', () => {
  it('refuses a write outside the grants, from both the shell and git', async () => {
    vfs.seedDirectory(`${WORKSPACE}/open`)
    vfs.seedDirectory(`${WORKSPACE}/closed`)
    const fs = await landlockFileSystem(hostFileSystem(), {
      kind: 'run', readOnly: [WORKSPACE], readWrite: [`${WORKSPACE}/open`], argv: [],
    }, WORKSPACE)
    const options = { cwd: `${WORKSPACE}/closed`, env: {}, fs }
    const redirected = await runShellCommand('echo x > denied.txt', options)
    expect(redirected.exitCode).not.toBe(0)
    expect(vfs.existsSync(`${WORKSPACE}/closed/denied.txt`)).toBe(false)
    const initialized = await runShellCommand('git init .', options)
    expect(initialized.exitCode).not.toBe(0)
    expect(vfs.existsSync(`${WORKSPACE}/closed/.git`)).toBe(false)
    const allowed = await runShellCommand(`echo ok > ${WORKSPACE}/open/note.txt`, options)
    expect(allowed.exitCode).toBe(0)
  })
})
