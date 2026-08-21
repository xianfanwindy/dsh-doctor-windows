import { constants } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/doctor.ts'
import { createSystemAccess } from '../src/system.ts'

describe('createSystemAccess', () => {
  it('copies basic process facts and resolves installed modules without exposing the process environment object', () => {
    const system = createSystemAccess()
    const entry = Object.entries(process.env).find((candidate): candidate is [string, string] => typeof candidate[1] === 'string')

    expect(system.platform).toBe(process.platform)
    expect(system.homeDir).not.toBe('')
    expect(system.tempDir).not.toBe('')
    expect(system.now()).toBeInstanceOf(Date)
    expect(system.environment).not.toBe(process.env)
    expect(entry).toBeDefined()
    expect(system.environment[entry![0]]).toBe(entry![1])
    expect(system.resolveModule('semver', [join(system.tempDir, 'dsh-doctor-missing-anchor'), process.cwd()])).toContain('semver')
    expect(system.resolveModule('dsh-doctor-not-a-real-module', [process.cwd()])).toBeUndefined()
    expect(() => system.resolveModule('semver', [''])).toThrow(TypeError)
  })

  it('runs successful commands and returns failed and aborted commands as bounded results', async () => {
    const system = createSystemAccess()

    await expect(system.run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'])).resolves.toEqual({
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
    })
    await expect(system.run(process.execPath, ['-e', 'process.stderr.write("failed"); process.exit(7)'])).resolves.toMatchObject({
      exitCode: 7,
      stdout: '',
      stderr: 'failed',
      error: expect.any(Error),
    })

    const controller = new AbortController()
    const pending = system.run(process.execPath, ['-e', 'setTimeout(() => {}, 5_000)'], controller.signal)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ exitCode: 1, error: expect.objectContaining({ name: 'AbortError' }) })
  })

  it.skipIf(process.platform !== 'win32')('runs normal and stale temporary batch shims through cmd.exe without accepting command metacharacters', async () => {
    const system = createSystemAccess()
    let directory: string | undefined
    try {
      directory = await system.makeTempDir(join(system.tempDir, 'dsh-doctor-system-shim-'))
      const normal = join(directory, 'dsh.cmd')
      const stale = join(directory, 'stale-dsh.cmd')
      await writeFile(normal, '@echo off\r\necho 0.1.0\r\n', 'utf8')
      await writeFile(stale, '@echo off\r\n"%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n', 'utf8')

      await expect(system.run(normal, ['--version'])).resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining('0.1.0') })
      await expect(system.run(stale, ['--version'])).resolves.toMatchObject({ exitCode: expect.any(Number), error: expect.any(Error) })
      await expect(system.run(normal, ['--version&whoami'])).rejects.toThrow('Unsafe Windows batch command token.')
    } finally {
      if (directory !== undefined) await system.removeDir(directory)
    }
  })

  it('adapts filesystem operations inside one private temporary directory', async () => {
    const system = createSystemAccess()
    let directory: string | undefined
    try {
      directory = await system.makeTempDir(join(system.tempDir, 'dsh-doctor-system-'))
      const original = join(directory, 'original.txt')
      const renamed = join(directory, 'renamed.txt')

      await system.writeFileExclusive(original)
      await expect(system.writeFileExclusive(original)).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await system.readText(original)).toBe('')
      expect((await system.stat(original)).isFile()).toBe(true)
      expect((await system.lstat(original)).isFile()).toBe(true)
      expect(await system.realpath(original)).toContain('original.txt')
      await expect(system.access(original, constants.R_OK)).resolves.toBeUndefined()
      expect((await system.readDir(directory)).map((entry) => entry.name)).toEqual(['original.txt'])

      await system.rename(original, renamed)
      await system.removeFile(renamed)
      expect(await system.readDir(directory)).toEqual([])
    } finally {
      if (directory !== undefined) await system.removeDir(directory)
    }
  })

  it('contains a non-Error adapter failure without exposing its raw value', async () => {
    const system = createSystemAccess()
    const result = await runDoctor({ dshHome: join(system.tempDir, 'dsh-doctor-unavailable') }, {
      ...system,
      async run() { throw 'untrusted-secret' },
    })

    expect(result.findings).toContainEqual(expect.objectContaining({
      checkId: 'doctor.group.commands',
      severity: 'WARNING',
      conclusion: 'The commands check group failed with UnknownError.',
    }))
    expect(JSON.stringify(result)).not.toContain('untrusted-secret')
  })
})
