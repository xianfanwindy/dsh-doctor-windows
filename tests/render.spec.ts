import { describe, expect, it } from 'vitest'
import type { DiagnosticReport } from '../src/model.ts'
import type { SanitizedReport } from '../src/redact.ts'
import { renderJson, renderMarkdown, renderTerminal } from '../src/render.ts'

const report = {
  schemaVersion: 1,
  generatedAt: '2026-08-20T00:00:00.000Z',
  environment: { 'dsh.version': '0.1.0', 'node.version': '22.19.0' },
  target: { dshHome: '<DSH_HOME>', profile: 'doctor' },
  summary: { blocker: 1, warning: 1, info: 1, pass: 1 },
  findings: [
    { checkId: 'pass.z', severity: 'PASS', conclusion: 'Passed.', evidence: ['pass evidence'] },
    { checkId: 'warning.z', severity: 'WARNING', conclusion: 'Warned.', evidence: ['warning evidence'], remediation: ['Fix warning.'] },
    { checkId: 'blocker.z', severity: 'BLOCKER', conclusion: 'Blocked.', evidence: ['blocker evidence'], remediation: ['Fix blocker.'] },
    { checkId: 'info.z', severity: 'INFO', conclusion: 'Informational.', evidence: ['info evidence'] },
  ],
  limitations: ['One check was unavailable.'],
} as unknown as SanitizedReport

function assertRenderersRejectRawReports(raw: DiagnosticReport): void {
  // @ts-expect-error Renderers accept only SanitizedReport.
  renderTerminal(raw, { verbose: false, color: false })
  // @ts-expect-error Renderers accept only SanitizedReport.
  renderMarkdown(raw, { verbose: false })
  // @ts-expect-error Renderers accept only SanitizedReport.
  renderJson(raw)
}
void assertRenderersRejectRawReports

describe('report renderers', () => {
  it('orders a copied findings view by severity and check ID without mutating the canonical report', () => {
    const before = JSON.stringify(report)

    const terminal = renderTerminal(report, { verbose: false, color: false })
    const markdown = renderMarkdown(report, { verbose: false })

    expect(terminal).toMatch(/blocker\.z[\s\S]*warning\.z[\s\S]*info\.z[\s\S]*pass\.z/u)
    expect(markdown).toMatch(/blocker\.z[\s\S]*warning\.z[\s\S]*info\.z[\s\S]*pass\.z/u)
    expect(JSON.stringify(report)).toBe(before)
  })

  it('renders terminal and Markdown evidence only when verbose, keeping remediation explicit', () => {
    const terminal = renderTerminal(report, { verbose: false, color: false })
    const verboseTerminal = renderTerminal(report, { verbose: true, color: false })
    const markdown = renderMarkdown(report, { verbose: false })
    const verboseMarkdown = renderMarkdown(report, { verbose: true })

    expect(terminal).not.toContain('blocker evidence')
    expect(verboseTerminal).toContain('blocker evidence')
    expect(markdown).not.toContain('blocker evidence')
    expect(verboseMarkdown).toContain('blocker evidence')
    expect(markdown).toContain('Fix blocker.')
    expect(markdown).toContain('Fix warning.')
  })

  it('omits an absent profile and keeps verbose output valid when a finding has no evidence', () => {
    const withoutOptionalFields = {
      ...report,
      target: { dshHome: '<DSH_HOME>' },
      findings: [{ checkId: 'info.empty', severity: 'INFO', conclusion: 'No evidence.' }],
    } as unknown as SanitizedReport

    for (const output of [
      renderTerminal(withoutOptionalFields, { verbose: true, color: false }),
      renderMarkdown(withoutOptionalFields, { verbose: true }),
    ]) {
      expect(output).toContain('DSH home: <DSH_HOME>')
      expect(output).not.toContain('Profile:')
      expect(output).not.toContain('Evidence:')
    }
  })

  it('uses the required Markdown section order and exactly one trailing newline', () => {
    const value = renderMarkdown(report, { verbose: false })
    const sections = ['## Summary', '## Environment', '## Target', '## Findings', '## Remediation', '## Limitations']

    expect(value.endsWith('\n')).toBe(true)
    expect(value.endsWith('\n\n')).toBe(false)
    const positions = sections.map((section) => value.indexOf(section))
    expect(positions).toEqual(positions.toSorted((left, right) => left - right))
  })

  it('normalizes text output to one trailing newline when report text ends with one', () => {
    const trailing = { ...report, limitations: ['A trailing limitation.\n'] } as SanitizedReport

    expect(renderTerminal(trailing, { verbose: false, color: false })).not.toMatch(/\n\n$/u)
    expect(renderMarkdown(trailing, { verbose: false })).not.toMatch(/\n\n$/u)
  })

  it('applies ANSI color only when requested and remains byte-for-byte deterministic', () => {
    const plain = renderTerminal(report, { verbose: false, color: false })
    const colored = renderTerminal(report, { verbose: false, color: true })

    expect(plain).not.toContain('\u001B[')
    expect(colored).toContain('\u001B[')
    expect(renderTerminal(report, { verbose: false, color: false })).toBe(plain)
    expect(renderMarkdown(report, { verbose: true })).toBe(renderMarkdown(report, { verbose: true }))
    expect(plain.endsWith('\n')).toBe(true)
    expect(plain.endsWith('\n\n')).toBe(false)
  })

  it('serializes the canonical sanitized report as parseable two-space JSON without reordering findings', () => {
    const value = renderJson(report)

    expect(value.endsWith('\n')).toBe(true)
    expect(value.endsWith('\n\n')).toBe(false)
    expect(value).toBe(`${JSON.stringify(report, null, 2)}\n`)
    const parsed = JSON.parse(value) as { readonly schemaVersion: number, readonly findings: readonly { readonly checkId: string }[] }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.findings[0]?.checkId).toBe('pass.z')
  })
})
