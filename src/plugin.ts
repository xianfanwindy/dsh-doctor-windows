import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { runDoctor } from './doctor.ts'
import type { SanitizedReport } from './redact.ts'

export const name = 'dsh-doctor-windows'
export const inject = ['tools']

const doctorReportSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1, required: true },
    generatedAt: { type: 'string', required: true },
    environment: { type: 'object', additionalProperties: true, required: true },
    target: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        dshHome: { type: 'string', required: true },
        profile: { type: 'string' },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        blocker: { type: 'integer', required: true },
        warning: { type: 'integer', required: true },
        info: { type: 'integer', required: true },
        pass: { type: 'integer', required: true },
      },
    },
    findings: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          checkId: { type: 'string', required: true },
          severity: { type: 'string', enum: ['BLOCKER', 'WARNING', 'INFO', 'PASS'], required: true },
          conclusion: { type: 'string', required: true },
          evidence: { type: 'array', items: { type: 'string' } },
          remediation: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    limitations: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

type DoctorToolValue = InferValue<typeof doctorReportSchema>

function asDoctorToolValue(report: SanitizedReport): DoctorToolValue {
  return report as unknown as DoctorToolValue
}

/** Register the read-only DSH startup doctor tool. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'dsh_doctor',
    description: 'Diagnose Windows DSH startup and profile problems without changing the installation.',
    parameters: {
      profile: { type: 'string', description: 'Optional DSH profile name to inspect.' },
    },
    output: {
      schema: doctorReportSchema,
      render: (_args, value) => [{
        type: 'text',
        text: `DSH Doctor: ${value.summary.blocker} blocker(s), ${value.summary.warning} warning(s).`,
      }],
    },
    async execute(args, exec) {
      const report = await runDoctor({ profile: args.profile, signal: exec.signal })
      return asDoctorToolValue(report)
    },
  }))
}
