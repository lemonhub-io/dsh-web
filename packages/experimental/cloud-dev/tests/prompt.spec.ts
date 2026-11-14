/** The cloud execution prompt is model-visible, so each workspace's wording is pinned verbatim. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { BROWSER_ENVIRONMENT, cloudGuidance } from '../src/prompt.ts'

const expected = async (name: string): Promise<string> =>
  (await readFile(new URL(`./expected/${name}.expected.md`, import.meta.url), 'utf8')).trimEnd()

it('tells a browser workspace to run all code with cloud_run', async () => {
  expect(BROWSER_ENVIRONMENT).toBe(await expected('browser-environment'))
  expect(cloudGuidance('browser')).toBe(await expected('browser-guidance'))
})

it('offers the cloud runner beside the local shell in a local workspace', async () => {
  expect(cloudGuidance('local')).toBe(await expected('local-guidance'))
})
