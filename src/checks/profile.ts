import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml'
import type { DiagnosticRequest, Finding } from '../model.ts'
import type { RuntimeCheckResult } from './runtime.ts'
import type { SystemAccess } from '../system.ts'
import { assertProfileName } from '../profile-name.ts'

export interface ProfileCheckResult {
  readonly findings: readonly Finding[]
  readonly limitations: readonly string[]
  readonly dshHome: string
  readonly profile?: string
  readonly profileDirectory?: string
  readonly availableProfiles: readonly string[]
}

interface ProfileManifest {
  readonly bundles: readonly string[]
}

type ProfileManifestParse = { readonly type: 'manifest', readonly manifest: ProfileManifest } | { readonly type: 'parse' | 'bundles' }

interface ParsedPatch {
  readonly path: string
  readonly value: readonly unknown[]
}

class OpaqueJavaScript {
  constructor(readonly source: string) {}
}

const STATIC_YAML_SCHEMA = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (source: string) => new OpaqueJavaScript(source),
})])

function compareNames(left: string, right: string): number {
  return left < right ? -1 : 1
}

function finding(checkId: string, severity: Finding['severity'], conclusion: string, evidence?: readonly string[]): Finding {
  return { checkId, severity, conclusion, ...(evidence === undefined ? {} : { evidence }) }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isPathSpecifier(value: string): boolean {
  return isAbsolute(value) || /^[a-z]:[\\/]/iu.test(value) || value.startsWith('\\') || value.startsWith('/') || value.startsWith('.') || /^[a-z][a-z0-9+.-]*:/iu.test(value)
}

function packageSegments(value: string): readonly string[] | undefined {
  if (value.trim() !== value || value === '' || isPathSpecifier(value) || value.includes('\\')) return undefined
  const segments = value.split('/')
  const validSegment = (segment: string): boolean => /^[a-z0-9][a-z0-9._-]*$/iu.test(segment)
  if (value.startsWith('@')) {
    if (segments.length < 2 || !/^@[a-z0-9][a-z0-9._-]*$/iu.test(segments[0]!) || !validSegment(segments[1]!)) return undefined
    return segments.slice(0, 2)
  }
  return validSegment(segments[0]!) ? [segments[0]!] : undefined
}

function containedPath(root: string, candidate: string): boolean {
  const difference = relative(root, candidate)
  return difference !== '' && difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}

function packageRoot(resolvedModule: string, specifier: string): string | undefined {
  const segments = packageSegments(specifier)
  if (segments === undefined) return undefined
  const parts = resolve(resolvedModule).split(sep)
  for (let index = parts.length - segments.length - 1; index >= 0; index--) {
    if (parts[index]?.toLowerCase() !== 'node_modules') continue
    if (!segments.every((segment, offset) => parts[index + offset + 1] === segment)) continue
    const root = parts.slice(0, index + segments.length + 1).join(sep)
    return containedPath(root, resolvedModule) ? root : undefined
  }
  return undefined
}

function parseProfileManifest(source: string): ProfileManifestParse {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return { type: 'parse' }
  }
  if (typeof value !== 'object' || value === null) return { type: 'bundles' }
  const dsh = (value as Record<string, unknown>).dsh
  if (typeof dsh !== 'object' || dsh === null) return { type: 'bundles' }
  const profile = (dsh as Record<string, unknown>).profile
  if (typeof profile !== 'object' || profile === null) return { type: 'bundles' }
  const bundles = (profile as Record<string, unknown>).bundles
  if (!Array.isArray(bundles) || !bundles.every((bundle) => typeof bundle === 'string' && packageSegments(bundle) !== undefined)) return { type: 'bundles' }
  return { type: 'manifest', manifest: { bundles } }
}

