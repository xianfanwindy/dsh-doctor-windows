import { win32 } from 'node:path'
import { satisfies, valid, validRange } from 'semver'
import type { CommandCheckResult } from './commands.ts'
import type { Finding } from '../model.ts'
import type { RunResult, SystemAccess } from '../system.ts'

export interface RuntimeCheckResult {
  readonly findings: readonly Finding[]
  readonly limitations: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly installationRoot?: string
}

interface InstallationManifest {
  readonly version: string
  readonly nodeRange: string
  readonly cliEntry: string
}

const BASELINE_NODE_RANGE = '^22.19.0 || >=24.0.0'
const DSH_PACKAGE = 'node_modules\\@deepseek-ai\\dsh'
const CLI_SUFFIX = `${DSH_PACKAGE}\\lib\\bin.js`

function normalizedVersion(value: string): string | undefined {
  return valid(value.trim().replace(/^v/, '')) ?? undefined
}

function sanitizedStderr(value: string): string {
  return value.replace(/\p{Cc}/gu, '').trim()
}

function installationRootFromTarget(target: string): string | undefined {
  const normalized = target.replaceAll('/', '\\')
  if (!normalized.toLowerCase().endsWith(CLI_SUFFIX) || !win32.isAbsolute(normalized)) return undefined
  return win32.dirname(win32.dirname(normalized))
}

type BasedirReference = 'target' | 'manifest'

const BASEDIR_ASSIGNMENT = /^\s*\$basedir\s*=/iu
const STANDARD_BASEDIR_ASSIGNMENT = /^\s*\$basedir\s*=\s*Split-Path\s+\$MyInvocation\.MyCommand\.Definition\s+-Parent\s*$/iu
const BASEDIR_TARGET = /^\s*&\s+(?:"\$basedir[\\/]node\$exe"|"node\$exe")\s+"\$basedir[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js"\s+(?:.*\s+)?\$args\s*$/iu
const BASEDIR_MANIFEST = /^\s*Test-Path\s+"\$basedir[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]package\.json"\s*$/iu

function uncommentedPowerShellLines(shim: string): readonly string[] {
  const lines: string[] = []
  let blockComment = false
  for (const line of shim.split(/\r?\n/u)) {
    let code = ''
    let quote: '"' | "'" | undefined
    for (let index = 0; index < line.length; index++) {
      const character = line[index]!
      const next = line[index + 1]
      if (blockComment) {
        if (character === '#' && next === '>') {
          blockComment = false
          index++
        }
        continue
      }
      if (quote === undefined && character === '<' && next === '#') {
        blockComment = true
        index++
        continue
      }
      if (quote === undefined && character === '#') break
      code += character
      if (quote === undefined && (character === '"' || character === "'")) quote = character
      else if (quote === character) quote = undefined
    }
    lines.push(code)
  }
  return lines
}

function basedirReference(shim: string): BasedirReference | undefined {
  let state: 'unseen' | 'trusted' | 'invalid' = 'unseen'
  for (const line of uncommentedPowerShellLines(shim)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) continue
    if (BASEDIR_ASSIGNMENT.test(line)) {
      state = state === 'unseen' && STANDARD_BASEDIR_ASSIGNMENT.test(line) ? 'trusted' : 'invalid'
      continue
    }
    if (state !== 'trusted') continue
    if (BASEDIR_TARGET.test(line)) return 'target'
    if (BASEDIR_MANIFEST.test(line)) return 'manifest'
  }
  return undefined
}

function siblingRoot(shimPath: string): string {
  return win32.join(win32.dirname(shimPath), 'node_modules', '@deepseek-ai', 'dsh')
}

