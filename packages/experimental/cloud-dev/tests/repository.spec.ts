/** A pasted runner choice resolves to owner/name, so a copied link or remote never fails the connection. */
import { expect, it } from 'vitest'
import { parseRepository } from '../src/github.ts'

it('accepts owner/name, repository links and SSH remotes and selects the automatic runner when empty', () => {
  expect(parseRepository('  ')).toBe('')
  expect(parseRepository('octo-org/runner.repo')).toBe('octo-org/runner.repo')
  expect(parseRepository('https://github.com/octo-org/runner/tree/main?tab=readme')).toBe('octo-org/runner')
  expect(parseRepository('github.com/octo-org/runner.git/')).toBe('octo-org/runner')
  expect(parseRepository('git@github.com:octo-org/runner.git')).toBe('octo-org/runner')
})

it('rejects text that names no repository with a localizable cause', () => {
  for (const input of ['octo-org', 'https://github.com/octo-org', 'octo org/runner', 'octo-org/..'])
    expect(() => parseRepository(input)).toThrow(expect.objectContaining({ problem: 'runner-missing' }))
})
