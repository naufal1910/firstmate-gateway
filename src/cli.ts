#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { VERSION } from './index.js';
import { createRequestId, Gateway, type DoctorReport, type TargetStatus, type TargetSummary } from './gateway.js';
import { GatewayError, withRequestId, type GatewayErrorPayload } from './errors.js';

const HELP = `firstmate-gateway ${VERSION}

Usage:
  firstmate-gateway --help
  firstmate-gateway --version
  firstmate-gateway targets [--json]
  firstmate-gateway status <target> [--json]
  firstmate-gateway doctor [--json]

Read-only discovery and status commands resolve Herdr targets dynamically.
`;

type Command = 'targets' | 'status' | 'doctor';

interface ParsedArgs {
  readonly command?: Command;
  readonly target?: string;
  readonly json: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly error?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let json = false;
  let help = false;
  let version = false;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-V') {
      version = true;
    } else if (arg.startsWith('-')) {
      return { json, help, version, error: `unknown option: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  if (help || version) {
    return { json, help, version };
  }

  const [command, target, extra] = positional;
  if (command !== 'targets' && command !== 'status' && command !== 'doctor') {
    return { json, help, version, error: 'a read-only command is required: targets, status, or doctor' };
  }
  if (command === 'status' && target === undefined) {
    return { json, help, version, error: 'status requires a target alias' };
  }
  if (command !== 'status' && target !== undefined) {
    return { json, help, version, error: `${command} does not accept a target alias` };
  }
  if (extra !== undefined) {
    return { json, help, version, error: `unexpected argument: ${extra}` };
  }

  return { command, ...(target === undefined ? {} : { target }), json, help, version };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function printTargets(targets: readonly TargetSummary[], json: boolean): void {
  if (json) {
    printJson({ targets });
    return;
  }
  if (targets.length === 0) {
    console.log('No configured targets.');
    return;
  }
  for (const target of targets) {
    console.log(`${target.target}\t${target.agent}\tHerdr session: ${target.herdrSession}`);
  }
}

function printStatus(status: TargetStatus, json: boolean): void {
  if (json) {
    printJson(status);
    return;
  }
  console.log(`${status.target}: ${status.state}`);
  if (status.evidence.cwdSource === 'cwd') {
    console.log('  diagnostic: used fallback runtime cwd evidence');
  }
  if (status.diagnostic !== undefined) {
    console.log(`  diagnostic: ${status.diagnostic}`);
  }
}

function printDoctor(report: DoctorReport, json: boolean): void {
  if (json) {
    printJson(report);
    return;
  }
  console.log(`doctor: ${report.ok ? 'ok' : 'failed'}`);
  for (const check of report.checks) {
    const status = check.ok ? 'ok' : 'failed';
    const code = check.code === undefined ? '' : ` [${check.code}]`;
    console.log(`  ${status} ${check.name}${code}: ${check.message}`);
  }
}

function errorPayload(error: unknown, requestId: string): GatewayErrorPayload {
  return withRequestId(error, requestId).toJSON();
}

function printError(error: unknown, json: boolean, requestId: string): void {
  const payload = errorPayload(error, requestId);
  if (json) {
    printJson({ error: payload });
    return;
  }
  console.error(`${payload.code}: ${payload.message}`);
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const requestId = createRequestId();
  const parsed = parseArgs(args);

  if (parsed.version) {
    console.log(VERSION);
    return 0;
  }
  if (parsed.help || args.length === 0) {
    console.log(HELP);
    return 0;
  }
  if (parsed.error !== undefined) {
    printError(new GatewayError('INVALID_ARGUMENT', parsed.error, undefined, { requestId }), parsed.json, requestId);
    if (!parsed.json) {
      console.error('Run "firstmate-gateway --help" for usage.');
    }
    return 2;
  }

  const gateway = new Gateway();
  try {
    switch (parsed.command) {
      case 'targets':
        printTargets(await gateway.listTargets({ requestId }), parsed.json);
        return 0;
      case 'status':
        printStatus(await gateway.getStatus(parsed.target as string, { requestId }), parsed.json);
        return 0;
      case 'doctor': {
        const report = await gateway.doctor({ requestId });
        printDoctor(report, parsed.json);
        return report.ok ? 0 : 1;
      }
    }
  } catch (error) {
    const gatewayError = withRequestId(error, requestId);
    printError(gatewayError, parsed.json, requestId);
    return gatewayError.code === 'INVALID_ARGUMENT' ? 2 : 1;
  }

  return 2;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }

  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main();
}
