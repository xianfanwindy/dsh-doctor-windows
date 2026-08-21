import { execFile } from 'node:child_process'
import { access, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { SanitizedReport } from '../src/redact.ts'

const doctor = vi.hoisted(() => ({ runDoctor: vi.fn() }))
const execFileAsync = promisify(execFile)

vi.mock('../src/doctor.ts', () => ({ runDoctor: doctor.runDoctor }))

import { apply, inject, name } from '../src/plugin.ts'

function report(): SanitizedReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-20T00:00:00.000Z',
    environment: { 'node.version': '22.19.0' },
    target: { dshHome: '<DSH_HOME>', profile: 'doctor' },
    summary: { blocker: 2, warning: 3, info: 0, pass: 4 },
    findings: [{
      checkId: 'runtime.node.supported',
      severity: 'PASS',
      conclusion: 'Node is supported.',
      evidence: ['v22.19.0'],
      remediation: ['Keep this version.'],
    }],
    limitations: ['One unavailable check.'],
  } as unknown as SanitizedReport
}

function createRegistryFixture(): { readonly ctx: Context, readonly tools: ToolRuntime, readonly register: ReturnType<typeof vi.spyOn> } {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  const tools = new ToolRuntime(ctx)
  return { ctx, tools, register: vi.spyOn(tools, 'register') }
}

describe('Cordis doctor plugin', () => {
  it('registers the generated dsh_doctor definition and disposes it with its Cordis fiber', async () => {
    const fixture = createRegistryFixture()
    const fiber = fixture.ctx.plugin({ name, inject, apply })

    await fiber

    expect(name).toBe('dsh-doctor-windows')
    expect(inject).toEqual(['tools'])
    expect(apply).toHaveLength(1)
    expect(fixture.register).toHaveBeenCalledTimes(1)
    const definition = fixture.register.mock.calls[0]?.[0]
    expect(definition?.name).toBe('dsh_doctor')
    expect(definition?.parameters).toEqual({
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'Optional DSH profile name to inspect.' },
      },
    })
    expect(Object.keys(definition?.parameters.properties ?? {})).toEqual(['profile'])
    expect(fixture.tools.get('dsh_doctor')).toBe(definition)

    await fiber.dispose()

    expect(fixture.tools.get('dsh_doctor')).toBeUndefined()
  })

  it('forwards the optional profile and execution signal while preserving the sanitized report identity', async () => {
    const fixture = createRegistryFixture()
    const fiber = fixture.ctx.plugin({ name, inject, apply })
    await fiber
    const definition = fixture.tools.get('dsh_doctor')
    const value = report()
    const controller = new AbortController()
    doctor.runDoctor.mockResolvedValueOnce(value)

    const result = await definition?.execute({ profile: 'doctor' }, { signal: controller.signal } as never)

    expect(doctor.runDoctor).toHaveBeenCalledWith({ profile: 'doctor', signal: controller.signal })
    expect(result).toBe(value)
    expect(definition?.output.render({ profile: 'doctor' }, value)).toEqual([{
      type: 'text',
      text: 'DSH Doctor: 2 blocker(s), 3 warning(s).',
    }])
    await fiber.dispose()
  })

  it('closes the report DTO while retaining the string environment record', async () => {
    const fixture = createRegistryFixture()
    const fiber = fixture.ctx.plugin({ name, inject, apply })
    await fiber
    const definition = fixture.tools.get('dsh_doctor')
    const schema = definition?.output.schema

    expect(schema).toMatchObject({ type: 'object', additionalProperties: false })
    expect(validateJsonSchemaValue(schema!, report())).toEqual([])
    expect(validateJsonSchemaValue(schema!, { ...report(), extra: true }).join('\n')).toContain('extra')
    expect(validateJsonSchemaValue(schema!, {
      ...report(),
      summary: { ...report().summary, extra: true },
    }).join('\n')).toContain('extra')
    expect(validateJsonSchemaValue(schema!, {
      ...report(),
      findings: [{ ...report().findings[0]!, extra: true }],
    }).join('\n')).toContain('extra')
    await fiber.dispose()
  })

  it('ships the exact configuration-free bundle patch', async () => {
    await expect(readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).resolves.toBe(
      '- insert:\n    - id: dsh-doctor-windows\n      name: dsh-doctor-windows/plugin\n',
    )
  })

  it('emits the plugin export artifacts from the normal configured build', async () => {
    const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly exports: { readonly './plugin': { readonly default: string, readonly types: string } }
    }

    await rm(resolve(packageRoot, 'lib'), { force: true, recursive: true })
    await execFileAsync(process.execPath, ['node_modules/tsdown/dist/run.mjs'], { cwd: packageRoot })

    await expect(access(resolve(packageRoot, manifest.exports['./plugin'].default))).resolves.toBeUndefined()
    await expect(access(resolve(packageRoot, manifest.exports['./plugin'].types))).resolves.toBeUndefined()
  })
})
