import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const corepack = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js')
const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const temporaryRoots: string[] = []

function pathValue(name: string): string | undefined {
  return Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

function commandOnPath(name: string): string | undefined {
  const path = pathValue('Path')
  const extensions = (pathValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((extension) => extension !== '')
  for (const directory of path?.split(';').filter((entry) => entry !== '') ?? []) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function environmentWithoutDsh(path: string, dshHome: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const normalized = key.toLowerCase()
    return normalized !== 'path' && normalized !== 'dsh_home'
  }))
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  return { ...inherited, [pathKey]: path, PATHEXT: '.COM;.EXE;.BAT;.CMD', DSH_HOME: dshHome }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(directory)
  return directory
}

async function run(file: string, args: readonly string[], cwd: string, environment?: NodeJS.ProcessEnv): Promise<{ readonly exitCode: number, readonly stdout: string, readonly stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
    })
    return { exitCode: 0, stdout, stderr }
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { readonly stdout?: string, readonly stderr?: string }
    return {
      exitCode: typeof result.code === 'number' ? result.code : 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }
}

interface TreeSnapshotEntry {
  readonly path: string
  readonly type: 'directory' | 'file' | 'symbolic-link' | 'other'
  readonly digest?: string
}

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

async function snapshotBelow(root: string, ancestors: readonly string[] = []): Promise<readonly TreeSnapshotEntry[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const snapshot: TreeSnapshotEntry[] = []
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name)
    const relativePath = [...ancestors, entry.name].join('/')
    if (entry.isDirectory()) {
      snapshot.push({ path: relativePath, type: 'directory' })
      snapshot.push(...await snapshotBelow(path, [...ancestors, entry.name]))
    } else if (entry.isFile()) {
      snapshot.push({ path: relativePath, type: 'file', digest: digest(await readFile(path)) })
    } else if (entry.isSymbolicLink()) {
      snapshot.push({ path: relativePath, type: 'symbolic-link', digest: digest(await readlink(path)) })
    } else {
      snapshot.push({ path: relativePath, type: 'other' })
    }
  }
  return snapshot
}

