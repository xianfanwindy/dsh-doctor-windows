export type Severity = 'BLOCKER' | 'WARNING' | 'INFO' | 'PASS'

export interface Finding {
  readonly checkId: string
  readonly severity: Severity
  readonly conclusion: string
  readonly evidence?: readonly string[]
  readonly remediation?: readonly string[]
}

export interface Summary {
  readonly blocker: number
  readonly warning: number
  readonly info: number
  readonly pass: number
}

export interface DiagnosticRequest {
  readonly profile?: string
  readonly dshHome?: string
  readonly signal?: AbortSignal
}

export interface DiagnosticReport {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly environment: Readonly<Record<string, string>>
  readonly target: { readonly dshHome: string; readonly profile?: string }
  readonly summary: Summary
  readonly findings: readonly Finding[]
  readonly limitations: readonly string[]
}

export function summarizeFindings(findings: readonly Finding[]): Summary {
  const summary = { blocker: 0, warning: 0, info: 0, pass: 0 }
  for (const finding of findings) {
    const key = finding.severity.toLowerCase() as keyof Summary
    summary[key]++
  }
  return summary
}
