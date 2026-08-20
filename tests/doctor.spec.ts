import { describe, expect, it, vi } from 'vitest'
import { runDoctor } from '../src/doctor.ts'
import type { DiagnosticReport } from '../src/model.ts'
import type { SanitizedReport } from '../src/index.ts'
import type { SystemAccess } from '../src/system.ts'

function assertPublicIndexDoesNotExposeRawReport(): void {
  // @ts-expect-error DiagnosticReport is not part of the public API.
  const raw: import('../src/index.ts').DiagnosticReport = undefined as never
  void raw
}
void assertPublicIndexDoesNotExposeRawReport

function assertPublicTypeBoundary(rawReport: DiagnosticReport): void {
  // @ts-expect-error A raw report cannot satisfy the public sanitized result type.
  const unsafePublicReport: SanitizedReport = rawReport
  void unsafePublicReport
}
void assertPublicTypeBoundary

const state = vi.hoisted(() => ({
  error: undefined as unknown,
  calls: [] as string[],
}))

vi.mock('../src/checks/commands.ts', () => ({
  checkCommands: vi.fn(async () => {
    state.calls.push('commands')
    if (state.error === 'commands') throw new Error('Authorization: Bearer SECRET at C:\\Users\\Alice')
    return { findings: [{ checkId: 'commands.ok', severity: 'PASS', conclusion: 'commands' }], limitations: [], commands: {} }
  }),
}))

vi.mock('../src/checks/runtime.ts', () => ({
  checkRuntime: vi.fn(async () => {
    state.calls.push('runtime')
    if (state.error === 'runtime') throw new TypeError('DEEPSEEK_API_KEY=SECRET')
    return { findings: [{ checkId: 'runtime.ok', severity: 'PASS', conclusion: 'runtime' }], limitations: [], environment: { 'runtime.path': 'C:\\Users\\Alice\\runtime' } }
  }),
}))

vi.mock('../src/checks/profile.ts', () => ({
  checkProfile: vi.fn(async () => {
    state.calls.push('profile')
    if (state.error === 'profile') throw new RangeError('ghp_0123456789abcdefghijklmnopqrstuv')
    return {
      findings: [{ checkId: 'profile.blocker', severity: 'BLOCKER', conclusion: 'profile' }],
      limitations: [],
      dshHome: 'C:\\Users\\Alice\\.dsh',
      availableProfiles: [],
    }
  }),
}))

vi.mock('../src/checks/windows.ts', () => ({
  checkWindows: vi.fn(async () => {
    state.calls.push('windows')
    if (state.error === 'windows') throw new SyntaxError('https://user:pass@example.com/a?token=SECRET#frag')
    return { findings: [{ checkId: 'windows.ok', severity: 'PASS', conclusion: 'windows' }], limitations: [] }
  }),
}))

function system(platform: NodeJS.Platform = 'win32'): SystemAccess {
  return {
    platform,
    environment: {},
    homeDir: 'C:\\Users\\Alice',
    tempDir: 'C:\\Users\\Alice\\AppData\\Local\\Temp',
    now: () => new Date('2026-08-20T00:00:00.000Z'),
  } as SystemAccess
}

describe('runDoctor', () => {
  it('contains command failures and continues through profile and Windows checks', async () => {
    state.error = 'commands'
    state.calls.length = 0

    const result = await runDoctor({ profile: 'doctor' }, system())

    expect(state.calls).toEqual(['commands', 'runtime', 'profile', 'windows'])
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'doctor.group.commands', severity: 'WARNING', conclusion: 'The commands check group failed with Error.' }),
      expect.objectContaining({ checkId: 'profile.blocker', severity: 'BLOCKER' }),
      expect.objectContaining({ checkId: 'windows.ok', severity: 'PASS' }),
    ]))
    expect(result.limitations).toContain('The commands check group did not complete.')
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain('C:\\Users\\Alice')
  })

  it.each([
    ['runtime', 'TypeError'],
    ['profile', 'RangeError'],
    ['windows', 'SyntaxError'],
  ] as const)('contains a thrown %s group without leaking its raw error', async (group, errorClass) => {
    state.error = group
    state.calls.length = 0

    const result = await runDoctor({}, system())

    expect(state.calls).toEqual(['commands', 'runtime', 'profile', 'windows'])
    expect(result.findings.filter(({ checkId }) => checkId === `doctor.group.${group}`)).toEqual([
      expect.objectContaining({ severity: 'WARNING', conclusion: `The ${group} check group failed with ${errorClass}.` }),
    ])
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain('ghp_0123456789abcdefghijklmnopqrstuv')
    expect(JSON.stringify(result)).not.toContain('user:pass@example.com')
  })

  it('rejects a non-Windows system before invoking any checks', async () => {
    state.error = undefined
    state.calls.length = 0

    await expect(runDoctor({}, system('linux'))).rejects.toThrow('DSH Doctor requires Windows.')

    expect(state.calls).toEqual([])
  })
})
