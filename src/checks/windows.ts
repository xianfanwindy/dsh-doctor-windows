import { constants } from 'node:fs'
import { join, win32 } from 'node:path'
import type { Finding } from '../model.ts'
import type { ProfileCheckResult } from './profile.ts'
import type { SystemAccess } from '../system.ts'

export interface WindowsCheckResult {
  readonly findings: readonly Finding[]
  readonly limitations: readonly string[]
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function errorEvidence(error: unknown): readonly string[] {
  return [error instanceof Error ? `${error.name}: ${error.message}` : String(error)]
}

function normalizedPath(path: string): string {
  return win32.normalize(path).replace(/[\\/]+$/u, '').toLowerCase()
}

function containsPath(root: string, candidate: string): boolean {
  const normalizedRoot = normalizedPath(root)
  const normalizedCandidate = normalizedPath(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
}

async function checkLinks(system: SystemAccess, profile: ProfileCheckResult, findings: Finding[], limitations: string[]): Promise<void> {
  if (profile.profileDirectory === undefined) return
  const nodeModules = win32.join(profile.profileDirectory, 'node_modules')
  let entries: readonly { readonly name: string }[]
  try {
    entries = await system.readDir(nodeModules)
  } catch {
    limitations.push('The selected profile node_modules directory could not be listed.')
    return
  }
  for (const entry of [...entries].sort((left, right) => compareNames(left.name, right.name))) {
    const path = win32.join(nodeModules, entry.name)
    try {
      if (!(await system.lstat(path)).isSymbolicLink()) continue
      await system.realpath(path)
    } catch {
      findings.push({
        checkId: 'windows.link.broken',
        severity: 'BLOCKER',
        conclusion: 'A direct link under the selected profile node_modules could not be resolved.',
        evidence: [path],
      })
    }
  }
}

async function checkTempCapability(system: SystemAccess, findings: Finding[]): Promise<void> {
  let directory: string | undefined
  let original: string | undefined
  let renamed: string | undefined
  const cleanupEvidence: string[] = []
  try {
    directory = await system.makeTempDir(join(system.tempDir, 'dsh-doctor-'))
    original = join(directory, 'probe')
    const destination = join(directory, 'probe-renamed')
    await system.writeFileExclusive(original)
    await system.rename(original, destination)
    renamed = destination
    original = undefined
    await system.removeFile(renamed)
    renamed = undefined
    findings.push({
      checkId: 'windows.temp-capability',
      severity: 'PASS',
      conclusion: 'The private temporary filesystem capability probe succeeded.',
    })
  } catch (error) {
    findings.push({
      checkId: 'windows.temp-capability',
      severity: 'BLOCKER',
      conclusion: 'The private temporary filesystem capability probe failed.',
      evidence: errorEvidence(error),
    })
  } finally {
    for (const path of [renamed, original]) {
      if (path === undefined) continue
      try {
        await system.removeFile(path)
      } catch (error) {
        cleanupEvidence.push(...errorEvidence(error))
      }
    }
    if (directory !== undefined) {
      try {
        await system.removeDir(directory)
      } catch (error) {
        cleanupEvidence.push(...errorEvidence(error))
      }
    }
  }
  if (cleanupEvidence.length > 0) {
    findings.push({
      checkId: 'windows.temp-cleanup',
      severity: 'WARNING',
      conclusion: 'The private temporary filesystem probe could not be fully cleaned up.',
      evidence: cleanupEvidence,
    })
  }
}

/** Checks Windows filesystem conditions using the already resolved Harness home and profile. */
export async function checkWindows(system: SystemAccess, profile: ProfileCheckResult): Promise<WindowsCheckResult> {
  const findings: Finding[] = []
  const limitations: string[] = []
  try {
    await system.access(profile.dshHome, constants.R_OK)
  } catch (error) {
    findings.push({
      checkId: 'windows.dsh-home.readable',
      severity: 'BLOCKER',
      conclusion: 'The resolved DSH_HOME directory is not readable.',
      evidence: errorEvidence(error),
    })
  }
  await checkLinks(system, profile, findings, limitations)

  const syncRoots = [system.environment.OneDrive, system.environment.OneDriveCommercial, system.environment.OneDriveConsumer]
  if (syncRoots.some((root) => root !== undefined && root !== '' && containsPath(root, profile.dshHome))) {
    findings.push({
      checkId: 'windows.path.sync-root',
      severity: 'WARNING',
      conclusion: 'The resolved DSH_HOME directory is below a synchronized OneDrive root.',
    })
  }
  if (profile.dshHome.startsWith('\\\\')) {
    findings.push({
      checkId: 'windows.path.network',
      severity: 'WARNING',
      conclusion: 'The resolved DSH_HOME directory is on a UNC network path.',
    })
  }
  if (profile.dshHome.length > 240) {
    findings.push({
      checkId: 'windows.path.long',
      severity: 'WARNING',
      conclusion: 'The resolved DSH_HOME directory exceeds the Windows long-path heuristic.',
    })
  }
  await checkTempCapability(system, findings)
  return { findings, limitations }
}
