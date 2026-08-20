/* v8 ignore file -- fake system boundary; command behavior is covered by commands.spec.ts. */

import { access, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SystemAccess } from '../src/system.ts'

export interface CommandCandidate {
  readonly Name: 'node' | 'dsh' | 'pnpm'
  readonly Path: string
  readonly CommandType: 'Application' | 'ExternalScript'
}

export interface FakeSystemOptions {
  readonly powershell?: readonly CommandCandidate[]
  readonly pwsh?: readonly CommandCandidate[]
  readonly powershellError?: string
  readonly pwshError?: string
  readonly powershellErrorCode?: string
  readonly pwshErrorCode?: string
  readonly powershellOutput?: string
  readonly pwshOutput?: string
  readonly executionPolicy?: string
  readonly executionPolicyOutput?: string
}

export function createFakeSystem(options: FakeSystemOptions = {}): SystemAccess {
  return {
    platform: 'win32',
    environment: {},
    homeDir: 'C:\\Users\\Doctor',
    tempDir: 'C:\\Temp',
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    async run(file, args) {
      const shell = file.toLowerCase()
      const script = args.at(-1) ?? ''
      if (script.includes('Get-Command')) {
        const error = shell === 'powershell.exe' ? options.powershellError : options.pwshError
        const errorCode = shell === 'powershell.exe' ? options.powershellErrorCode : options.pwshErrorCode
        const candidates = shell === 'powershell.exe' ? options.powershell : options.pwsh
        const output = shell === 'powershell.exe' ? options.powershellOutput : options.pwshOutput
        return {
          exitCode: error ? 1 : 0,
          stdout: output ?? (candidates === undefined ? '' : JSON.stringify(candidates)),
          stderr: error ?? '',
          error: error ? Object.assign(new Error(error), { code: errorCode }) : undefined,
        }
      }
      if (script.includes('Get-ExecutionPolicy')) {
        return {
          exitCode: 0,
          stdout: options.executionPolicyOutput ?? JSON.stringify([{ Scope: 'CurrentUser', ExecutionPolicy: options.executionPolicy ?? 'Undefined' }]),
          stderr: '',
        }
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    },
    async readText() { throw new Error('not used') },
    async readDir() { throw new Error('not used') },
    async stat() { throw new Error('not used') },
    async lstat() { throw new Error('not used') },
    async realpath() { throw new Error('not used') },
    async access() { throw new Error('not used') },
    async makeTempDir() { throw new Error('not used') },
    async rename() { throw new Error('not used') },
    async removeFile() { throw new Error('not used') },
    async removeDir() { throw new Error('not used') },
    resolveModule() { throw new Error('not used') },
  }
}

export interface ProfileFixture {
  readonly root: string
  readonly homeDir: string
  readonly dshHome: string
  readonly installationRoot: string
  readonly system: SystemAccess
  readonly resolveCalls: Array<{ readonly specifier: string, readonly anchors: readonly string[] }>
  readonly readPaths: string[]
  write(path: string, source: string): Promise<void>
  makeDirectory(path: string): Promise<void>
  addPackage(anchor: string, specifier: string, manifest?: unknown, patch?: { readonly path: string, readonly source: string }): Promise<string>
  remove(): Promise<void>
}

function packageSegments(specifier: string): readonly string[] | undefined {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 && parts[1] !== '' ? parts.slice(0, 2) : undefined
  return parts[0] === '' ? undefined : [parts[0]!]
}

/** Creates one disposable real-filesystem profile tree without loading fixture packages. */
export async function createProfileFixture(): Promise<ProfileFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-doctor-profile-'))
  const homeDir = join(root, 'home')
  const dshHome = join(root, 'dsh-home')
  const installationRoot = join(root, 'installation')
  const resolveCalls: Array<{ readonly specifier: string, readonly anchors: readonly string[] }> = []
  const readPaths: string[] = []
  await Promise.all([homeDir, dshHome, installationRoot].map((path) => mkdir(path, { recursive: true })))

  const resolveModule = (specifier: string, anchors: readonly string[]): string | undefined => {
    resolveCalls.push({ specifier, anchors: [...anchors] })
    const segments = packageSegments(specifier)
    if (segments === undefined) return undefined
    for (const anchor of anchors) {
      const entry = join(anchor, 'node_modules', ...segments, 'index.js')
      if (existsSync(entry)) return entry
    }
    return undefined
  }

  const fixture: ProfileFixture = {
    root,
    homeDir,
    dshHome,
    installationRoot,
    resolveCalls,
    readPaths,
    system: {
      platform: 'win32',
      environment: { DSH_HOME: dshHome },
      homeDir,
      tempDir: join(root, 'temp'),
      now: () => new Date('2026-08-20T00:00:00.000Z'),
      async run() { throw new Error('profile checks must not run commands') },
      async readText(path) { readPaths.push(path); return readFile(path, 'utf8') },
      readDir: (path) => readdir(path, { withFileTypes: true }),
      stat,
      lstat,
      realpath,
      access,
      async makeTempDir() { throw new Error('profile checks must not create temporary directories') },
      async rename() { throw new Error('profile checks must not rename files') },
      async removeFile() { throw new Error('profile checks must not remove files') },
      async removeDir() { throw new Error('profile checks must not remove directories') },
      resolveModule,
    },
    async write(path, source) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, source, 'utf8')
    },
    makeDirectory: (path) => mkdir(path, { recursive: true }),
    async addPackage(anchor, specifier, manifest = {}, patch) {
      const segments = packageSegments(specifier)
      if (segments === undefined) throw new Error(`Invalid fixture package specifier: ${specifier}`)
      const packageRoot = join(anchor, 'node_modules', ...segments)
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'index.js'), 'throw new Error("target package must not execute")\n', 'utf8')
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest), 'utf8')
      if (patch !== undefined) await fixture.write(join(packageRoot, patch.path), patch.source)
      return packageRoot
    },
    remove: () => rm(root, { recursive: true, force: true }),
  }
  return fixture
}
