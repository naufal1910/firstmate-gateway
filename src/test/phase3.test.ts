import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateConfig } from '../config.js';
import {
  DEFAULT_READ_LINES,
  DEFAULT_READ_SOURCE,
  Gateway,
  MAX_PROMPT_BYTES,
  MAX_READ_LINES,
} from '../gateway.js';
import { GatewayError } from '../errors.js';
import { HerdrSessionLocator } from '../herdr/session.js';
import {
  HerdrSocketClient,
  HerdrTransportError,
  type HerdrRequest,
} from '../herdr/protocol.js';
import type { SemanticReaderProvider } from '../semantic.js';

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

const baseAgent = {
  terminal_id: 'term-1',
  agent: 'pi',
  agent_status: 'idle',
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  pane_id: 'w1:p1',
  focused: true,
  revision: 1,
  cwd: '/home/agent/workspace/firstmate2',
  foreground_cwd: '/home/agent/workspace/firstmate2',
};

interface FakeGatewayOptions {
  readonly agentLists?: readonly (readonly Record<string, unknown>[])[];
  readonly promptAgent?: Record<string, unknown>;
  readonly promptError?: Error;
  readonly promptProtocolError?: { readonly code: string; readonly message: string };
  readonly read?: Record<string, unknown>;
  readonly readError?: Error;
  readonly readProtocolError?: { readonly code: string; readonly message: string };
}

function fakeGateway(options: FakeGatewayOptions = {}): {
  readonly gateway: Gateway;
  readonly requests: HerdrRequest[];
} {
  const requests: HerdrRequest[] = [];
  let listIndex = 0;
  const agentLists = options.agentLists ?? [[baseAgent]];
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
      requests.push(request);
      if (request.method === 'ping') {
        return { id: request.id, result: { type: 'pong', version: '0.8.2', protocol: 20 } };
      }
      if (request.method === 'agent.list') {
        const agents = agentLists[Math.min(listIndex, agentLists.length - 1)] ?? [];
        listIndex += 1;
        return { id: request.id, result: { type: 'agent_list', agents } };
      }
      if (request.method === 'agent.prompt') {
        if (options.promptError !== undefined) throw options.promptError;
        if (options.promptProtocolError !== undefined) {
          return { id: request.id, error: options.promptProtocolError };
        }
        return {
          id: request.id,
          result: {
            type: 'agent_prompted',
            agent: options.promptAgent ?? { ...baseAgent, agent_status: 'working' },
          },
        };
      }
      if (options.readError !== undefined) throw options.readError;
      if (options.readProtocolError !== undefined) {
        return { id: request.id, error: options.readProtocolError };
      }
      return {
        id: request.id,
        result: {
          type: 'pane_read',
          read: options.read ?? {
            pane_id: 'w1:p1',
            workspace_id: 'w1',
            tab_id: 'w1:t1',
            source: 'recent_unwrapped',
            format: 'text',
            text: 'line one\nline two — 日本語 🚀',
            revision: 2,
            truncated: false,
          },
        },
      };
    },
  });
  return { gateway: new Gateway({ config, sessionLocator: locator, createClient }), requests };
}

function requestsFor(requests: readonly HerdrRequest[], method: HerdrRequest['method']): HerdrRequest[] {
  return requests.filter((request) => request.method === method);
}

async function assertGatewayCode(promise: Promise<unknown>, code: string, requestId: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.code, code);
    assert.equal(error.requestId, requestId);
    return true;
  });
}

test('send resolves dynamically, uses structured agent.prompt, and preserves literal prompt data', async () => {
  const { gateway, requests } = fakeGateway();
  const message = `quotes: ' " ; $() &&\nUnicode: 日本語 🚀\nline two`;
  const result = await gateway.sendPrompt({ target: 'firstmate2', message }, { requestId: 'send-literal-1' });

  assert.deepEqual(result, {
    target: 'firstmate2',
    accepted: true,
    requestId: 'send-literal-1',
    observedState: 'working',
  });
  const prompt = requestsFor(requests, 'agent.prompt')[0];
  assert.ok(prompt);
  assert.equal(prompt.params.target, 'w1:p1');
  assert.equal(prompt.params.text, message);
  assert.equal(JSON.stringify(result).includes('w1:p1'), false);
  assert.equal(JSON.stringify(result).includes(message), false);
});

