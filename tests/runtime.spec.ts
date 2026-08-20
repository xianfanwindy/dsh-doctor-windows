import { describe, expect, it } from 'vitest'
import type { Stats } from 'node:fs'
import type { CommandCheckResult } from '../src/checks/commands.ts'
import { checkRuntime } from '../src/checks/runtime.ts'
import type { RunResult, SystemAccess } from '../src/system.ts'

const commands: CommandCheckResult = {
  findings: [],
  limitations: [],
  commands: {
    node: 'C:\\Tools\\node.exe',
    dsh: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\dsh.cmd',
  },
}

interface RuntimeSystemOptions {
  readonly node?: RunResult
  readonly dsh?: RunResult
  readonly shim?: string
  readonly shimError?: boolean
  readonly files?: Readonly<Record<string, string>>
  readonly absent?: readonly string[]
  readonly directories?: readonly string[]
  readonly onRun?: (file: string, args: readonly string[], signal: AbortSignal | undefined) => void
}

function runtimeSystem(options: RuntimeSystemOptions = {}): SystemAccess {
  const files = new Map(Object.entries(options.files ?? {}).map(([path, value]) => [path.toLowerCase(), value]))
  const absent = new Set((options.absent ?? []).map((path) => path.toLowerCase()))
  const directories = new Set((options.directories ?? []).map((path) => path.toLowerCase()))

  return {
    platform: 'win32',
    environment: {},
    homeDir: 'C:\\Users\\Doctor',
    tempDir: 'C:\\Temp',
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    async run(file, args, signal) {
      options.onRun?.(file, args, signal)
      if (file === commands.commands.node) return options.node ?? { exitCode: 0, stdout: 'v22.19.0\n', stderr: '' }
      if (file === commands.commands.dsh || file.toLowerCase().endsWith('\\dsh.exe') || file.toLowerCase().endsWith('\\dsh.ps1')) return options.dsh ?? { exitCode: 0, stdout: '0.1.0\n', stderr: '' }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    },
    async readText(path) {
      if (path === commands.commands.dsh || path.toLowerCase().endsWith('\\dsh.ps1')) {
        if (options.shimError) throw new Error('Shim unreadable')
        return options.shim ?? ''
      }
      const value = files.get(path.toLowerCase())
      if (value === undefined) throw new Error(`Unexpected read: ${path}`)
      return value
    },
    async readDir() { throw new Error('not used') },
    async stat(path) {
      if (absent.has(path.toLowerCase())) throw new Error(`Missing: ${path}`)
      return { isFile: () => !directories.has(path.toLowerCase()) } as Stats
    },
    async lstat() { throw new Error('not used') },
    async realpath() { throw new Error('not used') },
    async access(path) {
      if (absent.has(path.toLowerCase())) throw new Error(`Missing: ${path}`)
    },
    async makeTempDir() { throw new Error('not used') },
    async writeFileExclusive() { throw new Error('not used') },
    async rename() { throw new Error('not used') },
    async removeFile() { throw new Error('not used') },
    async removeDir() { throw new Error('not used') },
    resolveModule() { throw new Error('not used') },
  }
}

function shimFor(target: string): string {
  return `@echo off\r\nnode "${target}" %*\r\n`
}

function standardPowerShellShim(): string {
  return [
    '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    '  $exe=".exe"',
    '}',
    'if (Test-Path "$basedir/node$exe") {',
    '  & "$basedir/node$exe" "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args',
    '} else {',
    '  & "node$exe" "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args',
    '}',
    'exit $LASTEXITCODE',
  ].join('\r\n')
}

function installation(root: string, version = '0.1.0', nodeRange = '^22.19.0 || >=24.0.0'): Readonly<Record<string, string>> {
  return {
    [`${root}\\package.json`]: JSON.stringify({
      version,
      engines: { node: nodeRange },
      bin: { dsh: 'lib/bin.js' },
    }),
  }
}

const installationRoot = 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh'
const cliTarget = `${installationRoot}\\lib\\bin.js`

