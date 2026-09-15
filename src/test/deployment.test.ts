import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readlink, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DeploymentError,
  installPackedArtifact,
  rollbackRuntime,
  runtimeLayout,
  validateRuntimeName,
} from '../deployment.js';

async function makeRuntimeRemovable(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeRuntimeRemovable(join(path, entry.name));
  }
}

async function runtimeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'firstmate-gateway-runtime-test-'));
  const layout = runtimeLayout(root);
  for (const [runtime, version] of [['0.4.0-aaaaaaaaaaaa', '0.4.0'], ['0.5.0-bbbbbbbbbbbb', '0.5.0']] as const) {
    const packageRoot = join(layout.versions, runtime, 'node_modules', 'firstmate-gateway');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'firstmate-gateway', version }));
    await writeFile(join(layout.versions, runtime, '.artifact-sha256'), `${'a'.repeat(64)}\n`);
  }
  return root;
}

test('runtime layout uses retained version directories and an active pointer', async () => {
  const root = await runtimeFixture();
  try {
    const first = await rollbackRuntime({ root, runtimeName: '0.4.0-aaaaaaaaaaaa' });
    assert.equal(first.previousRuntimeName, undefined);
    assert.equal(await readlink(runtimeLayout(root).active), 'versions/0.4.0-aaaaaaaaaaaa');

    const second = await rollbackRuntime({ root, runtimeName: '0.5.0-bbbbbbbbbbbb' });
    assert.equal(second.previousRuntimeName, '0.4.0-aaaaaaaaaaaa');
    assert.equal(await readlink(runtimeLayout(root).active), 'versions/0.5.0-bbbbbbbbbbbb');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('staged digest mismatch fails before npm and removes private staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firstmate-gateway-artifact-test-'));
  const artifact = join(root, 'gateway.tgz');
  const npmMarker = join(root, 'npm-was-called');
  const fakeNpm = join(root, 'fake-npm.mjs');
  try {
    await writeFile(artifact, 'not-a-packed-artifact');
    await writeFile(fakeNpm, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(npmMarker)}, 'called');\n`);
    await chmod(fakeNpm, 0o700);
    const runtimeRoot = join(root, 'runtime');
    await assert.rejects(
      installPackedArtifact({ artifact, sha256: '0'.repeat(64), root: runtimeRoot, npmPath: fakeNpm }),
      (error: unknown) => error instanceof DeploymentError && error.message.includes('sha256 does not match'),
    );
    await assert.rejects(() => stat(npmMarker));
    assert.deepEqual(await readdir(runtimeRoot), ['versions']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('npm receives a private staged snapshot and original replacement cannot alter installed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firstmate-gateway-toctou-test-'));
  const artifact = join(root, 'gateway.tgz');
  const fakeNpm = join(root, 'fake-npm.mjs');
  const invocation = join(root, 'invocation.json');
  const installedBytes = join(root, 'installed.tgz');
  const originalBytes = Buffer.from('original packed artifact bytes');
  const priorOriginal = process.env.FIRSTMATE_GATEWAY_TEST_ORIGINAL;
  const priorInvocation = process.env.FIRSTMATE_GATEWAY_TEST_INVOCATION;
  const priorInstalled = process.env.FIRSTMATE_GATEWAY_TEST_INSTALLED;
  try {
    await writeFile(artifact, originalBytes);
    await writeFile(fakeNpm, `#!/usr/bin/env node
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const staged = args.at(-1);
writeFileSync(process.env.FIRSTMATE_GATEWAY_TEST_INVOCATION, JSON.stringify({ args, staged, mode: statSync(staged).mode & 0o777 }));
writeFileSync(process.env.FIRSTMATE_GATEWAY_TEST_ORIGINAL, 'replacement after staging');
copyFileSync(staged, process.env.FIRSTMATE_GATEWAY_TEST_INSTALLED);
const packageRoot = join(prefix, 'node_modules', 'firstmate-gateway');
mkdirSync(packageRoot, { recursive: true });
writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'firstmate-gateway', version: '0.5.0' }));
`);
    await chmod(fakeNpm, 0o700);
    process.env.FIRSTMATE_GATEWAY_TEST_ORIGINAL = artifact;
    process.env.FIRSTMATE_GATEWAY_TEST_INVOCATION = invocation;
    process.env.FIRSTMATE_GATEWAY_TEST_INSTALLED = installedBytes;
    const runtimeRoot = join(root, 'runtime');
    const result = await installPackedArtifact({
      artifact,
      sha256: createHash('sha256').update(originalBytes).digest('hex'),
      root: runtimeRoot,
      npmPath: fakeNpm,
    });
    const recorded = JSON.parse(await readFile(invocation, 'utf8')) as { readonly args: readonly string[]; readonly staged: string; readonly mode: number };
    assert.deepEqual(recorded.args.slice(0, 2), ['install', '--prefix']);
    assert.deepEqual(recorded.args.slice(3, 7), ['--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock']);
    assert.notEqual(recorded.staged, artifact);
    assert.equal(recorded.staged.startsWith(join(runtimeRoot, '.staging-')), true);
    assert.equal(recorded.mode, 0o600);
    assert.deepEqual(await readFile(installedBytes), originalBytes);
    assert.deepEqual(await readFile(artifact, 'utf8'), 'replacement after staging');
    await assert.rejects(() => stat(recorded.staged));
    assert.equal(result.runtimeName, '0.5.0-' + createHash('sha256').update(originalBytes).digest('hex').slice(0, 12));
    assert.deepEqual((await readdir(runtimeRoot)).sort(), ['active', 'versions']);
  } finally {
    await makeRuntimeRemovable(join(root, 'runtime')).catch(() => undefined);
    if (priorOriginal === undefined) delete process.env.FIRSTMATE_GATEWAY_TEST_ORIGINAL;
    else process.env.FIRSTMATE_GATEWAY_TEST_ORIGINAL = priorOriginal;
    if (priorInvocation === undefined) delete process.env.FIRSTMATE_GATEWAY_TEST_INVOCATION;
    else process.env.FIRSTMATE_GATEWAY_TEST_INVOCATION = priorInvocation;
    if (priorInstalled === undefined) delete process.env.FIRSTMATE_GATEWAY_TEST_INSTALLED;
    else process.env.FIRSTMATE_GATEWAY_TEST_INSTALLED = priorInstalled;
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime names reject traversal and symlink-shaped values', () => {
  assert.equal(validateRuntimeName('0.5.0-0123456789ab'), '0.5.0-0123456789ab');
  assert.throws(() => validateRuntimeName('../other'), /runtime name is invalid/);
  assert.throws(() => validateRuntimeName('versions/other'), /runtime name is invalid/);
});
