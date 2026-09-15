import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = process.cwd();

async function text(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

test('committed service templates are generic and preserve the security boundary', async () => {
  const gateway = await text('deploy/systemd/firstmate-gateway-remote.service');
  const tunnel = await text('deploy/systemd/firstmate-gateway-tunnel.service');
  assert.match(gateway, /PATH=%h\/\.local\/share\/firstmate-gateway\/node\/current\/bin:/);
  assert.match(gateway, /active\/node_modules\/\.bin\/firstmate-gateway-remote/);
  assert.match(gateway, /Restart=on-failure/);
  assert.match(gateway, /ProtectHome=read-only/);
  assert.match(tunnel, /Wants=firstmate-gateway-remote\.service/);
  assert.match(tunnel, /After=firstmate-gateway-remote\.service network-online\.target/);
  assert.doesNotMatch(tunnel, /Requires=firstmate-gateway-remote\.service/);
  assert.match(tunnel, /tunnel-client run --profile-dir/);
  assert.match(tunnel, /Restart=on-failure/);
  assert.doesNotMatch(`${gateway}\n${tunnel}`, /Bearer|api[_-]?key|client[_-]?secret|tunnel_[0-9a-f]{32}/i);
  assert.doesNotMatch(`${gateway}\n${tunnel}`, /\/home\/[^%\s]+/);
});

test('operator guide documents safe deployment, recovery, and read-only health', async () => {
  const guide = await text('docs/operator-guide.md');
  for (const phrase of [
    'Stable supervised deployment',
    'Install a verified local artifact',
    'Enable, start, status, logs, stop, and restart',
    'Upgrade and rollback',
    'Uninstall',
    'Read-only health and failure localization',
    'Controlled idle recovery validation',
    'loginctl enable-linger',
    'does not invoke an MCP tool and cannot\nreplay `firstmate_send`',
  ]) {
    assert.equal(guide.includes(phrase), true, `missing guide section: ${phrase}`);
  }
  assert.doesNotMatch(guide, /firstmate-gateway\.jp\.auth0\.com/);
});

test('final service templates pass isolated user-unit verification without starting a service', async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'firstmate-gateway-systemd-test-'));
  try {
    const gateway = await text('deploy/systemd/firstmate-gateway-remote.service');
    const tunnel = await text('deploy/systemd/firstmate-gateway-tunnel.service');
    const gatewayPath = join(isolated, 'firstmate-gateway-remote.service');
    const tunnelPath = join(isolated, 'firstmate-gateway-tunnel.service');
    await writeFile(gatewayPath, gateway.replace(/^ExecStart=.*$/m, 'ExecStart=/bin/true'));
    await writeFile(tunnelPath, tunnel.replace(/^ExecStart=.*$/m, 'ExecStart=/bin/true'));
    const result = spawnSync('systemd-analyze', ['--user', 'verify', gatewayPath, tunnelPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});
