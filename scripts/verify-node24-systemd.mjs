#!/usr/bin/env node
/* global console, process */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 24) {
  throw new Error(`Node 24 or newer is required; resolved ${process.version}`);
}

const proofRoot = mkdtempSync(join(root, '.node24-systemd-proof-'));

function makeRemovable(path) {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) makeRemovable(entryPath);
    else if (!entry.isSymbolicLink()) chmodSync(entryPath, 0o600);
  }
}

try {
  const archiveDirectory = join(proofRoot, 'artifact');
  const runtimeRoot = join(proofRoot, 'runtime');
  execFileSync('mkdir', ['-p', archiveDirectory]);
  execFileSync('npm', [
    'pack', '--ignore-scripts', '--pack-destination', archiveDirectory,
  ], { cwd: root, stdio: 'ignore' });
  const archiveName = execFileSync('find', [archiveDirectory, '-maxdepth', '1', '-type', 'f', '-name', '*.tgz', '-printf', '%f\n'], {
    encoding: 'utf8',
  }).trim();
  if (archiveName.length === 0 || archiveName.includes('\n')) throw new Error('npm pack did not produce one artifact');
  const archive = join(archiveDirectory, archiveName);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const { installPackedArtifact } = await import('../dist/deployment.js');
  const installed = await installPackedArtifact({ artifact: archive, sha256: digest, root: runtimeRoot });
  const remoteBin = join(installed.activePointer, 'node_modules', '.bin', 'firstmate-gateway-remote');
  if (!existsSync(remoteBin)) throw new Error('immutable active remote entry point is missing');
  const remoteMode = statSync(remoteBin).mode & 0o777;

  const gatewayUnit = join(proofRoot, 'gateway.service');
  const tunnelUnit = join(proofRoot, 'tunnel.service');
  const gatewaySource = readFileSync(join(root, 'deploy/systemd/firstmate-gateway-remote.service'), 'utf8');
  const tunnelSource = readFileSync(join(root, 'deploy/systemd/firstmate-gateway-tunnel.service'), 'utf8');
  writeFileSync(gatewayUnit, gatewaySource.replace(/^ExecStart=.*$/m, 'ExecStart=/bin/true'));
  writeFileSync(tunnelUnit, tunnelSource.replace(/^ExecStart=.*$/m, 'ExecStart=/bin/true'));
  execFileSync('systemd-analyze', ['--user', 'verify', gatewayUnit, tunnelUnit], { stdio: 'ignore' });

  const environmentCheck = [
    "import { execFileSync } from 'node:child_process';",
    'const remote = process.argv.at(-2);',
    "if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('systemd selected an old Node runtime');",
    "const remoteVersion = execFileSync(remote, ['--version'], { encoding: 'utf8' }).trim();",
    "if (remoteVersion !== process.argv[2]) throw new Error(`unexpected remote version ${remoteVersion}`);",
    "console.log(JSON.stringify({ node: process.version, remoteVersion }));",
  ].join('\n');
  const nodeBin = dirname(process.execPath);
  const systemdEnvironment = execFileSync('systemd-run', [
    '--user', '--wait', '--pipe', '--collect',
    '--unit', `firstmate-gateway-node24-proof-${process.pid}`,
    '--setenv', `PATH=${nodeBin}:/usr/local/bin:/usr/bin:/bin`,
    process.execPath, '--input-type=module', '--eval', environmentCheck, remoteBin, installed.version,
  ], { encoding: 'utf8' }).trim();

  const dependencyEvidence = execFileSync(process.execPath, [join(root, 'scripts/verify-service-dependency.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${nodeBin}:${process.env.PATH ?? ''}` },
  }).trim();
  console.log(JSON.stringify({
    isolated: true,
    node: process.version,
    immutableRemoteMode: `0${remoteMode.toString(8)}`,
    immutableRemoteVersion: installed.version,
    systemdEnvironment: JSON.parse(systemdEnvironment),
    finalUnitVerification: 'passed',
    dependency: JSON.parse(dependencyEvidence),
  }));
} finally {
  makeRemovable(proofRoot);
  rmSync(proofRoot, { recursive: true, force: true });
}
