import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GatewayError } from '../errors.js';
import { resolveTarget } from '../target.js';
import type { TargetConfig } from '../config.js';
import type { HerdrAgent } from '../herdr/protocol.js';

const target: TargetConfig = {
  alias: 'firstmate2',
  herdrSession: 'firstmate-b',
  firstmateHome: '/home/agent/workspace/firstmate2',
  agent: 'pi',
};

function agent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    terminalId: 'term-1',
    agentStatus: 'idle',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    paneId: 'w1:p1',
    focused: false,
    revision: 1,
    agent: 'pi',
    cwd: '/home/agent/workspace/firstmate2',
    foregroundCwd: '/home/agent/workspace/firstmate2',
    ...overrides,
  };
}

test('resolves exactly one target using foreground cwd and canonical paths', () => {
  const resolved = resolveTarget(
    { ...target, firstmateHome: '/home/agent/workspace/firstmate2/.' },
    [agent({ foregroundCwd: '/home/agent/workspace/firstmate2/../firstmate2' })],
  );

  assert.equal(resolved.paneId, 'w1:p1');
  assert.equal(resolved.canonicalCwd, '/home/agent/workspace/firstmate2');
  assert.deepEqual(resolved.evidence, { cwdSource: 'foreground_cwd', weakerCwdEvidence: false });
});

test('falls back to cwd only when foreground cwd is absent', () => {
  const fallbackAgent = agent();
  delete (fallbackAgent as { foregroundCwd?: string }).foregroundCwd;
  Object.assign(fallbackAgent, { cwd: '/home/agent/workspace/firstmate2/.' });
  const resolved = resolveTarget(target, [fallbackAgent]);
  assert.equal(resolved.evidence.cwdSource, 'cwd');
  assert.equal(resolved.evidence.weakerCwdEvidence, true);
});

test('does not use cwd when foreground cwd is present but does not match', () => {
  assert.throws(
    () => resolveTarget(target, [agent({ foregroundCwd: '/tmp/other', cwd: '/home/agent/workspace/firstmate2' })]),
    (error: unknown) => error instanceof GatewayError && error.code === 'TARGET_NOT_FOUND',
  );
});

test('fails closed for zero matches including agent mismatch', () => {
  assert.throws(
    () => resolveTarget(target, [agent({ agent: 'codex' })]),
    (error: unknown) =>
      error instanceof GatewayError && error.code === 'TARGET_NOT_FOUND' && error.details?.agentKindMatches === 0,
  );
  assert.throws(
    () => resolveTarget(target, []),
    (error: unknown) => error instanceof GatewayError && error.code === 'TARGET_NOT_FOUND',
  );
});

test('fails closed for multiple matches without using focus or title-like details', () => {
  assert.throws(
    () => resolveTarget(target, [agent({ paneId: 'w1:p1', focused: true }), agent({ paneId: 'w1:p2', focused: false })]),
    (error: unknown) => error instanceof GatewayError && error.code === 'TARGET_AMBIGUOUS',
  );
});

test('normalizes unknown status while retaining safe raw status detail', () => {
  const resolved = resolveTarget(target, [agent({ agentStatus: 'unknown', rawAgentStatus: 'paused_by_policy' })]);
  assert.equal(resolved.state, 'unknown');
  assert.equal(resolved.rawState, 'paused_by_policy');
});
