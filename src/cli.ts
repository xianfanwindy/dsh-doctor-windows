#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runDoctor } from './doctor.ts'
import type { DiagnosticRequest } from './model.ts'
import type { SanitizedReport } from './redact.ts'
import { renderJson, renderMarkdown, renderTerminal } from './render.ts'

const require = createRequire(import.meta.url)
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const USAGE = 'Usage: dsh-doctor [--profile <name>] [--dsh-home <path>] [--format terminal|markdown|json] [--output <path>] [--no-color] [--verbose] [--version] [--help]\n'

interface TextOutput {
  write(text: string): unknown
}

export interface CliPorts {
  readonly stdout: TextOutput
  readonly stderr: TextOutput
  readonly writeFile: (path: string, text: string) => Promise<void>
  readonly runDoctor: (request: DiagnosticRequest) => Promise<SanitizedReport>
  readonly platform: NodeJS.Platform
}

interface ParsedOptions {
  readonly profile?: string
  readonly dshHome?: string
  readonly format: 'terminal' | 'markdown' | 'json'
  readonly output?: string
  readonly noColor: boolean
  readonly verbose: boolean
  readonly help: boolean
  readonly version: boolean
}

function scalar(value: string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length !== 1) throw new TypeError('Repeated scalar option.')
  return value[0]
}

function parse(argv: readonly string[]): ParsedOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: 'string', multiple: true },
      'dsh-home': { type: 'string', multiple: true },
      format: { type: 'string', multiple: true },
      output: { type: 'string', multiple: true },
      'no-color': { type: 'boolean' },
      verbose: { type: 'boolean' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  })
  const profile = scalar(values.profile)
  const dshHome = scalar(values['dsh-home'])
  const format = scalar(values.format) ?? 'terminal'
  const output = scalar(values.output)
  if (profile !== undefined && !PROFILE_NAME.test(profile)) throw new TypeError('Invalid profile name.')
  if (format !== 'terminal' && format !== 'markdown' && format !== 'json') throw new TypeError('Invalid format.')
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(dshHome === undefined ? {} : { dshHome }),
    format,
    ...(output === undefined ? {} : { output }),
    noColor: values['no-color'] ?? false,
    verbose: values.verbose ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  }
}

function packageVersion(): string {
  const packageJson = require('../package.json') as { readonly version?: unknown }
  return typeof packageJson.version === 'string' ? packageJson.version : 'unknown'
}

function render(report: SanitizedReport, options: ParsedOptions): string {
  if (options.format === 'markdown') return renderMarkdown(report, { verbose: options.verbose })
  if (options.format === 'json') return renderJson(report)
  return renderTerminal(report, { verbose: options.verbose, color: !options.noColor })
}

function writeUsage(stderr: TextOutput): void {
  stderr.write(USAGE)
}

/** Runs the doctor CLI using only the supplied process and filesystem ports. */
export async function main(argv: readonly string[], ports: CliPorts): Promise<0 | 1 | 2> {
  let options: ParsedOptions
  try {
    options = parse(argv)
  } catch {
    writeUsage(ports.stderr)
    return 2
  }
  if (options.help) {
    ports.stdout.write(USAGE)
    return 0
  }
  if (options.version) {
    ports.stdout.write(`${packageVersion()}\n`)
    return 0
  }
  if (ports.platform !== 'win32') {
    ports.stderr.write('DSH Doctor requires Windows.\n')
    return 2
  }

  let report: SanitizedReport
  try {
    report = await ports.runDoctor({
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
    })
  } catch {
    ports.stderr.write('Could not initialize DSH Doctor.\n')
    return 2
  }
  const output = render(report, options)
  try {
    if (options.output === undefined) ports.stdout.write(output)
    else await ports.writeFile(options.output, output)
  } catch {
    ports.stderr.write('Could not write report.\n')
    return 2
  }
  return report.summary.blocker === 0 ? 0 : 1
}

const realPorts: CliPorts = {
  stdout: process.stdout,
  stderr: process.stderr,
  writeFile,
  runDoctor,
  platform: process.platform,
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), realPorts)
}
