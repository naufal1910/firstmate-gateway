#!/usr/bin/env node
/* global console, process */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'firstmate-gateway-package-'));

try {
  execFileSync('npm', [
    'pack',
    '--ignore-scripts',
    '--pack-destination',
    temporaryDirectory,
  ], { cwd: root, stdio: 'pipe' });

  const archives = readdirSync(temporaryDirectory).filter((entry) => entry.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'npm pack must create exactly one archive');
  const archive = join(temporaryDirectory, archives[0]);
  const consumer = join(temporaryDirectory, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'firstmate-gateway-package-check', private: true }), 'utf8');

  execFileSync('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    archive,
  ], { cwd: consumer, stdio: 'inherit' });

  const installedRoot = join(consumer, 'node_modules', packageJson.name);
  const installedCli = join(installedRoot, 'dist', 'cli.js');
  const installedBin = join(consumer, 'node_modules', '.bin', 'firstmate-gateway');
  const installedMcpBin = join(consumer, 'node_modules', '.bin', 'firstmate-gateway-mcp');
  const installedRemoteBin = join(consumer, 'node_modules', '.bin', 'firstmate-gateway-remote');
  const installedInstallerBin = join(consumer, 'node_modules', '.bin', 'firstmate-gateway-install');
  assert.equal(existsSync(installedCli), true, 'packed package must contain the CLI');
  assert.equal(existsSync(installedBin), true, 'clean install must link the CLI bin');
  assert.equal(existsSync(installedMcpBin), true, 'clean install must link the MCP bin');
  assert.equal(existsSync(installedRemoteBin), true, 'clean install must link the Auth0 remote bin');
  assert.equal(existsSync(installedInstallerBin), true, 'clean install must link the deployment installer bin');
  assert.equal(existsSync(join(installedRoot, 'config', 'example.yaml')), true, 'packed package must contain config/example.yaml');
  assert.equal(existsSync(join(installedRoot, 'docs', 'operator-guide.md')), true, 'packed package must contain the operator guide');
  assert.equal(existsSync(join(installedRoot, 'deploy', 'systemd', 'firstmate-gateway-remote.service')), true, 'packed package must contain the Gateway service template');
  assert.equal(existsSync(join(installedRoot, 'deploy', 'systemd', 'firstmate-gateway-tunnel.service')), true, 'packed package must contain the tunnel service template');
  assert.equal(existsSync(join(installedRoot, 'config', 'local.yaml')), false, 'packed package must not contain local configuration');
  assert.equal(existsSync(join(installedRoot, '.env')), false, 'packed package must not contain environment files');
  assert.equal(existsSync(join(installedRoot, 'src')), false, 'packed package must not contain TypeScript sources');
  assert.equal(existsSync(join(installedRoot, 'dist', 'test')), false, 'packed package must not contain compiled tests');

  const version = execFileSync(installedBin, ['--version'], {
    encoding: 'utf8',
    cwd: consumer,
  }).trim();
  assert.equal(version, packageJson.version, 'installed CLI version must match package metadata');
  const remoteHelp = execFileSync(installedRemoteBin, ['--help'], {
    encoding: 'utf8',
    cwd: consumer,
  });
  assert.match(remoteHelp, /firstmate-gateway-remote/);
  const missingRemoteConfig = spawnSync(installedRemoteBin, [], {
    encoding: 'utf8',
    cwd: consumer,
    env: { ...process.env, FIRSTMATE_GATEWAY_CONFIG: join(consumer, 'missing.yaml') },
  });
  assert.equal(missingRemoteConfig.status, 1, 'remote runner must fail closed without configuration');
  assert.match(missingRemoteConfig.stderr, /^CONFIG_NOT_FOUND:/);

  const runtimeRoot = join(consumer, 'runtime');
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const deployment = spawnSync(installedInstallerBin, [
    '--artifact', archive,
    '--sha256', digest,
    '--root', runtimeRoot,
    '--json',
  ], { encoding: 'utf8', cwd: consumer });
  assert.equal(deployment.status, 0, deployment.stderr);
  const deploymentResult = JSON.parse(deployment.stdout);
  assert.equal(deploymentResult.packageName, packageJson.name);
  assert.equal(readlinkSync(join(runtimeRoot, 'active')), `versions/${deploymentResult.runtimeName}`);
  assert.equal(existsSync(join(runtimeRoot, 'active', 'node_modules', '.bin', 'firstmate-gateway-remote')), true);
  assert.equal(statSync(join(runtimeRoot, 'versions', deploymentResult.runtimeName)).mode & 0o222, 0, 'installed runtime must be immutable');
  // Installed versions are read-only by design; make the temporary fixture removable.
  execFileSync('chmod', ['-R', 'u+w', runtimeRoot]);

  const configPath = join(consumer, 'local.yaml');
  const initOutput = execFileSync(installedBin, ['init', '--path', configPath, '--json'], {
    encoding: 'utf8',
    cwd: consumer,
    env: { ...process.env, FIRSTMATE_GATEWAY_CONFIG: configPath },
  });
  assert.deepEqual(JSON.parse(initOutput), { path: configPath, created: true });

  const targetsOutput = execFileSync(installedBin, ['targets', '--json'], {
    encoding: 'utf8',
    cwd: consumer,
    env: { ...process.env, FIRSTMATE_GATEWAY_CONFIG: configPath },
  });
  const targets = JSON.parse(targetsOutput);
  assert.deepEqual(targets, {
    targets: [{ target: 'firstmate', herdrSession: 'replace-with-local-session', agent: 'pi' }],
  });

  const doctor = spawnSync(process.execPath, [installedCli, 'doctor', '--json'], {
    encoding: 'utf8',
    cwd: consumer,
    env: { ...process.env, FIRSTMATE_GATEWAY_CONFIG: configPath, PATH: temporaryDirectory },
  });
  assert.equal(doctor.status, 1, 'doctor should report unavailable Herdr without crashing');
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].name, 'configuration');
  assert.equal(report.checks[0].ok, true);

  console.log(`package check passed for ${packageJson.name}@${packageJson.version}`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
