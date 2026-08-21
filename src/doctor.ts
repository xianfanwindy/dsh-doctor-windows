import { checkCommands, type CommandCheckResult } from './checks/commands.ts'
import { checkProfile, type ProfileCheckResult } from './checks/profile.ts'
import { checkRuntime, type RuntimeCheckResult } from './checks/runtime.ts'
import { checkWindows, type WindowsCheckResult } from './checks/windows.ts'
import { summarizeFindings, type DiagnosticRequest, type Finding } from './model.ts'
import { sanitizeReport, type SanitizedReport } from './redact.ts'
import { createSystemAccess, type SystemAccess } from './system.ts'
import { assertProfileName } from './profile-name.ts'

function errorClass(error: unknown): string {
  if (error instanceof TypeError) return 'TypeError'
  if (error instanceof RangeError) return 'RangeError'
  if (error instanceof SyntaxError) return 'SyntaxError'
  return error instanceof Error ? 'Error' : 'UnknownError'
}

function commandsFallback(): CommandCheckResult {
  return { findings: [], limitations: [], commands: {} }
}

function runtimeFallback(): RuntimeCheckResult {
  return { findings: [], limitations: [], environment: {} }
}

function profileFallback(): ProfileCheckResult {
  return { findings: [], limitations: [], dshHome: '', availableProfiles: [] }
}

function windowsFallback(): WindowsCheckResult {
  return { findings: [], limitations: [] }
}

export async function runDoctor(request: DiagnosticRequest, system: SystemAccess = createSystemAccess()): Promise<SanitizedReport> {
  if (system.platform !== 'win32') throw new Error('DSH Doctor requires Windows.')
  if (request.profile !== undefined) assertProfileName(request.profile)

  const findings: Finding[] = []
  const limitations: string[] = []
  const runGroup = async <Result>(name: string, callback: () => Promise<Result>, fallback: () => Result): Promise<Result> => {
    try {
      return await callback()
    } catch (error) {
      findings.push({
        checkId: `doctor.group.${name}`,
        severity: 'WARNING',
        conclusion: `The ${name} check group failed with ${errorClass(error)}.`,
      })
      limitations.push(`The ${name} check group did not complete.`)
      return fallback()
    }
  }
  const commands = await runGroup('commands', () => checkCommands(system), commandsFallback)
  findings.push(...commands.findings)
  limitations.push(...commands.limitations)

  const runtime = await runGroup('runtime', () => checkRuntime(system, commands, request.signal), runtimeFallback)
  findings.push(...runtime.findings)
  limitations.push(...runtime.limitations)

  const profile = await runGroup('profile', () => checkProfile(system, request, runtime), profileFallback)
  findings.push(...profile.findings)
  limitations.push(...profile.limitations)

  const windows = await runGroup('windows', () => checkWindows(system, profile), windowsFallback)
  findings.push(...windows.findings)
  limitations.push(...windows.limitations)

  const report = {
    schemaVersion: 1 as const,
    generatedAt: system.now().toISOString(),
    environment: { ...runtime.environment },
    target: { dshHome: profile.dshHome, ...(request.profile === undefined ? {} : { profile: request.profile }) },
    summary: summarizeFindings(findings),
    findings,
    limitations,
  }
  return sanitizeReport(report, { userHome: system.homeDir, dshHome: profile.dshHome, temp: system.tempDir })
}
