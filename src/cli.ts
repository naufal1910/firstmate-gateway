#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { VERSION } from './index.js';

const HELP = `firstmate-gateway ${VERSION}

Usage:
  firstmate-gateway --help
  firstmate-gateway --version

This foundation release only exposes package and compatibility primitives.
Target operations are intentionally not enabled until the later milestones.
`;

export function main(args: readonly string[] = process.argv.slice(2)): number {
  const [command] = args;

  if (command === '--version' || command === '-V') {
    console.log(VERSION);
    return 0;
  }

  if (command === undefined || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }

  console.error(`Unknown option: ${command}`);
  console.error('Run "firstmate-gateway --help" for usage.');
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
  process.exitCode = main();
}
