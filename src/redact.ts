import type { DiagnosticReport } from './model.ts'

declare const sanitizedReport: unique symbol

export type SanitizedReport = DiagnosticReport & { readonly [sanitizedReport]: true }

export interface RedactionRoots {
  readonly userHome: string
  readonly dshHome: string
  readonly temp: string
}

const URL_TOKEN = /https?:\/\/[^\s<>"']+/giu
const CREDENTIAL_ASSIGNMENT = /(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]+_)*(?:api[_-]?key|authorization|credential|deepseek[_-]?api[_-]?key|password|secret|token)(?:_[A-Za-z0-9]+)*\s*([:=])\s*[^\s,;]+/giu
const BEARER_CREDENTIAL = /\bbearer\s+[^\s,;]+/giu
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/giu
const DEEPSEEK_TOKEN = /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/giu
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9!@#$%^&*+=._~/-]{32,}/gu
const TRAILING_URL_PUNCTUATION = /[),.;:!?\]}]+$/u

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function redactUrl(value: string): string {
  return value.replace(URL_TOKEN, (token) => {
    const punctuation = token.match(TRAILING_URL_PUNCTUATION)?.[0] ?? ''
    const candidate = punctuation === '' ? token : token.slice(0, -punctuation.length)
    try {
      const url = new URL(candidate)
      return `${url.protocol}//${url.host}${url.pathname}${punctuation}`
    } catch {
      return token
    }
  })
}

function hasHighEntropy(value: string): boolean {
  const categories = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u]
  return categories.filter((pattern) => pattern.test(value)).length >= 3
}

function redactText(value: string, replacements: readonly (readonly [string, string])[]): string {
  let redacted = value
  for (const [root, placeholder] of replacements) redacted = redacted.replace(new RegExp(escaped(root), 'giu'), placeholder)
  redacted = redactUrl(redacted)
  redacted = redacted.replace(BEARER_CREDENTIAL, 'Bearer <REDACTED>')
  redacted = redacted.replace(CREDENTIAL_ASSIGNMENT, (_match, separator: string) => `<REDACTED>${separator}<REDACTED>`)
  redacted = redacted.replace(GITHUB_TOKEN, '<REDACTED>')
  redacted = redacted.replace(DEEPSEEK_TOKEN, '<REDACTED>')
  return redacted.replace(HIGH_ENTROPY_TOKEN, (token) => hasHighEntropy(token) ? '<REDACTED>' : token)
}

export function sanitizeReport(report: DiagnosticReport, roots: RedactionRoots): SanitizedReport {
  const replacements: [string, string][] = [
    [roots.dshHome, '<DSH_HOME>'],
    [roots.userHome, '<USER_HOME>'],
    [roots.temp, '<TEMP>'],
  ]
  const active = replacements.filter(([root]) => root.length > 0).sort(([left], [right]) => right.length - left.length)
  const text = JSON.stringify(report, (_key, value: unknown) => typeof value === 'string' ? redactText(value, active) : value)
  return JSON.parse(text) as SanitizedReport
}
