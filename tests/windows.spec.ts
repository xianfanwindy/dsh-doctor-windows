import { describe, expect, it } from 'vitest'
import { checkWindows } from '../src/checks/windows.ts'
import type { ProfileCheckResult } from '../src/checks/profile.ts'
import type { SystemAccess } from '../src/system.ts'

interface WindowsFixture {
  readonly system: SystemAccess
  readonly calls: string[]
  readonly paths: { readonly access: string[], readonly lstat: string[], readonly realpath: string[] }
}

function profile(dshHome = 'C:\\Users\\Doctor\\.dsh', profileDirectory?: string): ProfileCheckResult {
  return {
    findings: [],
    limitations: [],
    dshHome,
    ...(profileDirectory === undefined ? {} : { profile: 'doctor', profileDirectory }),
    availableProfiles: [],
  }
}

function fixture(options: {
  readonly environment?: Readonly<Record<string, string>>
  readonly unreadable?: boolean
  readonly readDirError?: Error
  readonly entries?: readonly { readonly name: string, readonly link?: boolean }[]
  readonly brokenLinks?: readonly string[]
  readonly makeTempDirError?: unknown
  readonly writeError?: unknown
  readonly renameError?: Error
  readonly removeFileError?: Error
  readonly removeDirError?: Error
} = {}): WindowsFixture {
  const calls: string[] = []
  const paths = { access: [] as string[], lstat: [] as string[], realpath: [] as string[] }
  const links = new Set((options.entries ?? []).filter((entry) => entry.link).map((entry) => entry.name))
  const brokenLinks = new Set(options.brokenLinks ?? [])
  const system = {
    platform: 'win32' as const,
    environment: options.environment ?? {},
    homeDir: 'C:\\Users\\Doctor',
    tempDir: 'C:\\Temp',
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    async run() { throw new Error('not used') },
    async readText() { throw new Error('not used') },
    async readDir(path: string) {
      calls.push(`readDir:${path}`)
      if (options.readDirError !== undefined) throw options.readDirError
      return (options.entries ?? []).map(({ name }) => ({ name }))
    },
    async stat() { throw new Error('not used') },
    async lstat(path: string) {
      paths.lstat.push(path)
      calls.push(`lstat:${path}`)
      const name = path.slice(path.lastIndexOf('\\') + 1)
      return { isSymbolicLink: () => links.has(name) }
    },
    async realpath(path: string) {
      paths.realpath.push(path)
      calls.push(`realpath:${path}`)
      const name = path.slice(path.lastIndexOf('\\') + 1)
      if (brokenLinks.has(name)) throw new Error(`Missing target for ${name}`)
      return path
    },
    async access(path: string, mode?: number) {
      paths.access.push(path)
      calls.push(`access:${path}:${mode}`)
      if (options.unreadable) throw new Error('Access denied')
    },
    async makeTempDir(path: string) {
      calls.push(`makeTempDir:${path}`)
      if (options.makeTempDirError !== undefined) throw options.makeTempDirError
      return 'C:\\Temp\\dsh-doctor-private'
    },
    async writeFileExclusive(path: string) {
      calls.push(`writeFileExclusive:${path}`)
      if (options.writeError !== undefined) throw options.writeError
    },
    async rename(from: string, to: string) {
      calls.push(`rename:${from}:${to}`)
      if (options.renameError !== undefined) throw options.renameError
    },
    async removeFile(path: string) {
      calls.push(`removeFile:${path}`)
      if (options.removeFileError !== undefined) throw options.removeFileError
    },
    async removeDir(path: string) {
      calls.push(`removeDir:${path}`)
      if (options.removeDirError !== undefined) throw options.removeDirError
    },
    resolveModule() { throw new Error('not used') },
  } as unknown as SystemAccess
  return { system, calls, paths }
}

