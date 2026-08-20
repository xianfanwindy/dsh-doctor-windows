import type { Finding } from '../model.ts'
import type { RunResult, SystemAccess } from '../system.ts'

export interface CommandSelection {
  readonly node?: string
  readonly dsh?: string
  readonly pnpm?: string
}

export interface CommandCheckResult {
  readonly findings: readonly Finding[]
  readonly limitations: readonly string[]
  readonly commands: CommandSelection
}

type CommandName = keyof CommandSelection
type Shell = 'powershell.exe' | 'pwsh.exe'

interface Candidate {
  readonly name: CommandName
  readonly path: string
  readonly commandType: 'Application' | 'ExternalScript'
  readonly shell: Shell
}

interface ProbeResult {
  readonly candidates: readonly Candidate[]
  readonly limitation?: string
}

const COMMAND_NAMES: readonly CommandName[] = ['node', 'dsh', 'pnpm']
const SHELLS: readonly Shell[] = ['powershell.exe', 'pwsh.exe']
const COMMAND_PROBE = '@(Get-Command node,dsh,pnpm -All -CommandType Application,ExternalScript | Select-Object Name,Path,CommandType) | ConvertTo-Json -Compress'
const POLICY_PROBE = 'Get-ExecutionPolicy -List | Select-Object Scope,ExecutionPolicy | ConvertTo-Json -Compress'

function shellArgs(script: string): readonly string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
}

function sanitized(value: string): string {
  return value.replace(/\p{Cc}/gu, ' ')
}

function priority(candidate: Candidate): number {
  return candidate.commandType === 'ExternalScript' ? 0 : 1
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return left.shell.localeCompare(right.shell, undefined, { sensitivity: 'accent' })
    || priority(left) - priority(right)
    || left.path.localeCompare(right.path, undefined, { sensitivity: 'accent' })
}

function parseCandidates(stdout: string, shell: Shell): readonly Candidate[] | undefined {
  if (stdout.trim() === '') return []
  try {
    const values: unknown[] = Array.isArray(JSON.parse(stdout)) ? JSON.parse(stdout) : [JSON.parse(stdout)]
    return values.flatMap((value): Candidate[] => {
      if (typeof value !== 'object' || value === null) return []
      const candidate = value as Record<string, unknown>
      const name = typeof candidate.Name === 'string' ? candidate.Name.toLowerCase() : ''
      const path = typeof candidate.Path === 'string' ? candidate.Path : ''
      const commandType = candidate.CommandType
      if (!COMMAND_NAMES.includes(name as CommandName) || path === '' || (commandType !== 'Application' && commandType !== 'ExternalScript')) return []
      return [{ name: name as CommandName, path, commandType, shell }]
    })
  } catch {
    return undefined
  }
}

function probeFailure(shell: Shell, result: RunResult): string {
  return `${shell} command probe failed: ${sanitized(result.stderr)}`
}

async function probeShell(system: SystemAccess, shell: Shell): Promise<ProbeResult> {
  const result = await system.run(shell, shellArgs(COMMAND_PROBE))
  if (result.error?.name === 'Error' && (result.error as NodeJS.ErrnoException).code === 'ENOENT' && shell === 'pwsh.exe') {
    return { candidates: [] }
  }
  if (result.exitCode !== 0 || result.error !== undefined) return { candidates: [], limitation: probeFailure(shell, result) }
  const candidates = parseCandidates(result.stdout, shell)
  return candidates === undefined
    ? { candidates: [], limitation: `${shell} command probe returned invalid JSON.` }
    : { candidates }
}

function selectCandidates(candidates: readonly Candidate[], name: CommandName): readonly Candidate[] {
  const unique = new Map<string, Candidate>()
  for (const candidate of candidates.filter((candidate) => candidate.name === name).sort(compareCandidates)) {
    if (!unique.has(candidate.path.toLowerCase())) unique.set(candidate.path.toLowerCase(), candidate)
  }
  return [...unique.values()].sort(compareCandidates)
}

function missingFinding(name: CommandName): Finding {
  return {
    checkId: `command.${name}.missing`,
    severity: name === 'pnpm' ? 'WARNING' : 'BLOCKER',
    conclusion: `No usable ${name} command was found.`,
  }
}

function selectedFinding(name: CommandName, candidate: Candidate): Finding {
  return {
    checkId: `command.${name}.found`,
    severity: 'PASS',
    conclusion: `Selected ${name} command: ${sanitized(candidate.path)}.`,
  }
}

function multipleFinding(name: CommandName, candidates: readonly Candidate[]): Finding {
  return {
    checkId: `command.${name}.multiple`,
    severity: 'WARNING',
    conclusion: `Multiple usable ${name} commands were found.`,
    evidence: candidates.map((candidate) => `${candidate.shell}: ${sanitized(candidate.path)}`),
  }
}

function hasRestrictedPolicy(stdout: string): boolean {
  if (stdout.trim() === '') return false
  try {
    const values: unknown[] = Array.isArray(JSON.parse(stdout)) ? JSON.parse(stdout) : [JSON.parse(stdout)]
    return values.some((value) => typeof value === 'object' && value !== null
      && (value as Record<string, unknown>).ExecutionPolicy === 'Restricted')
  } catch {
    return false
  }
}

export async function checkCommands(system: SystemAccess): Promise<CommandCheckResult> {
  const results = await Promise.all(SHELLS.map((shell) => probeShell(system, shell)))
  const limitations = results.flatMap((result) => result.limitation === undefined ? [] : [result.limitation])
  const findings: Finding[] = results.flatMap((result, index) => result.limitation === undefined ? [] : [{
    checkId: `command.${SHELLS[index]}.probe`,
    severity: 'WARNING' as const,
    conclusion: result.limitation,
  }])
  const candidates = results.flatMap((result) => result.candidates)
  const selected: { -readonly [Name in CommandName]?: Candidate } = {}

  for (const name of COMMAND_NAMES) {
    const matching = selectCandidates(candidates, name)
    if (matching.length === 0) {
      findings.push(missingFinding(name))
    } else {
      const candidate = matching[0]!
      selected[name] = candidate
      findings.push(matching.length === 1 ? selectedFinding(name, candidate) : multipleFinding(name, matching))
    }
  }

  const policy = await system.run('powershell.exe', shellArgs(POLICY_PROBE))
  if (selected.dsh?.path.toLowerCase().endsWith('.ps1') && policy.exitCode === 0 && policy.error === undefined && hasRestrictedPolicy(policy.stdout)) {
    findings.push({
      checkId: 'command.dsh.execution-policy',
      severity: 'BLOCKER',
      conclusion: 'The selected dsh PowerShell script is blocked by Restricted execution policy.',
    })
  }

  return {
    findings,
    limitations,
    commands: Object.fromEntries(COMMAND_NAMES.flatMap((name) => selected[name] === undefined ? [] : [[name, selected[name].path]])) as CommandSelection,
  }
}
