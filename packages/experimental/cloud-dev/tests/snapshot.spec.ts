/** Cloud snapshots must exclude browser application storage even inside a workspace. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { snapshot } from '../src/snapshot.ts'

it('keeps application storage and private environment files out of a selected workspace snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cloud-snapshot-'))
  const home = join(root, 'home')
  try {
    await mkdir(home)
    await writeFile(join(home, 'credentials.sqlite'), 'private application data')
    await writeFile(join(root, '.env'), 'PRIVATE_VALUE=excluded')
    await writeFile(join(root, '.env.example'), 'EXAMPLE_VALUE=template')
    await writeFile(join(root, 'build.mjs'), 'console.log(42)')
    const files = await snapshot(root, ['**'], undefined, [home])
    expect(files.map(file => file.path)).toEqual(['.env.example', 'build.mjs'])
    await expect(snapshot(home, [], undefined, [home])).rejects.toThrow('cannot upload application storage')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
