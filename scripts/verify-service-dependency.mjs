#!/usr/bin/env node
/* global console, process, setTimeout */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const suffix = `${process.pid}-${Date.now()}`;
const gatewayUnit = `firstmate-gateway-isolated-${suffix}`;
const tunnelUnit = `firstmate-gateway-tunnel-isolated-${suffix}`;
const gatewayService = `${gatewayUnit}.service`;
const tunnelService = `${tunnelUnit}.service`;

async function run(command, args) {
  return execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 });
}

async function active(unit) {
  try {
    await run('systemctl', ['--user', 'is-active', '--quiet', unit]);
    return true;
  } catch {
    return false;
  }
}

async function stop(unit) {
  await run('systemctl', ['--user', 'stop', unit]).catch(() => undefined);
  await run('systemctl', ['--user', 'reset-failed', unit]).catch(() => undefined);
}

async function waitForActive(unit, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await active(unit)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let started = false;
try {
  await run('systemd-run', [
    '--user', '--unit', gatewayUnit, '--collect', '--service-type=simple',
    '--property=Restart=on-failure', '--property=RestartSec=1s',
    '--property=StartLimitIntervalSec=30s', '--property=StartLimitBurst=3',
    '/bin/sleep', 'infinity',
  ]);
  started = true;
  await run('systemd-run', [
    '--user', '--unit', tunnelUnit, '--collect', '--service-type=simple',
    `--property=Wants=${gatewayService}`, `--property=After=${gatewayService}`,
    '/bin/sleep', 'infinity',
  ]);
  if (!await waitForActive(gatewayService, 5_000) || !await waitForActive(tunnelService, 5_000)) {
    throw new Error('isolated services did not become active');
  }

  await run('systemctl', ['--user', 'kill', '--kill-who=main', '--signal=KILL', gatewayService]);
  if (!await waitForActive(gatewayService, 8_000) || !await active(tunnelService)) {
    throw new Error('tunnel did not remain active while Gateway recovered');
  }
  console.log(JSON.stringify({
    isolated: true,
    gateway: 'restarted',
    tunnel: 'remained-active',
    relationship: 'Wants+After',
    sideEffect: 'temporary-user-units-only',
  }));
} finally {
  if (started) await stop(tunnelService);
  if (started) await stop(gatewayService);
}
