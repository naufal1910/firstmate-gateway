import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { VERSION } from '../index.js';

interface PackageMetadata {
  readonly version: string;
  readonly filename: string;
}

test('package metadata, exported/CLI version, and packed artifact stay aligned', () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    readonly version?: unknown;
  };
  assert.equal(packageJson.version, VERSION);

  const cliVersion = execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), '--version'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(cliVersion, VERSION);

  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })) as readonly PackageMetadata[];
  const metadata = packed[0];
  assert.ok(metadata);
  assert.equal(metadata.version, VERSION);
  assert.equal(metadata.filename, `firstmate-gateway-${VERSION}.tgz`);
});
