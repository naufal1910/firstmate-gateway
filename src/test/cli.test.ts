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
    assert.deepEqual(JSON.parse(result.stdout as string), {
      error: { code: 'TARGET_NOT_CONFIGURED', message: 'target alias is not configured' },
    });
  });
});
