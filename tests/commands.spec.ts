import { describe, expect, it } from 'vitest'
import { checkCommands } from '../src/checks/commands.ts'
import { createFakeSystem, type CommandCandidate } from './helpers.ts'

const candidates = (...items: readonly CommandCandidate[]) => items

describe('checkCommands', () => {
  it('reports node as a blocker when no candidate exists', async () => {
    // Would catch accidentally treating an empty PowerShell result as a usable node command.
    const result = await checkCommands(createFakeSystem({
      powershellOutput: JSON.stringify([
        null,
        { Name: 'other', Path: 'C:\\Tools\\other.exe', CommandType: 'Application' },
        { Name: 'node', CommandType: 'Application' },
        { Name: 'node', Path: '', CommandType: 'Application' },
        { Name: 'node', Path: 'C:\\Tools\\node.exe', CommandType: 'Alias' },
      ]),
      pwshOutput: '',
    }))

    expect(result.findings).toContainEqual({
      checkId: 'command.node.missing',
      severity: 'BLOCKER',
      conclusion: 'No usable node command was found.',
    })
    expect(result.commands.node).toBeUndefined()
  })

  it('reports dsh as a blocker when no candidate exists', async () => {
    // Would catch discovery selecting an unrelated command while dsh is absent.
    const result = await checkCommands(createFakeSystem({
      powershellOutput: JSON.stringify({ Name: 'node', Path: 'C:\\Program Files\\nodejs\\node.exe', CommandType: 'Application' }),
      pwshOutput: JSON.stringify({ Name: 'pnpm', Path: 'C:\\Users\\Doctor\\AppData\\Roaming\\npm\\pnpm.cmd', CommandType: 'Application' }),
    }))

    expect(result.findings).toContainEqual({
      checkId: 'command.dsh.missing',
      severity: 'BLOCKER',
      conclusion: 'No usable dsh command was found.',
    })
    expect(result.commands.dsh).toBeUndefined()
  })

  it('reports pnpm as a warning when no candidate exists', async () => {
    // Would catch the optional pnpm command being treated as a blocker or silently ignored.
    const result = await checkCommands(createFakeSystem({
      powershell: candidates(
        { Name: 'node', Path: 'C:\\Program Files\\nodejs\\node.exe', CommandType: 'Application' },
        { Name: 'dsh', Path: 'C:\\Tools\\dsh.cmd', CommandType: 'Application' },
      ),
      pwsh: candidates(),
    }))

    expect(result.findings).toContainEqual({
      checkId: 'command.pnpm.missing',
      severity: 'WARNING',
      conclusion: 'No usable pnpm command was found.',
    })
    expect(result.commands.pnpm).toBeUndefined()
  })

  it('warns about multiple dsh candidates with sorted candidate evidence', async () => {
    // Would catch nondeterministic candidate selection or omitting the competing command paths.
    const result = await checkCommands(createFakeSystem({
      powershell: candidates(
        { Name: 'dsh', Path: 'C:\\Zulu\\dsh.ps1', CommandType: 'ExternalScript' },
        { Name: 'dsh', Path: 'C:\\Alpha\\dsh.cmd', CommandType: 'Application' },
      ),
      pwsh: candidates(),
      executionPolicyOutput: '',
    }))

    expect(result.findings).toContainEqual({
      checkId: 'command.dsh.multiple',
      severity: 'WARNING',
      conclusion: 'Multiple usable dsh commands were found.',
      evidence: ['powershell.exe: C:\\Zulu\\dsh.ps1', 'powershell.exe: C:\\Alpha\\dsh.cmd'],
    })
    expect(result.commands.dsh).toBe('C:\\Zulu\\dsh.ps1')
  })

  it('blocks a selected PowerShell script under Restricted execution policy', async () => {
    // Would catch a selected .ps1 shim whose execution policy prevents dsh from starting.
    const result = await checkCommands(createFakeSystem({
      powershell: candidates(
        { Name: 'node', Path: 'C:\\Tools\\node.exe', CommandType: 'Application' },
        { Name: 'dsh', Path: 'C:\\Tools\\dsh.ps1', CommandType: 'ExternalScript' },
        { Name: 'pnpm', Path: 'C:\\Tools\\pnpm.cmd', CommandType: 'Application' },
      ),
      pwsh: candidates(),
      executionPolicy: 'Restricted',
      executionPolicyOutput: JSON.stringify({ Scope: 'CurrentUser', ExecutionPolicy: 'Restricted' }),
    }))

    expect(result.findings).toContainEqual({
      checkId: 'command.dsh.execution-policy',
      severity: 'BLOCKER',
      conclusion: 'The selected dsh PowerShell script is blocked by Restricted execution policy.',
    })
  })

  it('does not block a selected script when a higher-precedence policy overrides Restricted', async () => {
    // Would catch a lower-precedence LocalMachine Restricted policy overriding CurrentUser RemoteSigned.
    const result = await checkCommands(createFakeSystem({
      powershell: candidates(
        { Name: 'node', Path: 'C:\\Tools\\node.exe', CommandType: 'Application' },
        { Name: 'dsh', Path: 'C:\\Tools\\dsh.ps1', CommandType: 'ExternalScript' },
        { Name: 'pnpm', Path: 'C:\\Tools\\pnpm.cmd', CommandType: 'Application' },
      ),
      pwsh: candidates(),
      executionPolicyOutput: JSON.stringify([
        { Scope: 'MachinePolicy', ExecutionPolicy: 'Undefined' },
        { Scope: 'UserPolicy', ExecutionPolicy: 'Undefined' },
        { Scope: 'Process', ExecutionPolicy: 'Undefined' },
        { Scope: 'CurrentUser', ExecutionPolicy: 'RemoteSigned' },
        { Scope: 'LocalMachine', ExecutionPolicy: 'Restricted' },
      ]),
    }))

    expect(result.findings).not.toContainEqual(expect.objectContaining({ checkId: 'command.dsh.execution-policy' }))
  })

  it('passes each command when one usable candidate exists', async () => {
    // Would catch command discovery that finds paths but fails to surface selected commands as passes.
    const result = await checkCommands(createFakeSystem({
      powershell: candidates(
        { Name: 'node', Path: 'C:\\Tools\\node.exe', CommandType: 'Application' },
        { Name: 'dsh', Path: 'C:\\Tools\\dsh.cmd', CommandType: 'Application' },
        { Name: 'pnpm', Path: 'C:\\Tools\\pnpm.cmd', CommandType: 'Application' },
      ),
      pwsh: candidates(
        { Name: 'node', Path: 'C:\\Tools\\node.exe', CommandType: 'Application' },
        { Name: 'dsh', Path: 'C:\\Tools\\dsh.cmd', CommandType: 'Application' },
        { Name: 'pnpm', Path: 'C:\\Tools\\pnpm.cmd', CommandType: 'Application' },
      ),
    }))

    expect(result.findings).toEqual(expect.arrayContaining([
      { checkId: 'command.node.found', severity: 'PASS', conclusion: 'Selected node command: C:\\Tools\\node.exe.' },
      { checkId: 'command.dsh.found', severity: 'PASS', conclusion: 'Selected dsh command: C:\\Tools\\dsh.cmd.' },
      { checkId: 'command.pnpm.found', severity: 'PASS', conclusion: 'Selected pnpm command: C:\\Tools\\pnpm.cmd.' },
    ]))
    expect(result.commands).toEqual({
      node: 'C:\\Tools\\node.exe',
      dsh: 'C:\\Tools\\dsh.cmd',
      pnpm: 'C:\\Tools\\pnpm.cmd',
    })
  })

  it('keeps pwsh candidates when the Windows PowerShell probe fails', async () => {
    // Would catch a failed first probe discarding usable command paths from the other shell.
    const result = await checkCommands(createFakeSystem({
      powershellError: 'Access denied',
      pwsh: candidates(
        { Name: 'node', Path: 'C:\\Tools\\node.exe', CommandType: 'Application' },
        { Name: 'dsh', Path: 'C:\\Tools\\dsh.cmd', CommandType: 'Application' },
        { Name: 'pnpm', Path: 'C:\\Tools\\pnpm.cmd', CommandType: 'Application' },
      ),
    }))

    expect(result.findings).toContainEqual({
      checkId: 'command.powershell.exe.probe',
      severity: 'WARNING',
      conclusion: 'powershell.exe command probe failed: Access denied',
    })
    expect(result.limitations).toEqual(['powershell.exe command probe failed: Access denied'])
    expect(result.commands).toEqual({
      node: 'C:\\Tools\\node.exe',
      dsh: 'C:\\Tools\\dsh.cmd',
      pnpm: 'C:\\Tools\\pnpm.cmd',
    })
  })

  it('does not warn when pwsh is not installed', async () => {
    // Would catch optional pwsh absence becoming a probe warning that obscures Windows PowerShell results.
    const result = await checkCommands(createFakeSystem({
      powershell: candidates(
        { Name: 'node', Path: 'C:\\Tools\\node.exe', CommandType: 'Application' },
        { Name: 'dsh', Path: 'C:\\Tools\\dsh.cmd', CommandType: 'Application' },
        { Name: 'pnpm', Path: 'C:\\Tools\\pnpm.cmd', CommandType: 'Application' },
      ),
      pwshError: 'spawn pwsh.exe ENOENT',
      pwshErrorCode: 'ENOENT',
    }))

    expect(result.findings).not.toContainEqual(expect.objectContaining({ checkId: 'command.pwsh.exe.probe' }))
    expect(result.limitations).toEqual([])
  })

  it('reports malformed compressed command output as a probe warning', async () => {
    // Would catch invalid JSON being silently interpreted as an empty command table.
    const result = await checkCommands(createFakeSystem({
      powershellOutput: '{',
      pwsh: candidates(),
    }))

    expect(result.findings).toContainEqual({
      checkId: 'command.powershell.exe.probe',
      severity: 'WARNING',
      conclusion: 'powershell.exe command probe returned invalid JSON.',
    })
    expect(result.limitations).toEqual(['powershell.exe command probe returned invalid JSON.'])
  })
})
