#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DeploymentError,
  installPackedArtifact,
  rollbackRuntime,
} from './deployment.js';

const HELP = `firstmate-gateway-install

Install a verified packed firstmate-gateway artifact outside a source checkout.

Usage:
  firstmate-gateway-install --artifact <absolute.tgz> --sha256 <digest> [--root <path>] [--json]
  firstmate-gateway-install rollback --runtime <name> [--root <path>] [--json]

The active runtime pointer is changed atomically. Existing version directories are retained.
`;

interface ParsedArguments {
  readonly command: 'install' | 'rollback';
  readonly artifact?: string;
  readonly sha256?: string;
  readonly runtime?: string;
  readonly root?: string;
  readonly json: boolean;
  readonly help: boolean;
  readonly error?: string;
}

function valueAfter(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0) throw new DeploymentError(`${option} requires a value`);
  return value;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  let command: ParsedArguments['command'] = 'install';
  let artifact: string | undefined;
  let sha256: string | undefined;
  let runtime: string | undefined;
  let root: string | undefined;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === 'rollback') {
      if (command !== 'install') return { command, json, help, error: 'command may be specified only once' };
      command = 'rollback';
      continue;
    }
    if (arg === '--artifact' || arg === '--sha256' || arg === '--runtime' || arg === '--root') {
      let value: string;
      try {
        value = valueAfter(args, index, arg);
      } catch (error) {
        return { command, json, help, error: error instanceof Error ? error.message : `${arg} requires a value` };
      }
      index += 1;
      if (arg === '--artifact') {
        if (artifact !== undefined) return { command, json, help, error: '--artifact may be specified only once' };
        artifact = value;
      } else if (arg === '--sha256') {
        if (sha256 !== undefined) return { command, json, help, error: '--sha256 may be specified only once' };
        sha256 = value;
      } else if (arg === '--runtime') {
        if (runtime !== undefined) return { command, json, help, error: '--runtime may be specified only once' };
        runtime = value;
      } else {
        if (root !== undefined) return { command, json, help, error: '--root may be specified only once' };
        root = value;
      }
      continue;
    }
    return { command, json, help, error: `unknown option or argument: ${arg}` };
  }
  if (help) return { command, json, help };
  if (command === 'install' && (artifact === undefined || sha256 === undefined)) {
    return { command, json, help, error: 'install requires --artifact and --sha256' };
  }
  if (command === 'rollback' && runtime === undefined) {
    return { command, json, help, error: 'rollback requires --runtime' };
  }
  if (command === 'install' && runtime !== undefined) return { command, json, help, error: '--runtime is only valid with rollback' };
  if (command === 'rollback' && (artifact !== undefined || sha256 !== undefined)) {
    return { command, json, help, error: '--artifact and --sha256 are only valid with install' };
  }
  return {
    command,
    ...(artifact === undefined ? {} : { artifact }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(root === undefined ? {} : { root }),
    json,
    help,
  };
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.help || args.length === 0) {
    console.log(HELP);
    return 0;
  }
  if (parsed.error !== undefined) {
    console.error(`INVALID_ARGUMENT: ${parsed.error}`);
    return 2;
  }
  try {
    const result = parsed.command === 'install'
      ? await installPackedArtifact({
        artifact: parsed.artifact as string,
        sha256: parsed.sha256 as string,
        ...(parsed.root === undefined ? {} : { root: parsed.root }),
      })
      : await rollbackRuntime({
        runtimeName: parsed.runtime as string,
        ...(parsed.root === undefined ? {} : { root: parsed.root }),
      });
    printResult(result, parsed.json);
    return 0;
  } catch (error) {
    console.error(`DEPLOYMENT_FAILED: ${error instanceof DeploymentError ? error.message : 'deployment operation failed'}`);
    return 1;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = await main();