async function packedTarball(): Promise<{ readonly tarball: string, readonly contents: readonly string[] }> {
  const staging = await temporaryDirectory('dsh-doctor-package-')
  const destination = await temporaryDirectory('dsh-doctor-pack-')
  await Promise.all([
    cp(join(packageRoot, 'src'), join(staging, 'src'), { recursive: true }),
    cp(join(packageRoot, 'package.json'), join(staging, 'package.json')),
    cp(join(packageRoot, 'tsconfig.json'), join(staging, 'tsconfig.json')),
    cp(join(packageRoot, 'tsdown.config.ts'), join(staging, 'tsdown.config.ts')),
    cp(join(packageRoot, 'cordis.patch.yml'), join(staging, 'cordis.patch.yml')),
    cp(join(packageRoot, 'README.md'), join(staging, 'README.md')),
    cp(join(packageRoot, 'README.zh.md'), join(staging, 'README.zh.md')),
    cp(join(packageRoot, 'LICENSE'), join(staging, 'LICENSE')),
  ])
  await symlink(join(packageRoot, 'node_modules'), join(staging, 'node_modules'), 'junction')
  const packed = await run(process.execPath, [corepack, 'pnpm', 'pack', '--pack-destination', destination], staging)
  expect(packed.exitCode).toBe(0)
  const tarballs = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
  expect(tarballs).toHaveLength(1)
  const tarball = join(destination, tarballs[0]!)
  const listed = await run('tar.exe', ['-tf', tarball], staging)
  expect(listed.exitCode).toBe(0)
  return {
    tarball,
    contents: listed.stdout.split(/\r?\n/u).filter((entry) => entry !== '').map((entry) => entry.replace(/^\.\//u, '')).sort((left, right) => left.localeCompare(right)),
  }
}

async function writePackageManifest(directory: string): Promise<void> {
  await writeFile(join(directory, 'package.json'), '{"private":true}\n', 'utf8')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

describe('packed package release surface', () => {
  it('distinguishes a fake DSH_HOME content mutation', async () => {
    const dshHome = await temporaryDirectory('dsh-doctor-snapshot-')
    await mkdir(join(dshHome, 'profiles', 'doctor'), { recursive: true })
    await writeFile(join(dshHome, 'profiles', 'doctor', 'package.json'), '{"version":1}\n', 'utf8')
    const before = await snapshotBelow(dshHome)

    await writeFile(join(dshHome, 'profiles', 'doctor', 'package.json'), '{"version":2}\n', 'utf8')

    await expect(snapshotBelow(dshHome)).resolves.not.toEqual(before)
  })

  it('uses npm-normalized declared bin metadata', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      readonly bin: { readonly 'dsh-doctor': string }
    }

    expect(manifest.bin['dsh-doctor']).toBe('lib/cli.mjs')
  })

  it('contains only declared package files and npm metadata', async () => {
    const { contents } = await packedTarball()
    const allowed = new Set(['package/package.json', 'package/cordis.patch.yml', 'package/README.md', 'package/README.zh.md', 'package/LICENSE'])

    expect(contents).toContain('package/lib/index.mjs')
    expect(contents).toContain('package/lib/cli.mjs')
    expect(contents).toContain('package/lib/plugin.mjs')
    expect(contents).toContain('package/README.md')
    expect(contents).toContain('package/README.zh.md')
    expect(contents).toContain('package/LICENSE')
    expect(contents.every((entry) => entry.startsWith('package/lib/') || allowed.has(entry))).toBe(true)
    expect(contents.some((entry) => /(^|\/)(src|tests|coverage|dist)(\/|$)/u.test(entry))).toBe(false)
    expect(contents.some((entry) => /(^|\/)(?:\.env|credentials)(?:\.|\/|$)/iu.test(entry))).toBe(false)
  }, 60_000)

  it('runs the installed CLI without DSH or durable changes', async () => {
    const { tarball } = await packedTarball()
    const project = await temporaryDirectory('dsh-doctor-install-')
    const dshHome = join(project, 'dsh-home')
    await writePackageManifest(project)
    await mkdir(dshHome, { recursive: true })
    await writeFile(join(dshHome, 'unchanged.txt'), 'unchanged\n', 'utf8')
    const before = await snapshotBelow(dshHome)
    const install = await run(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], project)
    expect(install.exitCode).toBe(0)

    const packageJson = JSON.parse(await readFile(join(project, 'node_modules', 'dsh-doctor-windows', 'package.json'), 'utf8')) as {
      readonly bin: { readonly 'dsh-doctor': string }
    }
    const binary = resolve(project, 'node_modules', 'dsh-doctor-windows', packageJson.bin['dsh-doctor'])
    await expect(access(binary)).resolves.toBeUndefined()
    const nodeDirectory = dirname(commandOnPath('node') ?? process.execPath)
    const systemRoot = process.env.SystemRoot
    const path = [nodeDirectory, systemRoot === undefined ? undefined : join(systemRoot, 'System32'), systemRoot === undefined ? undefined : join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')]
      .filter((entry): entry is string => entry !== undefined)
      .join(';')
    const result = await run(process.execPath, [binary, '--dsh-home', dshHome, '--format', 'json', '--no-color'], project, environmentWithoutDsh(path, dshHome))

    expect(result.exitCode).toBe(1)
    const report = JSON.parse(result.stdout) as { readonly findings: readonly { readonly checkId: string }[] }
    const checkIds = report.findings.map((finding) => finding.checkId)
    expect(checkIds).toContain('command.dsh.missing')
    expect(result.stderr).not.toContain(process.env.USERPROFILE ?? '')
    expect(await snapshotBelow(dshHome)).toEqual(before)
    await expect(stat(join(project, 'dsh-doctor-report.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    const brokenBin = join(project, 'broken-dsh')
    const installedCommand = join(project, 'node_modules', '.bin', 'dsh-doctor.cmd')
    const powershell = commandOnPath('powershell')
    const pwsh = commandOnPath('pwsh')
    await mkdir(brokenBin, { recursive: true })
    await writeFile(join(brokenBin, 'dsh.cmd'), '@echo off\r\n> "%~dp0shim-ran.txt" echo cmd\r\n"%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n', 'utf8')
    await writeFile(join(brokenBin, 'dsh.ps1'), [
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
      'Set-Content -NoNewline -Path "$basedir/shim-ran.txt" -Value ps1',
      '& "node$exe" "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args',
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n'), 'utf8')
    await expect(access(installedCommand)).resolves.toBeUndefined()
    expect(powershell).toBeDefined()
    expect(pwsh).toBeDefined()
    const pwshDirectory = dirname(pwsh!)
    const brokenPath = [brokenBin, nodeDirectory, systemRoot === undefined ? undefined : join(systemRoot, 'System32'), systemRoot === undefined ? undefined : join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), pwshDirectory]
      .filter((entry): entry is string => entry !== undefined)
      .join(';')
    const shellEnvironment = {
      ...environmentWithoutDsh(brokenPath, dshHome),
      DSH_DOCTOR_TEST_PATH: brokenPath,
      DSH_DOCTOR_TEST_COMMAND: installedCommand,
      DSH_DOCTOR_TEST_HOME: dshHome,
    }
    const shellCommand = '$env:Path = $env:DSH_DOCTOR_TEST_PATH; & $env:DSH_DOCTOR_TEST_COMMAND --dsh-home $env:DSH_DOCTOR_TEST_HOME --format json --no-color'
    for (const shell of [powershell!, pwsh!]) {
      const broken = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', shellCommand], project, shellEnvironment)
      expect(broken.exitCode).toBe(1)
      const brokenReport = JSON.parse(broken.stdout) as { readonly findings: readonly { readonly checkId: string }[] }
      expect(brokenReport.findings.map((finding) => finding.checkId)).toContain('runtime.dsh.shim-target')
    }
    await expect(stat(join(brokenBin, 'shim-ran.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await snapshotBelow(dshHome)).toEqual(before)
  }, 60_000)

  const dsh = commandOnPath('dsh')
  const dshSmoke = dsh === undefined ? it.skip : it

  dshSmoke(dsh === undefined
    ? 'skips real DSH bundle lifecycle smoke because dsh is unavailable on PATH'
    : 'adds and removes the packed bundle through a real DSH profile', async () => {
    const { tarball } = await packedTarball()
    const dshHome = await temporaryDirectory('dsh-doctor-dsh-home-')
    const environment = { ...process.env, DSH_HOME: dshHome }

    const added = await run(dsh!, ['plugin', '--profile', 'doctor', 'add', tarball], packageRoot, environment)
    expect(added.exitCode).toBe(0)
    const present = await run(dsh!, ['--profile', 'doctor', '--dump-config'], packageRoot, environment)
    expect(present.exitCode).toBe(0)
    expect(present.stdout).toContain('dsh-doctor-windows/plugin')
    const removed = await run(dsh!, ['plugin', '--profile', 'doctor', 'remove', 'dsh-doctor-windows'], packageRoot, environment)
    expect(removed.exitCode).toBe(0)
    const absent = await run(dsh!, ['--profile', 'doctor', '--dump-config'], packageRoot, environment)
    expect(absent.exitCode).toBe(0)
    expect(absent.stdout).not.toContain('dsh-doctor-windows/plugin')
  })
})
