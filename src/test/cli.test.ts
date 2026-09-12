import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const cliPath = join(process.cwd(), 'dist', 'cli.js');

function withConfig(source: string, callback: (configPath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'firstmate-gateway-cli-'));
  const configPath = join(directory, 'local.yaml');
  writeFileSync(configPath, source, 'utf8');
  try {
    callback(configPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runCli(configPath: string, ...args: string[]): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FIRSTMATE_GATEWAY_CONFIG: configPath },
  });
}

const validConfig = `version: 1
targets:
  firstmate2:
    herdr_session: firstmate-b
    firstmate_home: /home/agent/workspace/firstmate2
    agent: pi
`;

test('targets JSON output is stable and omits absolute paths and pane IDs', () => {
  withConfig(validConfig, (configPath) => {
    const output = runCli(configPath, 'targets', '--json');
    assert.equal(output, '{"targets":[{"target":"firstmate2","herdrSession":"firstmate-b","agent":"pi"}]}\n');
    assert.equal(output.includes('/home/agent/workspace/firstmate2'), false);
    assert.equal(output.includes('pane'), false);
  });
});

test('status JSON errors use the stable machine-readable envelope', () => {
  withConfig(validConfig, (configPath) => {
    const result = spawnSync(process.execPath, [cliPath, 'status', 'missing', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, FIRSTMATE_GATEWAY_CONFIG: configPath },
    });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout as string) as {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly requestId: string;
        readonly details?: unknown;
      };
    };
    assert.equal(payload.error.code, 'TARGET_NOT_CONFIGURED');
    assert.equal(payload.error.message, 'target alias is not configured');
    assert.match(payload.error.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(payload.error).sort(), ['code', 'message', 'requestId']);
  });
});

test('invalid JSON CLI arguments use the same error envelope', () => {
  const result = spawnSync(process.execPath, [cliPath, 'status', '--json'], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout as string) as {
    readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
  };
  assert.equal(payload.error.code, 'INVALID_ARGUMENT');
  assert.equal(payload.error.message, 'status requires a target alias');
  assert.match(payload.error.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
