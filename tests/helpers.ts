/* v8 ignore file -- fake system boundary; command behavior is covered by commands.spec.ts. */

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
