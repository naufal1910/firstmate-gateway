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

test('maps the public recent-unwrapped source to Herdr wire naming', async () => {
  let readRequest: HerdrRequest | undefined;
  const client = new HerdrSocketClient({
    exchange: async (request) => {
      readRequest = request;
      return {
        id: request.id,
        result: {
          type: 'pane_read',
          read: {
            pane_id: 'w1:p1',
            workspace_id: 'w1',
            tab_id: 'w1:t1',
            source: 'recent_unwrapped',
            format: 'text',
            text: 'raw output',
            revision: 3,
            truncated: false,
          },
        },
      };
    },
  });

  const result = await client.read('w1:p1', { source: 'recent-unwrapped', lines: 120 });
  assert.equal(readRequest?.method, 'agent.read');
  assert.equal(readRequest?.params.source, 'recent_unwrapped');
  assert.equal(result.source, 'recent-unwrapped');
  assert.equal(result.text, 'raw output');
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

test('rejects a protocol older than the compatibility floor', async () => {
  const client = new HerdrSocketClient({
    exchange: exchangeFrom(() => ({ type: 'pong', version: 'old', protocol: 19 })),
    minimumProtocol: 20,
  });

  await assert.rejects(client.probeCompatibility(), (error: unknown) => {
    return error instanceof HerdrCompatibilityError && error.message.includes('older than');
  });
});

test('accepts a future protocol when required methods and response contracts remain compatible', async () => {
  const client = new HerdrSocketClient({
    exchange: exchangeFrom((request) => {
      switch (request.method) {
        case 'ping':
          return { type: 'pong', version: '0.9.0', protocol: 21 };
        case 'agent.list':
          return { type: 'agent_list', agents: [{ ...agent, future_agent_field: 'ignored' }] };
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
              text: 'future protocol probe output',
              revision: 8,
              truncated: false,
              future_read_field: 'ignored',
            },
          };
      }
    }),
  });

  const report = await client.probeCompatibility();
  assert.equal(report.protocol, 21);
  assert.deepEqual(report.methods, {
    ping: 'supported',
    'agent.list': 'supported',
    'agent.prompt': 'supported',
    'agent.read': 'supported',
  });
});

test('rejects a missing required method explicitly even in a future protocol', async () => {
  const client = new HerdrSocketClient({
    exchange: async (request) => {
      if (request.method === 'ping') {
        return {
          id: request.id,
          result: { type: 'pong', version: '0.9.0', protocol: 21 },
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

  await assert.rejects(client.probeCompatibility(), (error: unknown) => {
    return error instanceof HerdrCompatibilityError && error.message.includes('agent.prompt');
  });
});

test('normalizes unknown future agent statuses and preserves safe raw detail', async () => {
  const client = new HerdrSocketClient({
    exchange: exchangeFrom((request) => {
      assert.equal(request.method, 'agent.list');
      return {
        type: 'agent_list',
        agents: [{ ...agent, agent_status: 'paused_by_policy' }],
      };
    }),
  });

  const agents = await client.listAgents();
  assert.equal(agents[0]?.agentStatus, 'unknown');
  assert.equal(agents[0]?.rawAgentStatus, 'paused_by_policy');
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