describe('checkWindows', () => {
  it('reports unreadable resolved DSH_HOME with R_OK and still completes the private probe', async () => {
    const value = fixture({ unreadable: true })

    const result = await checkWindows(value.system, profile())

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'windows.dsh-home.readable', severity: 'BLOCKER' }),
      expect.objectContaining({ checkId: 'windows.temp-capability', severity: 'PASS' }),
    ]))
    expect(value.paths.access).toEqual(['C:\\Users\\Doctor\\.dsh'])
    expect(value.calls).toContain('access:C:\\Users\\Doctor\\.dsh:4')
  })

  it('reports each broken direct node_modules link in sorted order without traversing package contents', async () => {
    const value = fixture({
      entries: [
        { name: 'zeta', link: true },
        { name: 'regular' },
        { name: 'alpha', link: true },
      ],
      brokenLinks: ['alpha', 'zeta'],
    })

    const result = await checkWindows(value.system, profile(undefined, 'C:\\Users\\Doctor\\.dsh\\profiles\\doctor'))

    expect(result.findings.filter(({ checkId }) => checkId === 'windows.link.broken')).toEqual([
      expect.objectContaining({ evidence: ['C:\\Users\\Doctor\\.dsh\\profiles\\doctor\\node_modules\\alpha'] }),
      expect.objectContaining({ evidence: ['C:\\Users\\Doctor\\.dsh\\profiles\\doctor\\node_modules\\zeta'] }),
    ])
    expect(value.paths.lstat).toEqual([
      'C:\\Users\\Doctor\\.dsh\\profiles\\doctor\\node_modules\\alpha',
      'C:\\Users\\Doctor\\.dsh\\profiles\\doctor\\node_modules\\regular',
      'C:\\Users\\Doctor\\.dsh\\profiles\\doctor\\node_modules\\zeta',
    ])
    expect(value.paths.realpath).toEqual([
      'C:\\Users\\Doctor\\.dsh\\profiles\\doctor\\node_modules\\alpha',
      'C:\\Users\\Doctor\\.dsh\\profiles\\doctor\\node_modules\\zeta',
    ])
  })

  it('warns only for a DSH_HOME contained by a synchronized root at a Windows path boundary', async () => {
    const environment = { OneDrive: 'C:\\Users\\Doctor\\OneDrive' }
    const contained = await checkWindows(fixture({ environment }).system, profile('c:\\users\\doctor\\onedrive\\DSH'))
    const sibling = await checkWindows(fixture({ environment }).system, profile('C:\\Users\\Doctor\\OneDrive-backup\\.dsh'))

    expect(contained.findings).toContainEqual(expect.objectContaining({ checkId: 'windows.path.sync-root', severity: 'WARNING' }))
    expect(sibling.findings).not.toContainEqual(expect.objectContaining({ checkId: 'windows.path.sync-root' }))
  })

  it('treats the synchronized root itself as a synchronized DSH_HOME location', async () => {
    const root = 'C:\\Users\\Doctor\\OneDrive'

    const result = await checkWindows(fixture({ environment: { OneDrive: root } }).system, profile(root))

    expect(result.findings).toContainEqual(expect.objectContaining({ checkId: 'windows.path.sync-root', severity: 'WARNING' }))
  })

  it('keeps the temp capability probe independent when selected node_modules cannot be listed', async () => {
    const result = await checkWindows(
      fixture({ readDirError: new Error('Access denied') }).system,
      profile(undefined, 'C:\\Users\\Doctor\\.dsh\\profiles\\doctor'),
    )

    expect(result.limitations).toEqual(['The selected profile node_modules directory could not be listed.'])
    expect(result.findings).toContainEqual(expect.objectContaining({ checkId: 'windows.temp-capability', severity: 'PASS' }))
  })

  it('adds stable network and long-path warnings before a successful temp capability finding', async () => {
    const dshHome = `\\\\server\\share\\${'a'.repeat(241)}`

    const result = await checkWindows(fixture().system, profile(dshHome))

    expect(result.findings.map(({ checkId }) => checkId)).toEqual([
      'windows.path.network',
      'windows.path.long',
      'windows.temp-capability',
    ])
  })

  it('uses one exclusive write and removes every created probe resource from its private temp directory', async () => {
    const value = fixture()

    await checkWindows(value.system, profile())

    expect(value.calls).toEqual(expect.arrayContaining([
      'makeTempDir:C:\\Temp\\dsh-doctor-',
      'writeFileExclusive:C:\\Temp\\dsh-doctor-private\\probe',
      'rename:C:\\Temp\\dsh-doctor-private\\probe:C:\\Temp\\dsh-doctor-private\\probe-renamed',
      'removeFile:C:\\Temp\\dsh-doctor-private\\probe-renamed',
      'removeDir:C:\\Temp\\dsh-doctor-private',
    ]))
    expect(value.calls.filter((call) => call.startsWith('writeFileExclusive:'))).toEqual([
      'writeFileExclusive:C:\\Temp\\dsh-doctor-private\\probe',
    ])
  })

  it('preserves a failed probe finding when cleanup also fails', async () => {
    const value = fixture({
      writeError: new Error('Disk full'),
      removeFileError: new Error('Probe locked'),
      removeDirError: new Error('Locked'),
    })

    const result = await checkWindows(value.system, profile())

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'windows.temp-capability', severity: 'BLOCKER', evidence: ['Error: Disk full'] }),
    ]))
    expect(result.findings.filter(({ checkId }) => checkId === 'windows.temp-cleanup')).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        evidence: ['Error: Probe locked', 'Error: Locked'],
      }),
    ])
    expect(value.calls).toContain('removeFile:C:\\Temp\\dsh-doctor-private\\probe')
    expect(value.calls).toContain('removeDir:C:\\Temp\\dsh-doctor-private')
  })

  it('cleans the original probe file after a failed rename', async () => {
    const value = fixture({ renameError: new Error('Rename denied') })

    const result = await checkWindows(value.system, profile())

    expect(result.findings).toContainEqual(expect.objectContaining({ checkId: 'windows.temp-capability', severity: 'BLOCKER' }))
    expect(value.calls).toEqual(expect.arrayContaining([
      'removeFile:C:\\Temp\\dsh-doctor-private\\probe',
      'removeDir:C:\\Temp\\dsh-doctor-private',
    ]))
    expect(value.calls).not.toContain('removeFile:C:\\Temp\\dsh-doctor-private\\probe-renamed')
  })

  it('retains a non-Error temporary-directory failure without attempting cleanup outside a created directory', async () => {
    const value = fixture({ makeTempDirError: 'Temporary root unavailable' })

    const result = await checkWindows(value.system, profile())

    expect(result.findings).toContainEqual(expect.objectContaining({
      checkId: 'windows.temp-capability',
      severity: 'BLOCKER',
      evidence: ['Temporary root unavailable'],
    }))
    expect(value.calls).toEqual([
      'access:C:\\Users\\Doctor\\.dsh:4',
      'makeTempDir:C:\\Temp\\dsh-doctor-',
    ])
  })
})
