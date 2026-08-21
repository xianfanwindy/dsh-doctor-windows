import { execFile } from 'node:child_process'
import { access, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { main, type CliPorts } from '../src/cli.ts'
import type { SanitizedReport } from '../src/redact.ts'

const execFileAsync = promisify(execFile)

function report(severity: 'BLOCKER' | 'PASS' = 'PASS'): SanitizedReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-20T00:00:00.000Z',
    environment: { 'node.version': '22.19.0' },
    target: { dshHome: '<DSH_HOME>', profile: 'doctor' },
    summary: { blocker: severity === 'BLOCKER' ? 1 : 0, warning: 0, info: 0, pass: severity === 'PASS' ? 1 : 0 },
    findings: [{ checkId: 'check.example', severity, conclusion: 'Example.' }],
    limitations: [],
  } as unknown as SanitizedReport
}

function fixture(options: { readonly platform?: NodeJS.Platform, readonly result?: SanitizedReport, readonly runError?: unknown, readonly writeError?: unknown } = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const writes: Array<{ readonly path: string, readonly text: string }> = []
  const requests: Array<{ readonly profile?: string, readonly dshHome?: string }> = []
  const ports: CliPorts = {
    stdout: { write(text: string) { stdout.push(text) } },
    stderr: { write(text: string) { stderr.push(text) } },
    platform: options.platform ?? 'win32',
    async runDoctor(request) {
      requests.push(request)
      if (options.runError !== undefined) throw options.runError
      return options.result ?? report()
    },
    async writeFile(path, text) {
      if (options.writeError !== undefined) throw options.writeError
      writes.push({ path, text })
    },
  }
  return { ports, stdout, stderr, writes, requests }
}

describe('main', () => {
  it('returns 0 and writes the default terminal report to stdout without an output path', async () => {
    const value = fixture()

    await expect(main([], value.ports)).resolves.toBe(0)

    expect(value.stdout).toHaveLength(1)
    expect(value.stderr).toEqual([])
    expect(value.writes).toEqual([])
  })

  it('returns 1 when the sanitized report contains a blocker', async () => {
    const value = fixture({ result: report('BLOCKER') })

    await expect(main([], value.ports)).resolves.toBe(1)
    expect(value.stdout).toHaveLength(1)
  })

  it.each(['profile/name', 'profile\\name'])('rejects profile separators with usage output: %s', async (profile) => {
    const value = fixture()

    await expect(main(['--profile', profile], value.ports)).resolves.toBe(2)

    expect(value.requests).toEqual([])
    expect(value.stderr.join('')).toContain('Usage:')
  })

  it.each([
    ['--profile', 'one', '--profile', 'two'],
    ['--dsh-home', 'one', '--dsh-home', 'two'],
    ['--format', 'json', '--format', 'terminal'],
    ['--output', 'one', '--output', 'two'],
  ])('rejects repeated scalar options: %j', async (...argv: string[]) => {
    const value = fixture()

    await expect(main(argv, value.ports)).resolves.toBe(2)
    expect(value.requests).toEqual([])
  })

  it.each([
    ['--unknown'],
    ['position'],
    ['--profile'],
    ['--format', 'yaml'],
  ])('rejects invalid argument forms: %j', async (...argv: string[]) => {
    const value = fixture()

    await expect(main(argv, value.ports)).resolves.toBe(2)
    expect(value.requests).toEqual([])
    expect(value.stderr.join('')).toContain('Usage:')
  })

  it('short-circuits help and actual package version without diagnostics or files', async () => {
    const help = fixture()
    const version = fixture()
    const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { readonly version: string }

    await expect(main(['--help'], help.ports)).resolves.toBe(0)
    await expect(main(['--version'], version.ports)).resolves.toBe(0)

    expect(help.stdout.join('')).toContain('Usage:')
    expect(version.stdout.join('')).toContain(packageVersion.version)
    expect(help.requests).toEqual([])
    expect(version.requests).toEqual([])
    expect(help.writes).toEqual([])
    expect(version.writes).toEqual([])
  })

  it('dispatches Markdown and canonical JSON, forwarding only valid request fields', async () => {
    const markdown = fixture()
    const json = fixture()

    await expect(main(['--profile', 'doctor-01', '--dsh-home', 'C:\\Doctor', '--format', 'markdown', '--verbose'], markdown.ports)).resolves.toBe(0)
    await expect(main(['--format', 'json', '--verbose'], json.ports)).resolves.toBe(0)

    expect(markdown.stdout.join('')).toContain('## Summary')
    expect(markdown.requests).toEqual([{ profile: 'doctor-01', dshHome: 'C:\\Doctor' }])
    expect(json.stdout.join('')).toBe(`${JSON.stringify(report(), null, 2)}\n`)
  })

  it('writes exactly the selected rendered report only for --output', async () => {
    const value = fixture()

    await expect(main(['--format', 'markdown', '--output', 'C:\\reports\\doctor.md'], value.ports)).resolves.toBe(0)

    expect(value.stdout).toEqual([])
    expect(value.writes).toEqual([{ path: 'C:\\reports\\doctor.md', text: expect.stringContaining('## Summary') }])
  })

  it('honors --no-color for terminal output', async () => {
    const defaultColor = fixture()
    const noColor = fixture()

    await main([], defaultColor.ports)
    await main(['--no-color'], noColor.ports)

    expect(defaultColor.stdout.join('')).toContain('\u001B[')
    expect(noColor.stdout.join('')).not.toContain('\u001B[')
  })

  it('contains output and initialization failures as concise exit-2 errors', async () => {
    const writeFailure = fixture({ writeError: new Error('disk secret') })
    const initializationFailure = fixture({ runError: new Error('raw secret') })

    await expect(main(['--output', 'report.txt'], writeFailure.ports)).resolves.toBe(2)
    await expect(main([], initializationFailure.ports)).resolves.toBe(2)

    expect(writeFailure.stderr.join('')).toContain('Could not write report.')
    expect(initializationFailure.stderr.join('')).toContain('Could not initialize DSH Doctor.')
    expect(writeFailure.stderr.join('')).not.toContain('disk secret')
    expect(initializationFailure.stderr.join('')).not.toContain('raw secret')
  })

  it('rejects non-Windows initialization before diagnostics run', async () => {
    const value = fixture({ platform: 'linux' })

    await expect(main([], value.ports)).resolves.toBe(2)

    expect(value.requests).toEqual([])
    expect(value.stderr.join('')).toContain('Windows')
  })

  it('keeps a Node executable adapter with the required portable shebang', async () => {
    const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8')

    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true)
  })

  it('builds and executes the CLI target declared by package metadata', async () => {
    const packagePath = new URL('../package.json', import.meta.url)
    const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      readonly bin: { readonly 'dsh-doctor': string }
      readonly version: string
    }
    const binTarget = resolve(packageRoot, packageJson.bin['dsh-doctor'])

    await rm(binTarget, { force: true })
    await execFileAsync(process.execPath, [
      'node_modules/tsdown/dist/run.mjs',
      'src/index.ts',
      'src/cli.ts',
      '--no-config',
      '--format', 'esm',
      '--target', 'es2024',
      '--dts',
      '--out-dir', 'lib',
    ], { cwd: packageRoot })
    await expect(access(binTarget)).resolves.toBeUndefined()

    const { stdout, stderr } = await execFileAsync(process.execPath, [binTarget, '--version'], { cwd: packageRoot })
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe(packageJson.version)
  })
})
