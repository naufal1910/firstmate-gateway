import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_URL = new URL('../mcp-stdio.js', import.meta.url).href;

interface McpCallResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly toolResult?: Record<string, unknown>;
  readonly isError?: boolean;
}

function objectResult(result: unknown): McpCallResult {
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
  return result as McpCallResult;
}

function structured(result: McpCallResult): Record<string, unknown> | undefined {
  return result.structuredContent ?? result.toolResult;
}

function fakeServerScript(): string {
  return `
    const { runStdioMcp } = await import(${JSON.stringify(SERVER_URL)});
    const { GatewayError } = await import(${JSON.stringify(new URL('../errors.js', import.meta.url).href)});
    let sendCalls = 0;
    let statusCalls = 0;
    const gateway = {
      listTargets: async () => [{ target: 'firstmate2', herdrSession: 'firstmate-b', agent: 'pi' }],
      getStatus: async (target, options) => {
        statusCalls += 1;
        process.stderr.write('fake-status-called\\n');
        return { target, resolved: true, state: 'idle', evidence: { cwdSource: 'foreground_cwd', weakerCwdEvidence: false } };
      },
      sendPrompt: async (input, options) => {
        sendCalls += 1;
        if (process.env.MCP_FAKE_UNCERTAIN === '1') {
          throw new GatewayError('PROMPT_DELIVERY_UNCERTAIN', 'prompt delivery outcome is uncertain; no retry was attempted', undefined, { requestId: options.requestId });
        }
        return { target: input.target, accepted: true, requestId: options.requestId, observedState: 'working' };
      },
      read: async (input, options) => {
        if (input.mode === 'semantic') {
          throw new GatewayError('SEMANTIC_OUTPUT_UNAVAILABLE', 'semantic output is unavailable for this target', undefined, { requestId: options.requestId });
        }
        return { target: input.target, mode: 'raw', requestId: options.requestId, source: input.source ?? 'recent-unwrapped', format: 'text', text: sendCalls === 1 ? 'FIRSTMATE_GATEWAY_CHECKPOINT_D_OK' : 'send-calls=' + sendCalls, revision: 1, truncated: false };
      },
    };
    await runStdioMcp(gateway);
  `;
}

async function connectFakeServer(uncertain = false): Promise<{
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly getStderr: () => string;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--input-type=module', '-e', fakeServerScript()],
    env: { ...process.env, ...(uncertain ? { MCP_FAKE_UNCERTAIN: '1' } : {}) },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: 'gateway-test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, getStderr: () => stderr };
}

async function closeClient(client: Client): Promise<void> {
  await client.close();
}

test('MCP client sees exactly four safe tools and delegates each operation through Gateway Core', async () => {
  const { client, getStderr } = await connectFakeServer();
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      'firstmate_list',
      'firstmate_status',
      'firstmate_send',
      'firstmate_read',
    ]);
    assert.equal(tools.tools.some((tool) => JSON.stringify(tool).includes('pane')), false);
    assert.equal(tools.tools.some((tool) => JSON.stringify(tool).includes('/home/')), false);

    const list = objectResult(await client.callTool({ name: 'firstmate_list', arguments: {} }));
    assert.equal(structured(list)?.ok, true);
    const listData = structured(list)?.data as Record<string, unknown>;
    assert.match(String(listData.requestId), /^[0-9]+$/);
    assert.deepEqual(listData.targets, [{ target: 'firstmate2', agent: 'pi' }]);

    const status = objectResult(await client.callTool({
      name: 'firstmate_status',
      arguments: { target: 'firstmate2' },
    }));
    assert.equal(structured(status)?.ok, true);
    assert.equal((structured(status)?.data as Record<string, unknown>).target, 'firstmate2');
    assert.equal((structured(status)?.data as Record<string, unknown>).state, 'idle');

    const send = objectResult(await client.callTool({
      name: 'firstmate_send',
      arguments: { target: 'firstmate2', message: 'Reply exactly with: FIRSTMATE_GATEWAY_CHECKPOINT_D_OK' },
    }));
    assert.equal(send.isError, undefined);
    assert.equal((structured(send)?.data as Record<string, unknown>).accepted, true);
    const sendTool = tools.tools.find((tool) => tool.name === 'firstmate_send');
    assert.deepEqual(sendTool?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });

    const read = objectResult(await client.callTool({
      name: 'firstmate_read',
      arguments: { target: 'firstmate2', mode: 'raw', source: 'recent-unwrapped', count: 20 },
    }));
    const readData = structured(read)?.data as Record<string, unknown>;
    assert.equal(structured(read)?.ok, true);
    assert.equal(readData.target, 'firstmate2');
    assert.equal(readData.mode, 'raw');
    assert.match(String(readData.requestId), /^[0-9]+$/);
    assert.equal(readData.source, 'recent-unwrapped');
    assert.equal(readData.format, 'text');
    assert.equal(readData.text, 'FIRSTMATE_GATEWAY_CHECKPOINT_D_OK');
    assert.equal(readData.revision, 1);
    assert.equal(readData.truncated, false);
    assert.equal(getStderr().includes('fake-status-called'), true);
    assert.equal(getStderr().includes('FIRSTMATE_GATEWAY_CHECKPOINT_D_OK'), false);
  } finally {
    await closeClient(client);
  }
});

test('MCP boundary validation rejects invalid input before Gateway Core and preserves semantic-unavailable errors', async () => {
  const { client, getStderr } = await connectFakeServer();
  try {
    const invalid = objectResult(await client.callTool({
      name: 'firstmate_status',
      arguments: { target: '../not-an-alias' },
    }));
    assert.equal(invalid.isError, true);
    assert.equal(getStderr().includes('fake-status-called'), false);

    const semantic = objectResult(await client.callTool({
      name: 'firstmate_read',
      arguments: { target: 'firstmate2', mode: 'semantic' },
    }));
    assert.equal(semantic.isError, true);
    const semanticError = structured(semantic)?.error as Record<string, unknown>;
    assert.equal(structured(semantic)?.ok, false);
    assert.equal(semanticError.code, 'SEMANTIC_OUTPUT_UNAVAILABLE');
    assert.equal(semanticError.message, 'semantic output is unavailable for this target');
    assert.match(String(semanticError.requestId), /^[0-9]+$/);
    assert.equal(JSON.stringify(semantic).includes('FIRSTMATE_GATEWAY_CHECKPOINT_D_OK'), false);
  } finally {
    await closeClient(client);
  }
});

test('malformed stdio input is contained on stderr without protocol output or a crash', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp-stdio.js', import.meta.url))]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
  child.stdin.end('{ definitely not JSON\n');
  const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  assert.equal(stderr.includes('stdio transport error'), true);
});

test('uncertain MCP send is side-effecting exactly once and is not retried', async () => {
  const { client } = await connectFakeServer(true);
  try {
    const send = objectResult(await client.callTool({
      name: 'firstmate_send',
      arguments: { target: 'firstmate2', message: 'uncertain delivery test' },
    }));
    assert.equal(send.isError, true);
    assert.equal((structured(send)?.error as Record<string, unknown>).code, 'PROMPT_DELIVERY_UNCERTAIN');

    const read = objectResult(await client.callTool({
      name: 'firstmate_read',
      arguments: { target: 'firstmate2', mode: 'raw' },
    }));
    assert.equal((structured(read)?.data as Record<string, unknown>).text, 'FIRSTMATE_GATEWAY_CHECKPOINT_D_OK');
  } finally {
    await closeClient(client);
  }
});