describe('checkRuntime', () => {
  it('blocks an unsupported selected Node.js version', async () => {
    // Would catch treating an installed Node command as supported without checking DSH's declared range.
    const result = await checkRuntime(runtimeSystem({
      node: { exitCode: 0, stdout: ' v20.18.0\r\n', stderr: '' },
      shim: shimFor(cliTarget),
      files: installation(installationRoot),
    }), commands)

    expect(result.findings).toContainEqual({
      checkId: 'runtime.node.unsupported',
      severity: 'BLOCKER',
      conclusion: 'Node.js 20.18.0 does not satisfy ^22.19.0 || >=24.0.0.',
    })
    expect(result.environment).toMatchObject({ 'node.version': '20.18.0', 'dsh.nodeRange': '^22.19.0 || >=24.0.0' })
  })

  it('passes a supported selected Node.js version', async () => {
    // Would catch rejecting the first supported version in the published baseline.
    const result = await checkRuntime(runtimeSystem({
      shim: shimFor(cliTarget),
      files: installation(installationRoot),
    }), commands)

    expect(result.findings).toContainEqual({
      checkId: 'runtime.node.supported',
      severity: 'PASS',
      conclusion: 'Node.js 22.19.0 satisfies ^22.19.0 || >=24.0.0.',
    })
  })

  it('blocks a failing dsh version command without leaking shim or manifest source', async () => {
    // Would catch a broken launcher being hidden, or source text being copied into shareable diagnostic evidence.
    const shim = shimFor(cliTarget)
    const manifest = installation(installationRoot)[`${installationRoot}\\package.json`]!
    const result = await checkRuntime(runtimeSystem({
      dsh: { exitCode: 1, stdout: '', stderr: 'launch failed\u0000\u001b[31mnow\u001b[0m' },
      shim,
      files: installation(installationRoot),
    }), commands)
    const finding = result.findings.find(({ checkId }) => checkId === 'runtime.dsh.version-command')

    expect(finding).toMatchObject({
      severity: 'BLOCKER',
      conclusion: 'dsh --version exited with code 1.',
      evidence: ['launch failed[31mnow[0m'],
    })
    expect(JSON.stringify(result)).not.toContain(shim)
    expect(JSON.stringify(result)).not.toContain(manifest)
  })

  it('blocks a recognized shim whose CLI target is absent', async () => {
    // Would catch accepting a stale npm shim while its referenced DSH entry file is gone.
    const result = await checkRuntime(runtimeSystem({
      shim: shimFor(cliTarget),
      absent: [cliTarget],
    }), commands)

    expect(result.findings).toContainEqual({
      checkId: 'runtime.dsh.shim-target',
      severity: 'BLOCKER',
      conclusion: 'The selected dsh shim references a missing DSH CLI entry.',
    })
  })

  it('warns when command and manifest DSH versions differ', async () => {
    // Would catch version output being trusted even when it describes a different DSH installation.
    const result = await checkRuntime(runtimeSystem({
      dsh: { exitCode: 0, stdout: '0.2.0\n', stderr: '' },
      shim: shimFor(cliTarget),
      files: installation(installationRoot, '0.1.0'),
    }), commands)

    expect(result.findings).toContainEqual({
      checkId: 'runtime.dsh.version-mismatch',
      severity: 'WARNING',
      conclusion: 'dsh --version (0.2.0) differs from installation metadata (0.1.0).',
    })
  })

  it('warns with a limitation when the selected shim has no accepted installation reference', async () => {
    // Would catch guessing an installation root from an arbitrary command script.
    const result = await checkRuntime(runtimeSystem({ shim: '@echo off\r\nnode "%~dp0custom.js" %*\r\n' }), commands)

    expect(result.findings).toContainEqual({
      checkId: 'runtime.dsh.installation-unknown',
      severity: 'WARNING',
      conclusion: 'The selected dsh installation could not be determined from its shim.',
    })
    expect(result.limitations).toContain('The selected dsh shim did not contain an accepted DSH installation reference.')
    expect(result.installationRoot).toBeUndefined()
  })

  it('treats a manifest without a string Node range or existing CLI entry as unknown', async () => {
    // Would catch accepting partial metadata and later claiming Node compatibility for an unvalidated installation.
    const result = await checkRuntime(runtimeSystem({
      shim: shimFor(cliTarget),
      files: {
        [`${installationRoot}\\package.json`]: JSON.stringify({ version: '0.1.0', engines: {}, bin: { dsh: 'lib/missing.js' } }),
      },
    }), commands)

    expect(result.findings).toContainEqual({
      checkId: 'runtime.dsh.installation-unknown',
      severity: 'WARNING',
      conclusion: 'The selected dsh installation metadata is incomplete or invalid.',
    })
    expect(result.limitations).toContain('The selected DSH package metadata could not be validated.')
  })

  it('accepts the standard npm PowerShell basedir CLI reference', async () => {
    // Would catch rejecting npm's emitted PowerShell shim while accepting invented variable conventions.
    const root = 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh'
    const powershellCommands: CommandCheckResult = {
      ...commands,
      commands: { ...commands.commands, dsh: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\dsh.ps1' },
    }
    const result = await checkRuntime(runtimeSystem({
      shim: standardPowerShellShim(),
      files: {
        [`${root}\\package.json`]: JSON.stringify({
          version: '0.1.0',
          engines: { node: '>=22.0.0' },
          bin: 'lib/bin.js',
        }),
      },
    }), powershellCommands)

    expect(result.installationRoot).toBe(root)
    expect(result.findings).toContainEqual({
      checkId: 'runtime.node.supported',
      severity: 'PASS',
      conclusion: 'Node.js 22.19.0 satisfies >=22.0.0.',
    })
  })

  it('does not trust an arbitrary PowerShell variable as the shim directory', async () => {
    // Would catch treating an attacker-controlled variable name as proof of the selected npm installation root.
    const powershellCommands: CommandCheckResult = {
      ...commands,
      commands: { ...commands.commands, dsh: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\dsh.ps1' },
    }
    const result = await checkRuntime(runtimeSystem({
      shim: '$basedir="C:\\Other"\r\n& "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args\r\n',
      files: installation(installationRoot),
    }), powershellCommands)

    expect(result.installationRoot).toBeUndefined()
    expect(result.findings).toContainEqual({
      checkId: 'runtime.dsh.installation-unknown',
      severity: 'WARNING',
      conclusion: 'The selected dsh installation could not be determined from its shim.',
    })
  })

  it('rejects basedir references outside a live standard npm binding', async () => {
    // Would catch accepting a target before binding, after reassignment, or solely from a PowerShell comment.
    const powershellCommands: CommandCheckResult = {
      ...commands,
      commands: { ...commands.commands, dsh: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\dsh.ps1' },
    }
    const target = '& "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args'
    const standardAssignment = '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent'
    const fixtures = [
      [target, standardAssignment],
      [standardAssignment, '$basedir="C:\\Other"', target],
      [standardAssignment, `# ${target}`],
    ]

    for (const lines of fixtures) {
      const result = await checkRuntime(runtimeSystem({
        shim: lines.join('\r\n'),
        files: installation(installationRoot),
      }), powershellCommands)

      expect(result.installationRoot).toBeUndefined()
      expect(result.findings).toContainEqual({
        checkId: 'runtime.dsh.installation-unknown',
        severity: 'WARNING',
        conclusion: 'The selected dsh installation could not be determined from its shim.',
      })
    }
  })

  it('rejects inline and block-comment basedir references', async () => {
    // Would catch inert PowerShell comments manufacturing a validated npm installation root.
    const powershellCommands: CommandCheckResult = {
      ...commands,
      commands: { ...commands.commands, dsh: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\dsh.ps1' },
    }
    const standardAssignment = '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent'
    const fixtures = [
      [standardAssignment, 'Write-Output "it\'s safe" # $basedir/node_modules/@deepseek-ai/dsh/lib/bin.js'],
      [
        standardAssignment,
        '<#',
        '  $basedir/node_modules/@deepseek-ai/dsh/lib/bin.js',
        '  $basedir/node_modules/@deepseek-ai/dsh/package.json',
        '#>',
      ],
    ]

    for (const lines of fixtures) {
      const result = await checkRuntime(runtimeSystem({
        shim: lines.join('\r\n'),
        files: installation(installationRoot),
      }), powershellCommands)

      expect(result.installationRoot).toBeUndefined()
      expect(result.findings).toContainEqual({
        checkId: 'runtime.dsh.installation-unknown',
        severity: 'WARNING',
        conclusion: 'The selected dsh installation could not be determined from its shim.',
      })
    }
  })

  it('retains a basedir target with a hash inside a quoted argument', async () => {
    // Would catch comment filtering treating a literal hash in an executable command as an inline comment.
    const powershellCommands: CommandCheckResult = {
      ...commands,
      commands: { ...commands.commands, dsh: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\dsh.ps1' },
    }
    const result = await checkRuntime(runtimeSystem({
      shim: [
        '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
        '& "node$exe" "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" "#literal" $args',
      ].join('\r\n'),
      files: installation(installationRoot),
    }), powershellCommands)

    expect(result.installationRoot).toBe(installationRoot)
  })

  it('rejects inert basedir CLI and manifest strings', async () => {
    // Would catch arbitrary string data after a valid binding manufacturing a sibling installation root.
    const powershellCommands: CommandCheckResult = {
      ...commands,
      commands: { ...commands.commands, dsh: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\dsh.ps1' },
    }
    const standardAssignment = '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent'
    const fixtures = [
      [standardAssignment, 'Write-Output "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js"'],
      [standardAssignment, '"$basedir/node_modules/@deepseek-ai/dsh/package.json"'],
      [standardAssignment, '$candidate = "$basedir/node_modules/@deepseek-ai/dsh/package.json"'],
    ]

    for (const lines of fixtures) {
      const result = await checkRuntime(runtimeSystem({
        shim: lines.join('\r\n'),
        files: installation(installationRoot),
      }), powershellCommands)

      expect(result.installationRoot).toBeUndefined()
      expect(result.findings).toContainEqual({
        checkId: 'runtime.dsh.installation-unknown',
        severity: 'WARNING',
        conclusion: 'The selected dsh installation could not be determined from its shim.',
      })
    }
  })

  it('retains whitespace and case-tolerant PATH-node npm invocation', async () => {
    // Would catch narrowing the accepted npm form so far that the PATH-node branch no longer resolves.
    const powershellCommands: CommandCheckResult = {
      ...commands,
      commands: { ...commands.commands, dsh: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\dsh.ps1' },
    }
    const result = await checkRuntime(runtimeSystem({
      shim: [
        '  $BASEDIR = split-path $MYINVOCATION.MyCommand.Definition -parent',
        '  &  "node$exe"  "$BASEDIR/node_modules/@deepseek-ai/dsh/lib/bin.js"  "#literal"  $ARGS',
      ].join('\r\n'),
      files: installation(installationRoot),
    }), powershellCommands)

    expect(result.installationRoot).toBe(installationRoot)
  })

  it('accepts a basedir-anchored sibling package manifest reference', async () => {
    // Would catch accepting only the CLI form and needlessly rejecting the equally anchored package metadata form.
    const powershellCommands: CommandCheckResult = {
      ...commands,
      commands: { ...commands.commands, dsh: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\dsh.ps1' },
    }
    const result = await checkRuntime(runtimeSystem({
      shim: [
        '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
        'Test-Path "$basedir/node_modules/@deepseek-ai/dsh/package.json"',
      ].join('\r\n'),
      files: installation(installationRoot),
    }), powershellCommands)

    expect(result.installationRoot).toBe(installationRoot)
  })

  it('accepts an npm sibling CLI target reference', async () => {
    // Would catch rejecting the standard cmd shim target that is anchored to the shim directory.
    const result = await checkRuntime(runtimeSystem({
      shim: 'node "%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
      files: installation(installationRoot),
    }), commands)

    expect(result.installationRoot).toBe(installationRoot)
    expect(result.findings).toContainEqual({
      checkId: 'runtime.node.supported',
      severity: 'PASS',
      conclusion: 'Node.js 22.19.0 satisfies ^22.19.0 || >=24.0.0.',
    })
  })

  it('does not infer an installation root from a non-npm command', async () => {
    // Would catch attempting to read arbitrary executable contents as npm shim source.
    const executableCommands: CommandCheckResult = {
      ...commands,
      commands: { ...commands.commands, dsh: 'C:\\Tools\\dsh.exe' },
    }
    const result = await checkRuntime(runtimeSystem(), executableCommands)

    expect(result.findings).toContainEqual({
      checkId: 'runtime.dsh.installation-unknown',
      severity: 'WARNING',
      conclusion: 'The selected dsh installation could not be determined from its shim.',
    })
    expect(result.limitations).toContain('The selected dsh command is not an npm shim.')
  })

  it('reports one limitation when the selected npm shim cannot be read', async () => {
    // Would catch a read failure also being misreported as an unrecognized shim, producing duplicate findings.
    const result = await checkRuntime(runtimeSystem({ shimError: true }), commands)

    expect(result.findings.filter(({ checkId }) => checkId === 'runtime.dsh.installation-unknown')).toEqual([
      {
        checkId: 'runtime.dsh.installation-unknown',
        severity: 'WARNING',
        conclusion: 'The selected dsh installation could not be determined from its shim.',
      },
    ])
    expect(result.limitations).toEqual(['The selected dsh shim could not be read.'])
  })

  it('does not accept malformed package metadata or a missing declared CLI entry', async () => {
    // Would catch reporting compatibility from malformed JSON or a manifest entry that does not exist.
    const malformed = await checkRuntime(runtimeSystem({
      shim: shimFor(cliTarget),
      files: { [`${installationRoot}\\package.json`]: '{' },
    }), commands)
    const missingEntry = await checkRuntime(runtimeSystem({
      shim: shimFor(cliTarget),
      files: {
        [`${installationRoot}\\package.json`]: JSON.stringify({
          version: '0.1.0',
          engines: { node: '^22.19.0 || >=24.0.0' },
          bin: 'lib/missing.js',
        }),
      },
      absent: [`${installationRoot}\\lib\\missing.js`],
    }), commands)

    for (const result of [malformed, missingEntry]) {
      expect(result.findings).toContainEqual({
        checkId: 'runtime.dsh.installation-unknown',
        severity: 'WARNING',
        conclusion: 'The selected dsh installation metadata is incomplete or invalid.',
      })
      expect(result.installationRoot).toBeUndefined()
    }
  })

  it('rejects invalid manifest versions and unsafe or non-file CLI entries', async () => {
    // Would catch returning a validated installation root for metadata that cannot safely identify the DSH entry file.
    const cases: ReadonlyArray<{ readonly version?: string, readonly bin: string, readonly directories?: readonly string[] }> = [
      { version: 'not-a-semver', bin: 'lib/bin.js' },
      { bin: '' },
      { bin: 'C:\\Other\\bin.js' },
      { bin: '..\\outside.js' },
      { bin: 'lib/bin.js', directories: [`${installationRoot}\\lib\\bin.js`] },
    ]

    for (const fixture of cases) {
      const result = await checkRuntime(runtimeSystem({
        shim: shimFor(cliTarget),
        files: {
          [`${installationRoot}\\package.json`]: JSON.stringify({
            version: fixture.version ?? '0.1.0',
            engines: { node: '^22.19.0 || >=24.0.0' },
            bin: fixture.bin,
          }),
        },
        directories: fixture.directories,
      }), commands)

      expect(result.installationRoot).toBeUndefined()
      expect(result.findings).toContainEqual({
        checkId: 'runtime.dsh.installation-unknown',
        severity: 'WARNING',
        conclusion: 'The selected dsh installation metadata is incomplete or invalid.',
      })
    }
  })

  it('forwards the request abort signal only to selected version commands', async () => {
    // Would catch a cancelled doctor request leaving the two bounded subprocess probes running.
    const controller = new AbortController()
    const calls: Array<{ readonly file: string, readonly args: readonly string[], readonly signal: AbortSignal | undefined }> = []
    await checkRuntime(runtimeSystem({
      shim: shimFor(cliTarget),
      files: installation(installationRoot),
      onRun(file, args, signal) { calls.push({ file, args, signal }) },
    }), commands, controller.signal)

    expect(calls).toEqual([
      { file: commands.commands.node, args: ['--version'], signal: controller.signal },
      { file: commands.commands.dsh, args: ['--version'], signal: controller.signal },
    ])
  })

  it('reports invalid version output instead of treating it as compatible', async () => {
    // Would catch a malformed executable response silently bypassing the runtime compatibility check.
    const result = await checkRuntime(runtimeSystem({
      node: { exitCode: 0, stdout: 'not-a-version\n', stderr: '' },
      dsh: { exitCode: 0, stdout: 'still-not-a-version\n', stderr: '' },
      shim: shimFor(cliTarget),
      files: installation(installationRoot),
    }), commands)

    expect(result.findings).toEqual(expect.arrayContaining([
      {
        checkId: 'runtime.node.version-invalid',
        severity: 'BLOCKER',
        conclusion: 'node --version did not return a valid semantic version.',
      },
      {
        checkId: 'runtime.dsh.version-invalid',
        severity: 'WARNING',
        conclusion: 'dsh --version did not return a valid semantic version.',
      },
    ]))
    expect(result.environment).not.toHaveProperty('node.version')
    expect(result.environment).not.toHaveProperty('dsh.version')
  })

  it('does not run an unselected DSH command', async () => {
    // Would catch runtime checks repeating command discovery after Task 2 found no dsh command.
    const nodeOnly: CommandCheckResult = {
      findings: [],
      limitations: [],
      commands: { node: commands.commands.node },
    }
    const calls: string[] = []
    const result = await checkRuntime(runtimeSystem({
      onRun(file) { calls.push(file) },
    }), nodeOnly)

    expect(calls).toEqual([commands.commands.node])
    expect(result.findings).toContainEqual({
      checkId: 'runtime.node.supported',
      severity: 'PASS',
      conclusion: 'Node.js 22.19.0 satisfies ^22.19.0 || >=24.0.0.',
    })
    expect(result.findings).toContainEqual({
      checkId: 'runtime.dsh.installation-unknown',
      severity: 'WARNING',
      conclusion: 'The selected dsh installation could not be determined from its shim.',
    })
    expect(result.limitations).toContain('No selected dsh command is available.')
  })

  it('reports selected version command failures without empty stderr evidence', async () => {
    // Would catch failed subprocesses being mistaken for valid but absent versions.
    const result = await checkRuntime(runtimeSystem({
      node: { exitCode: 1, stdout: '', stderr: '' },
      dsh: { exitCode: 1, stdout: '', stderr: '' },
      shim: '@echo off\r\nnode "%~dp0custom.js" %*\r\n',
    }), commands)

    expect(result.findings).toEqual(expect.arrayContaining([
      {
        checkId: 'runtime.node.version-command',
        severity: 'BLOCKER',
        conclusion: 'node --version exited with code 1.',
      },
      {
        checkId: 'runtime.dsh.version-command',
        severity: 'BLOCKER',
        conclusion: 'dsh --version exited with code 1.',
      },
    ]))
    expect(result.findings.find(({ checkId }) => checkId === 'runtime.node.version-command')).not.toHaveProperty('evidence')
    expect(result.findings.find(({ checkId }) => checkId === 'runtime.dsh.version-command')).not.toHaveProperty('evidence')
  })

  it('uses the baseline range when no installation root can be validated', async () => {
    // Would catch an unrecognized shim bypassing the minimum Node.js requirement.
    const result = await checkRuntime(runtimeSystem({
      node: { exitCode: 0, stdout: 'v20.18.0\n', stderr: '' },
      shim: '@echo off\r\nnode "%~dp0custom.js" %*\r\n',
    }), commands)

    expect(result.findings).toContainEqual({
      checkId: 'runtime.node.unsupported',
      severity: 'BLOCKER',
      conclusion: 'Node.js 20.18.0 does not satisfy ^22.19.0 || >=24.0.0.',
    })
  })
})
