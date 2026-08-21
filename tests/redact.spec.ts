import { describe, expect, it } from 'vitest'
import type { DiagnosticReport } from '../src/model.ts'
import { sanitizeReport } from '../src/redact.ts'

const roots = {
  userHome: 'C:\\Users\\Alice',
  dshHome: 'C:\\Users\\Alice\\.dsh',
  temp: 'C:\\Users\\Alice\\AppData\\Local\\Temp',
}

function report(value: string): DiagnosticReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-20T00:00:00.000Z',
    environment: { value },
    target: { dshHome: value },
    summary: { blocker: 0, warning: 0, info: 0, pass: 0 },
    findings: [{ checkId: value, severity: 'INFO', conclusion: value, evidence: [value], remediation: [value] }],
    limitations: [value],
  }
}

function redacted(value: string, customRoots = roots): string {
  return JSON.stringify(sanitizeReport(report(value), customRoots))
}

describe('sanitizeReport', () => {
  it('removes every sentinel from every serialized report string', () => {
    const dshHome = roots.dshHome
    const entropy = 'aB3$eF6!hJ9@kL2#mN5%pQ8&rS1*tV4+xY7=zC0?dE3'
    const sentinels = [
      roots.userHome,
      dshHome,
      roots.temp,
      'https://user:pass@example.com/a?token=SECRET#frag',
      'Authorization: Bearer SECRET',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'DEEPSEEK_API_KEY=SECRET',
      'ghp_0123456789abcdefghijklmnopqrstuv',
      entropy,
    ]
    const raw = report(sentinels.join(' | '))

    const result = JSON.stringify(sanitizeReport(raw, roots))

    for (const sentinel of sentinels) {
      expect(result.toLowerCase()).not.toContain(sentinel.toLowerCase())
    }
    expect(result).toContain('<USER_HOME>')
    expect(result).toContain('<DSH_HOME>')
    expect(result).toContain('<TEMP>')
    expect(result).toContain('https://example.com/a')
    expect(raw.target.dshHome).toBe(sentinels.join(' | '))
  })

  it('replaces roots case-insensitively with the longest matching root and ignores empty roots', () => {
    const result = redacted('c:\\USERS\\ALICE\\.DSH\\profiles; C:\\Users\\Alice\\notes; C:\\Temp', {
      userHome: 'C:\\Users\\Alice',
      dshHome: 'C:\\Users\\Alice\\.dsh',
      temp: '',
    })

    expect(result).toContain('<DSH_HOME>\\\\profiles')
    expect(result).toContain('<USER_HOME>\\\\notes')
    expect(result).toContain('C:\\\\Temp')
  })

  it('escapes regex metacharacters in roots', () => {
    const result = redacted('C:\\Users\\A.+(lice)\\.dsh\\config', {
      userHome: 'C:\\Users\\A.+(lice)',
      dshHome: 'C:\\Users\\A.+(lice)\\.dsh',
      temp: 'C:\\Temp',
    })

    expect(result).toContain('<DSH_HOME>\\\\config')
  })

  it('strips URL credentials, query strings, and fragments without consuming punctuation or malformed URLs', () => {
    const result = redacted('See (https://user:pass@example.com/a?token=SECRET#frag), then https://example.com/b. Bad https://%zz.')

    expect(result).toContain('(https://example.com/a),')
    expect(result).toContain('https://example.com/b.')
    expect(result).toContain('https://%zz.')
  })

  it('redacts credential assignments, authorization credentials, and recognized token forms', () => {
    const result = redacted('api-key: SECRET; DEEPSEEK_API_KEY=SECRET; Authorization: Bearer SECRET; Authorization: Basic dXNlcjpwYXNzd29yZA==; Authorization: Digest username="doctor"; response="digest-secret"; GHP_0123456789ABCDEFGHIJKLMNOPQRSTUV; SK-abcdefghijklmnopqrstuvwxyz0123456789')

    expect(result).not.toContain('SECRET')
    expect(result).not.toContain('dXNlcjpwYXNzd29yZA==')
    expect(result).not.toContain('username="doctor"')
    expect(result).not.toContain('response="digest-secret"')
    expect(result.toLowerCase()).not.toContain('ghp_0123456789abcdefghijklmnopqrstuv')
    expect(result.toLowerCase()).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('redacts a short secret assigned to GITHUB_TOKEN', () => {
    const result = redacted('GITHUB_TOKEN=short-secret')

    expect(result).not.toContain('short-secret')
  })

  it('redacts a short secret assigned to GH_TOKEN', () => {
    const result = redacted('GH_TOKEN=short-secret')

    expect(result).not.toContain('short-secret')
  })

  it('redacts lowercase github_pat tokens without relying on entropy', () => {
    const token = 'github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const result = redacted(token)

    expect(result).not.toContain(token)
  })

  it('keeps ordinary prose and non-credential identifiers', () => {
    const value = 'The feature_flag=enabled has tokenized_label=ordinary-id and retry_count=3.'

    expect(redacted(value)).toContain(value)
  })

  it('redacts high-entropy 32-character tokens without redacting ordinary prose or identifiers', () => {
    const token = 'aB3$eF6!hJ9@kL2#mN5%pQ8&rS1*tV4+'
    const result = redacted(`The profile doctor-01 is valid. ${token}`)

    expect(result).not.toContain(token)
    expect(result).toContain('The profile doctor-01 is valid.')
  })
})
