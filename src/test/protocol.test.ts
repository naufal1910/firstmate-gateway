import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HerdrCompatibilityError,
  HerdrMalformedResponseError,
  HerdrProtocolError,
  HerdrSocketClient,
  type HerdrRequest,
} from '../herdr/protocol.js';

const agent = {
  terminal_id: 'term_1',
  agent: 'pi',
  agent_status: 'idle',
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  pane_id: 'w1:p1',
  focused: true,
  revision: 7,
  cwd: '/home/agent/workspace/firstmate2',
  foreground_cwd: '/home/agent/workspace/firstmate2',
};

function exchangeFrom(
  handler: (request: HerdrRequest) => unknown,
): (request: HerdrRequest) => Promise<unknown> {
  return async (request) => ({ id: request.id, result: handler(request) });
}

test('parses compatible responses and tolerates unknown fields', async () => {
  const client = new HerdrSocketClient({
    exchange: exchangeFrom((request) => {
      switch (request.method) {
        case 'ping':
          return {
            type: 'pong',
            version: '0.8.2',
            protocol: 20,
            capabilities: { live_handoff: true },
            future_field: 'ignored',
          };
        case 'agent.list':
          return { type: 'agent_list', agents: [{ ...agent, future_agent_field: 42 }] };
        case 'agent.prompt':
          return { type: 'agent_prompted', agent: { ...agent, future_prompt_field: true } };
        case 'agent.read':
          return {
            type: 'pane_read',
            read: {
              pane_id: 'w1:p1',
              workspace_id: 'w1',
              tab_id: 'w1:t1',
              source: 'detection',
              format: 'text',
              text: 'safe probe output',
              revision: 8,
              truncated: false,
              future_read_field: 'ignored',
            },
          };
      }
    }),
  });

  const report = await client.probeCompatibility();
  assert.deepEqual(report, {
    version: '0.8.2',
    protocol: 20,
    methods: {
      ping: 'supported',
      'agent.list': 'supported',
      'agent.prompt': 'supported',
      'agent.read': 'supported',
    },
    agentCount: 1,
  });

  const listed = await client.listAgents();
  assert.equal(listed[0]?.paneId, 'w1:p1');
  assert.equal(listed[0]?.foregroundCwd, '/home/agent/workspace/firstmate2');
  const prompted = await client.prompt('w1:p1', 'test');
  assert.equal(prompted.agentStatus, 'idle');
  const read = await client.read('w1:p1', { source: 'detection', lines: 1 });
  assert.equal(read.text, 'safe probe output');
});

test('reports a Herdr protocol error', async () => {
  const client = new HerdrSocketClient({
    exchange: async (request) => ({
      id: request.id,
      error: { code: 'agent_not_found', message: 'agent target missing' },
    }),
  });

  await assert.rejects(
    client.listAgents(),
    (error: unknown) =>
      error instanceof HerdrProtocolError &&
      error.remoteCode === 'agent_not_found' &&
      error.message === 'agent target missing',
  );
});

test('rejects malformed responses', async () => {
  const client = new HerdrSocketClient({
    exchange: async (request) => ({
      id: request.id,
      result: { type: 'pong', version: '0.8.2' },
    }),
  });

  await assert.rejects(client.ping(), HerdrMalformedResponseError);
});

test('rejects protocol mismatch', async () => {
  const client = new HerdrSocketClient({
    exchange: exchangeFrom(() => ({ type: 'pong', version: 'future', protocol: 999 })),
    expectedProtocol: 20,
  });

  await assert.rejects(client.probeCompatibility(), (error: unknown) => {
    return error instanceof HerdrCompatibilityError && error.message.includes('incompatible');
  });
});

test('rejects a missing required method explicitly', async () => {
  const client = new HerdrSocketClient({
    exchange: async (request) => {
      if (request.method === 'ping') {
        return {
          id: request.id,
          result: { type: 'pong', version: '0.8.2', protocol: 20 },
        };
      }
      if (request.method === 'agent.list') {
        return {
          id: request.id,
          result: { type: 'agent_list', agents: [] },
        };
      }
      return {
        id: request.id,
        error: { code: 'method_not_found', message: 'unsupported' },
      };
    },
  });

  await assert.rejects(client.probeCompatibility(), HerdrCompatibilityError);
});

test('does not probe live prompts or reads', async () => {
  const requests: HerdrRequest[] = [];
  const client = new HerdrSocketClient({
    exchange: async (request) => {
      requests.push(request);
      if (request.method === 'ping') {
        return { id: request.id, result: { type: 'pong', version: '0.8.2', protocol: 20 } };
      }
      if (request.method === 'agent.list') {
        return { id: request.id, result: { type: 'agent_list', agents: [] } };
      }
      return {
        id: request.id,
        error: { code: 'agent_not_found', message: 'probe target is not configured' },
      };
    },
  });

  await client.probeCompatibility();
  const prompt = requests.find((request) => request.method === 'agent.prompt');
  const read = requests.find((request) => request.method === 'agent.read');
  assert.notEqual(prompt, undefined);
  assert.notEqual(read, undefined);
  assert.match(String(prompt?.params.target), /^firstmate-gw-compat-/);
  assert.equal(prompt?.params.text, 'firstmate-gateway compatibility probe');
  assert.equal(read?.params.source, 'detection');
});