test('send fails closed for zero or multiple matches before agent.prompt', async () => {
  const zero = fakeGateway({ agentLists: [[]] });
  await assertGatewayCode(zero.gateway.sendPrompt({ target: 'firstmate2', message: 'safe' }, { requestId: 'send-zero' }), 'TARGET_NOT_FOUND', 'send-zero');
  assert.equal(requestsFor(zero.requests, 'agent.prompt').length, 0);

  const multiple = fakeGateway({ agentLists: [[baseAgent, { ...baseAgent, pane_id: 'w1:p2' }]] });
  await assertGatewayCode(multiple.gateway.sendPrompt({ target: 'firstmate2', message: 'safe' }, { requestId: 'send-many' }), 'TARGET_AMBIGUOUS', 'send-many');
  assert.equal(requestsFor(multiple.requests, 'agent.prompt').length, 0);
});

test('send blocks a dynamically resolved blocked target before delivery', async () => {
  const { gateway, requests } = fakeGateway({ agentLists: [[{ ...baseAgent, agent_status: 'blocked' }]] });
  await assertGatewayCode(gateway.sendPrompt({ target: 'firstmate2', message: 'safe' }, { requestId: 'send-blocked' }), 'TARGET_BLOCKED', 'send-blocked');
  assert.equal(requestsFor(requests, 'agent.prompt').length, 0);
});

test('send maps confirmed failures and does not retry uncertain delivery', async () => {
  const failed = fakeGateway({ promptProtocolError: { code: 'delivery_failed', message: 'rejected' } });
  await assertGatewayCode(failed.gateway.sendPrompt({ target: 'firstmate2', message: 'safe' }, { requestId: 'send-failed' }), 'PROMPT_DELIVERY_FAILED', 'send-failed');
  assert.equal(requestsFor(failed.requests, 'agent.prompt').length, 1);

  const uncertain = fakeGateway({ promptError: new HerdrTransportError('socket timeout') });
  await assertGatewayCode(uncertain.gateway.sendPrompt({ target: 'firstmate2', message: 'safe' }, { requestId: 'send-uncertain' }), 'PROMPT_DELIVERY_UNCERTAIN', 'send-uncertain');
  assert.equal(requestsFor(uncertain.requests, 'agent.prompt').length, 1);
});

test('send rejects empty and oversized prompts before Herdr I/O', async () => {
  const empty = fakeGateway();
  await assertGatewayCode(empty.gateway.sendPrompt({ target: 'firstmate2', message: '' }, { requestId: 'send-empty' }), 'INVALID_ARGUMENT', 'send-empty');
  assert.equal(empty.requests.length, 0);

  const oversized = fakeGateway();
  const message = 'x'.repeat(MAX_PROMPT_BYTES + 1);
  await assertGatewayCode(oversized.gateway.sendPrompt({ target: 'firstmate2', message }, { requestId: 'send-large' }), 'PROMPT_TOO_LARGE', 'send-large');
  assert.equal(oversized.requests.length, 0);
});

test('raw read uses the bounded defaults, maps the wire source, and keeps content out of metadata', async () => {
  const { gateway, requests } = fakeGateway();
  const result = await gateway.read({ target: 'firstmate2' }, { requestId: 'read-default' });

  assert.deepEqual(result, {
    target: 'firstmate2',
    mode: 'raw',
    requestId: 'read-default',
    source: DEFAULT_READ_SOURCE,
    format: 'text',
    text: 'line one\nline two — 日本語 🚀',
    revision: 2,
    truncated: false,
  });
  const read = requestsFor(requests, 'agent.read')[0];
  assert.ok(read);
  assert.equal(read.params.target, 'w1:p1');
  assert.equal(read.params.source, 'recent_unwrapped');
  assert.equal(read.params.lines, DEFAULT_READ_LINES);
  assert.equal(JSON.stringify(result).includes('pane_id'), false);
  assert.equal(JSON.stringify(result).includes('w1:p1'), false);
});

test('raw read accepts explicit valid source/count and dynamically re-resolves', async () => {
  const { gateway, requests } = fakeGateway({
    agentLists: [
      [baseAgent],
      [{ ...baseAgent, pane_id: 'w1:p2' }],
    ],
    read: {
      pane_id: 'w1:p2',
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      source: 'visible',
      format: 'ansi',
      text: '\u001b[32mvisible\u001b[0m\n第二行',
      revision: 9,
      truncated: true,
    },
  });
  await gateway.sendPrompt({ target: 'firstmate2', message: 'prime the dynamic resolution test' }, { requestId: 'send-before-read' });
  const result = await gateway.read({ target: 'firstmate2', source: 'visible', count: 7 }, { requestId: 'read-explicit' });
  assert.equal(result.mode, 'raw');
  assert.equal(result.source, 'visible');
  assert.equal(result.text, '\u001b[32mvisible\u001b[0m\n第二行');
  const read = requestsFor(requests, 'agent.read')[0];
  assert.ok(read);
  assert.equal(read.params.target, 'w1:p2');
  assert.equal(read.params.source, 'visible');
  assert.equal(read.params.lines, 7);
  assert.equal(requestsFor(requests, 'agent.list').length, 2);
});

