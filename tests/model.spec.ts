import { describe, expect, it } from 'vitest'
import { summarizeFindings } from '../src/model.ts'

describe('summarizeFindings', () => {
  it('counts every severity independently', () => {
    expect(summarizeFindings([
      { checkId: 'a', severity: 'BLOCKER', conclusion: 'a' },
      { checkId: 'b', severity: 'WARNING', conclusion: 'b' },
      { checkId: 'c', severity: 'PASS', conclusion: 'c' },
      { checkId: 'd', severity: 'PASS', conclusion: 'd' },
    ])).toEqual({ blocker: 1, warning: 1, info: 0, pass: 2 })
  })
})
