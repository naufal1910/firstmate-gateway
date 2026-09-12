import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateConfig } from '../config.js';
import { GatewayError } from '../errors.js';
import { Gateway } from '../gateway.js';
import { HerdrSessionLocator } from '../herdr/session.js';
import { HerdrSocketClient, type HerdrRequest } from '../herdr/protocol.js';

const config = validateConfig({
  version: 1,
  targets: {
    firstmate2: {
      herdr_session: 'firstmate-b',
      firstmate_home: '/home/agent/workspace/firstmate2',
      agent: 'pi',
    },
  },
});

const runtimeAgent = {
  terminal_id: 'term-1',
  agent: 'pi',
  agent_status: 'blocked',
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  pane_id: 'w1:p1',
  focused: true,
  revision: 1,
  cwd: '/home/agent/workspace/firstmate2',
  foreground_cwd: '/home/agent/workspace/firstmate2',
};

function fakeGateway(agents: readonly Record<string, unknown>[]): Gateway {
  const locator = new HerdrSessionLocator({
    run: async () => ({
      stdout: JSON.stringify({
        sessions: [{ name: 'firstmate-b', running: true, socket_path: '/tmp/herdr.sock' }],
      }),
      stderr: '',
    }),
    validateSocket: async () => undefined,
  });
  const createClient = () => new HerdrSocketClient({
    exchange: async (request: HerdrRequest) => {
      if (request.method === 'ping') {
        return { id: request.id, result: { type: 'pong', version: '0.8.2', protocol: 20 } };
      }
      if (request.method === 'agent.list') {
        return { id: request.id, result: { type: 'agent_list', agents } };
      }
      return { id: request.id, error: { code: 'agent_not_found', message: 'compatibility probe target' } };
    },
  });
  return new Gateway({ config, sessionLocator: locator, createClient });
}

test('lists safe configured metadata without contacting Herdr', async () => {
  const gateway = new Gateway({ config });
  assert.deepEqual(await gateway.listTargets(), [{ target: 'firstmate2', herdrSession: 'firstmate-b', agent: 'pi' }]);
});

test('resolves status dynamically and normalizes runtime state', async () => {
  const gateway = fakeGateway([runtimeAgent]);
  assert.deepEqual(await gateway.getStatus('firstmate2'), {
    target: 'firstmate2',
    state: 'blocked',
    resolved: true,
    evidence: { cwdSource: 'foreground_cwd', weakerCwdEvidence: false },
  });
});

test('doctor reports protocol and target checks without exposing pane identity', async () => {
  const gateway = fakeGateway([runtimeAgent]);
  const report = await gateway.doctor();
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => [check.name, check.ok]), [
    ['configuration', true],
    ['executable', true],
    ['session', true],
    ['socket', true],
    ['protocol', true],
    ['target', true],
  ]);
  assert.equal(JSON.stringify(report).includes('w1:p1'), false);
});

test('doctor preserves distinct ambiguous target failure', async () => {
  const gateway = fakeGateway([runtimeAgent, { ...runtimeAgent, pane_id: 'w1:p2' }]);
  const report = await gateway.doctor();
  assert.equal(report.ok, false);
  const targetCheck = report.checks.find((check) => check.name === 'target');
  assert.equal(targetCheck?.code, 'TARGET_AMBIGUOUS');
});

test('rejects unknown configured aliases', async () => {
  const gateway = new Gateway({ config });
  await assert.rejects(gateway.getStatus('missing'), (error: unknown) =>
    error instanceof GatewayError && error.code === 'TARGET_NOT_CONFIGURED',
  );
});
