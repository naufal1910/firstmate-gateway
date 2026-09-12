import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GatewayError } from '../errors.js';
import {
  HerdrSessionLocator,
  parseSessionList,
  type HerdrCommandResult,
} from '../herdr/session.js';

const runningSession = {
  name: 'firstmate-b',
  running: true,
  session_dir: '/tmp/herdr/firstmate-b',
  socket_path: '/tmp/herdr/firstmate-b/herdr.sock',
};

function commandResult(stdout: string): Promise<HerdrCommandResult> {
  return Promise.resolve({ stdout, stderr: '' });
}

test('discovers a running named session and validates its socket', async () => {
  const calls: Array<{ executable: string; args: readonly string[]; shell: false }> = [];
  const locator = new HerdrSessionLocator({
    executable: 'herdr-test',
    run: async (executable, args, options) => {
      calls.push({ executable, args, shell: options.shell });
      return commandResult(JSON.stringify({ sessions: [runningSession] }));
    },
    validateSocket: async (socketPath) => {
      assert.equal(socketPath, runningSession.socket_path);
    },
  });

  const endpoint = await locator.locate('firstmate-b');
  assert.deepEqual(endpoint, {
    name: 'firstmate-b',
    running: true,
    socketPath: '/tmp/herdr/firstmate-b/herdr.sock',
  });
  assert.deepEqual(calls, [{ executable: 'herdr-test', args: ['session', 'list', '--json'], shell: false }]);
});

test('distinguishes missing and stopped sessions', async () => {
  const locator = new HerdrSessionLocator({
    run: async () => commandResult(JSON.stringify({ sessions: [{ ...runningSession, running: false }] })),
    validateSocket: async () => assert.fail('stopped session must not validate a socket'),
  });

  await assert.rejects(locator.locate('other'), (error: unknown) =>
    error instanceof GatewayError && error.code === 'HERDR_SESSION_NOT_FOUND',
  );
  await assert.rejects(locator.locate('firstmate-b'), (error: unknown) =>
    error instanceof GatewayError && error.code === 'HERDR_SESSION_NOT_RUNNING',
  );
});

test('reports unavailable Herdr executable', async () => {
  const locator = new HerdrSessionLocator({
    run: async () => {
      const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
      throw error;
    },
  });

  await assert.rejects(locator.discover(), (error: unknown) =>
    error instanceof GatewayError && error.code === 'HERDR_NOT_FOUND',
  );
});

test('rejects malformed session discovery', () => {
  assert.throws(
    () => parseSessionList('{"sessions":[{"name":"firstmate-b","running":"yes"}]}'),
    (error: unknown) => error instanceof GatewayError && error.code === 'HERDR_INCOMPATIBLE',
  );
  assert.throws(
    () => parseSessionList('{"sessions":[{"name":"firstmate-b","running":true,"socket_path":"relative.sock"}]}'),
    (error: unknown) => error instanceof GatewayError && error.code === 'HERDR_INCOMPATIBLE',
  );
});

test('rejects a running session without a discovered socket', async () => {
  const locator = new HerdrSessionLocator({
    run: async () => commandResult(JSON.stringify({ sessions: [{ name: 'firstmate-b', running: true }] })),
  });

  await assert.rejects(locator.locate('firstmate-b'), (error: unknown) =>
    error instanceof GatewayError && error.code === 'HERDR_INCOMPATIBLE',
  );
});