function yamlLocation(error: unknown, path: string): readonly string[] {
  const mark = typeof error === 'object' && error !== null ? (error as { mark?: unknown }).mark : undefined
  const line = typeof mark === 'object' && mark !== null && typeof (mark as { line?: unknown }).line === 'number'
    ? (mark as { line: number }).line + 1
    : 1
  const column = typeof mark === 'object' && mark !== null && typeof (mark as { column?: unknown }).column === 'number'
    ? (mark as { column: number }).column + 1
    : 1
  return [`${path}:${line}:${column}`]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsOpaqueJavaScript(value: unknown): boolean {
  if (value instanceof OpaqueJavaScript) return true
  if (Array.isArray(value)) return value.some(containsOpaqueJavaScript)
  return isRecord(value) && Object.values(value).some(containsOpaqueJavaScript)
}

function hasDisallowedOpaqueJavaScript(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.some((operation) => {
    if (!isRecord(operation)) return containsOpaqueJavaScript(operation)
    return Object.entries(operation).some(([operationName, entries]) => {
      if (operationName !== 'insert' || !Array.isArray(entries)) return containsOpaqueJavaScript(entries)
      return entries.some((entry) => {
        if (!isRecord(entry)) return containsOpaqueJavaScript(entry)
        return Object.entries(entry).some(([key, child]) => key !== 'disabled' && key !== 'config' && containsOpaqueJavaScript(child))
      })
    })
  })
}

async function parsePatch(system: SystemAccess, path: string, findings: Finding[]): Promise<ParsedPatch | undefined> {
  let source: string
  try {
    source = await system.readText(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    findings.push(finding('profile.patch.read', 'BLOCKER', `Could not read Cordis patch at ${path}.`))
    return undefined
  }

  if (source.split(/\r?\n/u).every((line) => /^\s*(?:#.*)?$/u.test(line))) {
    findings.push(finding('profile.patch.empty', 'BLOCKER', `Cordis patch at ${path} is empty.`))
    return undefined
  }

  let value: unknown
  try {
    value = load(source, { schema: STATIC_YAML_SCHEMA })
  } catch (error) {
    findings.push(finding('profile.patch.parse', 'BLOCKER', 'Cordis patch YAML could not be parsed.', yamlLocation(error, path)))
    return undefined
  }
  if (value === undefined || value === null) {
    findings.push(finding('profile.patch.empty', 'BLOCKER', `Cordis patch at ${path} is empty.`))
    return undefined
  }
  if (!Array.isArray(value)) {
    findings.push(finding('profile.patch.invalid', 'BLOCKER', `Cordis patch at ${path} must contain an array.`))
    return undefined
  }
  if (hasDisallowedOpaqueJavaScript(value)) {
    findings.push(finding('profile.patch.invalid', 'BLOCKER', `Cordis patch at ${path} uses !!js outside an inserted plugin disabled field or config.`))
    return undefined
  }
  findings.push(finding('profile.patch.valid', 'PASS', `Cordis patch at ${path} is a valid array.`))
  return { path, value }
}

function pluginNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((operation) => {
    if (!isRecord(operation) || !Array.isArray(operation.insert)) return []
    return operation.insert.flatMap((entry) => isRecord(entry) && typeof entry.name === 'string' && packageSegments(entry.name) !== undefined ? [entry.name] : [])
  })
}

async function checkPlugins(system: SystemAccess, patch: ParsedPatch, anchors: readonly string[], findings: Finding[]): Promise<void> {
  for (const name of pluginNames(patch.value)) {
    if (system.resolveModule(name, anchors) === undefined) {
      findings.push(finding('profile.plugin.unresolved', 'BLOCKER', `Plugin ${name} from ${patch.path} could not be resolved.`))
    } else {
      findings.push(finding('profile.plugin.resolved', 'PASS', `Plugin ${name} from ${patch.path} resolved statically.`))
    }
  }
}

async function checkBundle(system: SystemAccess, specifier: string, anchors: readonly string[], findings: Finding[]): Promise<ParsedPatch | undefined> {
  const resolved = system.resolveModule(specifier, anchors)
  const root = resolved === undefined ? undefined : packageRoot(resolved, specifier)
  if (root === undefined) {
    findings.push(finding('profile.bundle.missing', 'BLOCKER', `Bundle ${specifier} could not be resolved.`))
    return undefined
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(await system.readText(join(root, 'package.json')))
  } catch {
    findings.push(finding('profile.bundle.missing', 'BLOCKER', `Bundle ${specifier} has no readable package manifest.`))
    return undefined
  }
  const dsh = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>).dsh : undefined
  const bundle = typeof dsh === 'object' && dsh !== null ? (dsh as Record<string, unknown>).bundle : undefined
  const patch = typeof bundle === 'object' && bundle !== null ? (bundle as Record<string, unknown>).patch : undefined
  if (typeof patch !== 'string' || patch.trim() !== patch || patch === '') {
    findings.push(finding('profile.bundle.not-bundle', 'BLOCKER', `Bundle ${specifier} does not declare dsh.bundle.patch.`))
    return undefined
  }
  const path = resolve(root, patch)
  if (isAbsolute(patch) || !containedPath(root, path)) {
    findings.push(finding('profile.bundle.patch-missing', 'BLOCKER', `Bundle ${specifier} declares an unsafe patch path.`))
    return undefined
  }
  let canonicalRoot: string
  let canonicalPath: string
  try {
    canonicalRoot = await system.realpath(root)
    canonicalPath = await system.realpath(path)
    if (!containedPath(canonicalRoot, canonicalPath) || !(await system.stat(canonicalPath)).isFile()) throw new Error('not a contained regular file')
  } catch {
    findings.push(finding('profile.bundle.patch-missing', 'BLOCKER', `Bundle ${specifier} declares a missing patch file.`))
    return undefined
  }
  findings.push(finding('profile.bundle.valid', 'PASS', `Bundle ${specifier} declares a readable Cordis patch.`))
  return parsePatch(system, canonicalPath, findings)
}

/** Statically checks the selected DSH profile without loading target packages. */
export async function checkProfile(system: SystemAccess, request: DiagnosticRequest, runtime: RuntimeCheckResult): Promise<ProfileCheckResult> {
  if (request.profile !== undefined) assertProfileName(request.profile)
  const dshHome = resolve(request.dshHome ?? system.environment.DSH_HOME ?? join(system.homeDir, '.dsh'))
  const findings: Finding[] = [finding('profile.dsh-home.resolved', 'PASS', `Resolved DSH_HOME to ${dshHome}.`)]
  const limitations: string[] = []
  const profilesDirectory = join(dshHome, 'profiles')
  let availableProfiles: readonly string[] = []
  try {
    availableProfiles = (await system.readDir(profilesDirectory)).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareNames)
  } catch (error) {
    if (!isMissing(error)) limitations.push('The DSH profiles directory could not be listed.')
  }

  if (request.profile === undefined) {
    findings.push(finding('profile.available.listed', 'PASS', `Found ${availableProfiles.length} profile directories.`))
    return { findings, limitations, dshHome, availableProfiles }
  }

  const profileDirectory = join(profilesDirectory, request.profile)
  let parsed: ProfileManifestParse
  try {
    parsed = parseProfileManifest(await system.readText(join(profileDirectory, 'package.json')))
  } catch {
    parsed = { type: 'parse' }
  }
  const bundles = parsed.type === 'manifest' ? parsed.manifest.bundles : undefined
  if (bundles === undefined) {
    findings.push(parsed.type === 'parse'
      ? finding('profile.manifest.parse', 'BLOCKER', `Profile ${request.profile} has invalid package.json.`)
      : finding('profile.bundles.invalid', 'BLOCKER', `Profile ${request.profile} has no usable dsh.profile.bundles array.`))
  } else {
    findings.push(finding('profile.manifest.valid', 'PASS', `Profile ${request.profile} has a valid bundle declaration.`))
  }

  const anchors = [runtime.installationRoot, profileDirectory].filter((anchor): anchor is string => anchor !== undefined)
  const patches: ParsedPatch[] = []
  for (const path of [join(dshHome, 'cordis.patch.yml'), join(profileDirectory, 'cordis.patch.yml')]) {
    const patch = await parsePatch(system, path, findings)
    if (patch !== undefined) patches.push(patch)
  }
  if (bundles !== undefined) {
    for (const bundle of bundles) {
      const patch = await checkBundle(system, bundle, anchors, findings)
      if (patch !== undefined) patches.push(patch)
    }
  }
  for (const patch of patches) await checkPlugins(system, patch, anchors, findings)
  return { findings, limitations, dshHome, profile: request.profile, profileDirectory, availableProfiles }
}
