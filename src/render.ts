import type { Finding } from './model.ts'
import type { SanitizedReport } from './redact.ts'

const SEVERITY_RANK = {
  BLOCKER: 0,
  WARNING: 1,
  INFO: 2,
  PASS: 3,
} as const

const TERMINAL_COLOR = {
  BLOCKER: '\u001B[31m',
  WARNING: '\u001B[33m',
  INFO: '\u001B[36m',
  PASS: '\u001B[32m',
} as const

const RESET_COLOR = '\u001B[0m'

export interface TerminalRenderOptions {
  readonly verbose: boolean
  readonly color: boolean
}

export interface MarkdownRenderOptions {
  readonly verbose: boolean
}

function orderedFindings(report: SanitizedReport): Finding[] {
  return [...report.findings].sort((left, right) => `${SEVERITY_RANK[left.severity]}:${left.checkId}`.localeCompare(`${SEVERITY_RANK[right.severity]}:${right.checkId}`))
}

function finish(lines: readonly string[]): string {
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`
}

function summaryLine(report: SanitizedReport): string {
  const { blocker, warning, info, pass: passed } = report.summary
  return `${blocker} blocker(s), ${warning} warning(s), ${info} info, ${passed} pass(es)`
}

function targetLines(report: SanitizedReport): string[] {
  return [
    `DSH home: ${report.target.dshHome}`,
    ...(report.target.profile === undefined ? [] : [`Profile: ${report.target.profile}`]),
  ]
}

function remediationLines(findings: readonly Finding[]): string[] {
  return findings.flatMap((finding) => (finding.remediation ?? []).map((remediation) => `${finding.checkId}: ${remediation}`))
}

function colorSeverity(finding: Finding, color: boolean): string {
  const value = `[${finding.severity}]`
  return color ? `${TERMINAL_COLOR[finding.severity]}${value}${RESET_COLOR}` : value
}

/** Renders a shareable report for an interactive terminal. */
export function renderTerminal(report: SanitizedReport, options: TerminalRenderOptions): string {
  const findings = orderedFindings(report)
  const lines = [
    'DSH Doctor',
    `Summary: ${summaryLine(report)}`,
    'Environment:',
    ...Object.entries(report.environment).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `  ${key}: ${value}`),
    'Target:',
    ...targetLines(report).map((line) => `  ${line}`),
    'Findings:',
    ...findings.flatMap((finding) => [
      `  ${colorSeverity(finding, options.color)} ${finding.checkId}: ${finding.conclusion}`,
      ...(options.verbose ? (finding.evidence ?? []).map((evidence) => `    Evidence: ${evidence}`) : []),
    ]),
    'Remediation:',
    ...remediationLines(findings).map((line) => `  ${line}`),
    'Limitations:',
    ...report.limitations.map((limitation) => `  ${limitation}`),
  ]
  return finish(lines)
}

/** Renders a shareable report as Markdown. */
export function renderMarkdown(report: SanitizedReport, options: MarkdownRenderOptions): string {
  const findings = orderedFindings(report)
  const lines = [
    '## Summary',
    '',
    summaryLine(report),
    '',
    '## Environment',
    '',
    ...Object.entries(report.environment).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Target',
    '',
    ...targetLines(report).map((line) => `- ${line}`),
    '',
    '## Findings',
    '',
    ...findings.flatMap((finding) => [
      `- **[${finding.severity}] ${finding.checkId}** — ${finding.conclusion}`,
      ...(options.verbose ? (finding.evidence ?? []).map((evidence) => `  - Evidence: ${evidence}`) : []),
    ]),
    '',
    '## Remediation',
    '',
    ...remediationLines(findings).map((line) => `- ${line}`),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((limitation) => `- ${limitation}`),
  ]
  return finish(lines)
}

/** Serializes the canonical sanitized report for automation. */
export function renderJson(report: SanitizedReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}