test('invalid raw read source/count is rejected before target resolution', async () => {
  const invalidSource = fakeGateway();
  await assertGatewayCode(
    invalidSource.gateway.read({ target: 'firstmate2', source: 'recent_unwrapped' as never }, { requestId: 'read-source-invalid' }),
    'INVALID_ARGUMENT',
    'read-source-invalid',
  );
  assert.equal(invalidSource.requests.length, 0);

  const invalidCount = fakeGateway();
  await assertGatewayCode(
    invalidCount.gateway.read({ target: 'firstmate2', count: MAX_READ_LINES + 1 }, { requestId: 'read-count-invalid' }),
    'INVALID_ARGUMENT',
    'read-count-invalid',
  );
  assert.equal(invalidCount.requests.length, 0);
});

test('raw read surfaces failures and rejects source substitution without fallback', async () => {
  const failed = fakeGateway({ readProtocolError: { code: 'source_unavailable', message: 'not available' } });
  await assertGatewayCode(failed.gateway.read({ target: 'firstmate2' }, { requestId: 'read-failed' }), 'READ_FAILED', 'read-failed');
  assert.equal(requestsFor(failed.requests, 'agent.read').length, 1);

  const substituted = fakeGateway({ read: {
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    tab_id: 'w1:t1',
    source: 'recent',
    format: 'text',
    text: 'wrong source',
    revision: 3,
    truncated: false,
  } });
  await assertGatewayCode(substituted.gateway.read({ target: 'firstmate2' }, { requestId: 'read-substituted' }), 'READ_FAILED', 'read-substituted');
  assert.equal(requestsFor(substituted.requests, 'agent.read').length, 1);
});

test('semantic reads select a provider separately and never fall back to raw output', async () => {
  const unsupported = fakeGateway();
  await assertGatewayCode(unsupported.gateway.read({ target: 'firstmate2', mode: 'semantic' }, { requestId: 'semantic-none' }), 'SEMANTIC_OUTPUT_UNAVAILABLE', 'semantic-none');
  assert.equal(unsupported.requests.length, 0);

  let selectedContextPane: string | undefined;
  const first: SemanticReaderProvider = {
    name: 'not-for-pi',
    supports: () => false,
    read: async () => ({ text: 'must not be called' }),
  };
  const second: SemanticReaderProvider = {
    name: 'validated-test-provider',
    supports: (target) => target.agent === 'pi',
    read: async (input) => {
      selectedContextPane = input.resolvedTarget.paneId;
      return { text: 'structured semantic response' };
    },
  };
  const withProvider = new Gateway({
    config,
    sessionLocator: new HerdrSessionLocator({
      run: async () => ({
        stdout: JSON.stringify({ sessions: [{ name: 'firstmate-b', running: true, socket_path: '/tmp/herdr.sock' }] }),
        stderr: '',
      }),
      validateSocket: async () => undefined,
    }),
    createClient: () => new HerdrSocketClient({
      exchange: async (request) => {
        if (request.method === 'agent.list') return { id: request.id, result: { type: 'agent_list', agents: [baseAgent] } };
        return { id: request.id, result: { type: 'pong', version: '0.8.2', protocol: 20 } };
      },
    }),
    semanticProviders: [first, second],
  });
  const result = await withProvider.read({ target: 'firstmate2', mode: 'semantic' }, { requestId: 'semantic-provider' });
  assert.deepEqual(result, {
    target: 'firstmate2',
    mode: 'semantic',
    requestId: 'semantic-provider',
    provider: 'validated-test-provider',
    text: 'structured semantic response',
  });
  assert.equal(selectedContextPane, 'w1:p1');
});

test('semantic mode rejects raw options instead of ignoring them', async () => {
  const { gateway, requests } = fakeGateway();
  await assertGatewayCode(
    gateway.read({ target: 'firstmate2', mode: 'semantic', count: 1 }, { requestId: 'semantic-options' }),
    'INVALID_ARGUMENT',
    'semantic-options',
  );
  assert.equal(requests.length, 0);
});