function installationRootFromShim(shim: string, shimPath: string): { readonly root: string, readonly target?: string } | undefined {
  const absoluteTarget = shim.match(/(?:"|')([^"'\r\n]*node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)(?:"|')/iu)?.[1]
  if (absoluteTarget !== undefined) {
    const target = absoluteTarget.replaceAll('/', '\\')
    const root = installationRootFromTarget(target)
    if (root !== undefined) return { root, target }
  }

  const basedir = basedirReference(shim)
  const siblingTarget = /%~dp0[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js(?=[\s"')]|$)/iu.test(shim)
    || basedir === 'target'
  if (siblingTarget) {
    const root = siblingRoot(shimPath)
    return { root, target: win32.join(root, 'lib', 'bin.js') }
  }

  const siblingManifest = /%~dp0[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]package\.json(?=[\s"')]|$)/iu.test(shim)
    || basedir === 'manifest'
  if (!siblingManifest) return undefined
  return { root: siblingRoot(shimPath) }
}

function parseManifest(source: string): InstallationManifest | undefined {
  try {
    const value: unknown = JSON.parse(source)
    if (typeof value !== 'object' || value === null) return undefined
    const manifest = value as Record<string, unknown>
    const engines = typeof manifest.engines === 'object' && manifest.engines !== null
      ? manifest.engines as Record<string, unknown>
      : undefined
    const nodeRange = engines?.node
    const cliEntry = typeof manifest.bin === 'string'
      ? manifest.bin
      : typeof manifest.bin === 'object' && manifest.bin !== null
        ? (manifest.bin as Record<string, unknown>).dsh
        : undefined
    const version = typeof manifest.version === 'string' ? normalizedVersion(manifest.version) : undefined
    if (version === undefined || typeof nodeRange !== 'string' || validRange(nodeRange) === null || typeof cliEntry !== 'string') return undefined
    return { version, nodeRange, cliEntry }
  } catch {
    return undefined
  }
}

function resolvedCliEntry(root: string, cliEntry: string): string | undefined {
  const entry = cliEntry.trim()
  if (entry === '' || win32.isAbsolute(entry)) return undefined
  const resolved = win32.resolve(root, entry)
  const relative = win32.relative(root, resolved)
  if (relative === '' || relative === '..' || relative.startsWith('..\\') || win32.isAbsolute(relative)) return undefined
  return resolved
}

function commandFailure(checkId: string, command: string, result: RunResult): Finding {
  const evidence = sanitizedStderr(result.stderr)
  return {
    checkId,
    severity: 'BLOCKER',
    conclusion: `${command} --version exited with code ${result.exitCode}.`,
    ...(evidence === '' ? {} : { evidence: [evidence] }),
  }
}

function unknownInstallation(findings: Finding[], limitations: string[], conclusion: string, limitation: string): void {
  findings.push({ checkId: 'runtime.dsh.installation-unknown', severity: 'WARNING', conclusion })
  limitations.push(limitation)
}

export async function checkRuntime(system: SystemAccess, commandCheck: CommandCheckResult, signal?: AbortSignal): Promise<RuntimeCheckResult> {
  const findings: Finding[] = []
  const limitations: string[] = []
  const environment: Record<string, string> = {}
  let nodeVersion: string | undefined
  let nodeProbed = false
  const probeNode = async (): Promise<void> => {
    if (nodeProbed) return
    nodeProbed = true
    const nodeResult = commandCheck.commands.node === undefined ? undefined : await system.run(commandCheck.commands.node, ['--version'], signal)
    nodeVersion = nodeResult?.exitCode === 0 ? normalizedVersion(nodeResult.stdout) : undefined
    if (nodeResult !== undefined && nodeResult.exitCode !== 0) findings.push(commandFailure('runtime.node.version-command', 'node', nodeResult))
    if (nodeResult !== undefined && nodeResult.exitCode === 0 && nodeVersion === undefined) {
      findings.push({ checkId: 'runtime.node.version-invalid', severity: 'BLOCKER', conclusion: 'node --version did not return a valid semantic version.' })
    }
    if (nodeVersion !== undefined) environment['node.version'] = nodeVersion
  }

  const shimPath = commandCheck.commands.dsh
  if (shimPath === undefined) {
    unknownInstallation(findings, limitations, 'The selected dsh installation could not be determined from its shim.', 'No selected dsh command is available.')
  } else if (!['.cmd', '.ps1'].includes(win32.extname(shimPath).toLowerCase())) {
    unknownInstallation(findings, limitations, 'The selected dsh installation could not be determined from its shim.', 'The selected dsh command is not an npm shim.')
  } else {
    let discovered: { readonly root: string, readonly target?: string } | undefined
    let shimRead = true
    try {
      discovered = installationRootFromShim(await system.readText(shimPath), shimPath)
    } catch {
      shimRead = false
      unknownInstallation(findings, limitations, 'The selected dsh installation could not be determined from its shim.', 'The selected dsh shim could not be read.')
    }

    if (shimRead) {
      if (discovered === undefined) {
        unknownInstallation(findings, limitations, 'The selected dsh installation could not be determined from its shim.', 'The selected dsh shim did not contain an accepted DSH installation reference.')
      } else if (discovered.target !== undefined) {
        try {
          await system.access(discovered.target)
        } catch {
          findings.push({
            checkId: 'runtime.dsh.shim-target',
            severity: 'BLOCKER',
            conclusion: 'The selected dsh shim references a missing DSH CLI entry.',
          })
          discovered = undefined
        }
      }
    }

    if (discovered !== undefined) {
      const manifestPath = win32.join(discovered.root, 'package.json')
      let manifest: InstallationManifest | undefined
      try {
        manifest = parseManifest(await system.readText(manifestPath))
        const cliEntry = manifest === undefined ? undefined : resolvedCliEntry(discovered.root, manifest.cliEntry)
        if (cliEntry === undefined || !(await system.stat(cliEntry)).isFile()) manifest = undefined
      } catch {
        manifest = undefined
      }
      if (manifest === undefined) {
        unknownInstallation(findings, limitations, 'The selected dsh installation metadata is incomplete or invalid.', 'The selected DSH package metadata could not be validated.')
      } else {
        environment['dsh.nodeRange'] = manifest.nodeRange
        environment['dsh.installationVersion'] = manifest.version
        await probeNode()
        if (nodeVersion !== undefined) {
          findings.push(satisfies(nodeVersion, manifest.nodeRange)
            ? { checkId: 'runtime.node.supported', severity: 'PASS', conclusion: `Node.js ${nodeVersion} satisfies ${manifest.nodeRange}.` }
            : { checkId: 'runtime.node.unsupported', severity: 'BLOCKER', conclusion: `Node.js ${nodeVersion} does not satisfy ${manifest.nodeRange}.` })
        }
        return { findings, limitations, environment, installationRoot: discovered.root }
      }
    }
  }

  await probeNode()
  if (nodeVersion !== undefined) {
    findings.push(satisfies(nodeVersion, BASELINE_NODE_RANGE)
      ? { checkId: 'runtime.node.supported', severity: 'PASS', conclusion: `Node.js ${nodeVersion} satisfies ${BASELINE_NODE_RANGE}.` }
      : { checkId: 'runtime.node.unsupported', severity: 'BLOCKER', conclusion: `Node.js ${nodeVersion} does not satisfy ${BASELINE_NODE_RANGE}.` })
  }
  return { findings, limitations, environment }
}
