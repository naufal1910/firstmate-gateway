import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises';
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

test('artifact digest is checked before any package installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'firstmate-gateway-artifact-test-'));
  const artifact = join(root, 'gateway.tgz');
  try {
    await writeFile(artifact, 'not-a-packed-artifact');
    await assert.rejects(
      installPackedArtifact({ artifact, sha256: '0'.repeat(64), root: join(root, 'runtime') }),
      (error: unknown) => error instanceof DeploymentError && error.message.includes('sha256 does not match'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime names reject traversal and symlink-shaped values', () => {
  assert.equal(validateRuntimeName('0.5.0-0123456789ab'), '0.5.0-0123456789ab');
  assert.throws(() => validateRuntimeName('../other'), /runtime name is invalid/);
  assert.throws(() => validateRuntimeName('versions/other'), /runtime name is invalid/);
});
