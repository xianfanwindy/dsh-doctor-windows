import { execFile } from 'node:child_process'
import { access, lstat, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dirent, Stats } from 'node:fs'

export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error
}

export interface SystemAccess {
  readonly platform: NodeJS.Platform
  readonly environment: Readonly<Record<string, string>>
  readonly homeDir: string
  readonly tempDir: string
  readonly now: () => Date
  run(file: string, args: readonly string[], signal?: AbortSignal): Promise<RunResult>
  readText(path: string): Promise<string>
  readDir(path: string): Promise<readonly Dirent[]>
  stat(path: string): Promise<Stats>
  lstat(path: string): Promise<Stats>
  realpath(path: string): Promise<string>
  access(path: string, mode?: number): Promise<void>
  makeTempDir(path: string): Promise<string>
  writeFileExclusive(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  removeFile(path: string): Promise<void>
  removeDir(path: string): Promise<void>
  resolveModule(specifier: string, anchors: readonly string[]): string | undefined
}

const MAX_BUFFER = 64 * 1024
const RUN_TIMEOUT_MS = 5_000

function copiedEnvironment(): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ))
}

function run(file: string, args: readonly string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: 'buffer',
      maxBuffer: MAX_BUFFER,
      shell: false,
      signal,
      timeout: RUN_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({
        exitCode,
        stdout: Buffer.from(stdout).toString('utf8'),
        stderr: Buffer.from(stderr).toString('utf8'),
        ...(error === null ? {} : { error }),
      })
    })
  })
}

function resolveModule(specifier: string, anchors: readonly string[]): string | undefined {
  for (const anchor of anchors) {
    try {
      return createRequire(join(anchor, 'package.json')).resolve(specifier)
    } catch (error: unknown) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  return undefined
}

export function createSystemAccess(): SystemAccess {
  return {
    platform: process.platform,
    environment: copiedEnvironment(),
    homeDir: homedir(),
    tempDir: tmpdir(),
    now: () => new Date(),
    run,
    readText: (path) => readFile(path, 'utf8'),
    readDir: (path) => readdir(path, { withFileTypes: true }),
    stat,
    lstat,
    realpath,
    access: (path, mode) => access(path, mode),
    makeTempDir: mkdtemp,
    writeFileExclusive: (path) => writeFile(path, '', { flag: 'wx' }),
    rename,
    removeFile: (path) => rm(path),
    removeDir: (path) => rm(path, { recursive: true }),
    resolveModule,
  }
}
