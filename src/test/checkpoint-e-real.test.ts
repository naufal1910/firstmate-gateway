import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';

import { loadConfigFile, type EnabledRemoteConfig, type GatewayConfig } from '../config.js';
import { Gateway } from '../gateway.js';
import { startRemoteMcp, type ListeningRemoteMcpServer } from '../mcp-http.js';
import type { GatewayForMcp } from '../mcp.js';

const ENABLED = process.env.FIRSTMATE_GATEWAY_CHECKPOINT_E_REAL === '1';
const RESOURCE = 'https://checkpoint-e.loopback.invalid/mcp';
const TOKEN = 'checkpoint-e-explicit-test-fixture-token';
const PRINCIPAL = 'checkpoint-e-test-fixture';
const TARGET = 'firstmate2';
const MARKER = 'FIRSTMATE_GATEWAY_CHECKPOINT_E_OK';
const PROMPT = `Reply exactly with: ${MARKER}`;

/** Explicit local test fixture; it is never selected by production startup. */
class CheckpointETokenVerifier implements OAuthTokenVerifier {
  public async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token !== TOKEN) throw new Error('fixture token rejected');
    return {
      token,
      clientId: PRINCIPAL,
      scopes: [
        'firstmate-gateway:read',
        'firstmate-gateway:send',
        'firstmate-gateway:diagnostics',
      ],
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      resource: new URL(RESOURCE),
    };
  }
}

function withRemote(local: GatewayConfig): GatewayConfig {
  const remote: EnabledRemoteConfig = {
    enabled: true,
    bindHost: '127.0.0.1',
    port: 0,
    allowPublicBind: false,
    resource: RESOURCE,
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: [],
    principals: { [PRINCIPAL]: { targets: [TARGET] } },
  };
  return { ...local, remote };
}

function observedGateway(gateway: GatewayForMcp): {
  readonly gateway: GatewayForMcp;
  readonly sendCount: () => number;
} {
  let sends = 0;
  return {
    sendCount: () => sends,
    gateway: {
      listTargets: (options) => gateway.listTargets(options),
      getStatus: (target, options) => gateway.getStatus(target, options),
      sendPrompt: (input, options) => {
        sends += 1;
        return gateway.sendPrompt(input, options);
      },
      read: (input, options) => gateway.read(input, options),
    },
  };
}

function resultData(result: unknown): Record<string, unknown> {
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
  const call = result as {
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
    readonly toolResult?: Record<string, unknown>;
  };
  assert.equal(call.isError, undefined);
  const envelope = call.structuredContent ?? call.toolResult;
  assert.notEqual(envelope, undefined);
  assert.equal(envelope?.ok, true);
  return envelope?.data as Record<string, unknown>;
}

test('Checkpoint E real loopback Streamable HTTP send/read round trip', {
  skip: ENABLED ? false : 'set FIRSTMATE_GATEWAY_CHECKPOINT_E_REAL=1 for the configured local FirstMate target',
  timeout: 120_000,
}, async () => {
  const local = await loadConfigFile();
  assert.notEqual(local.targets[TARGET], undefined, `local config must define logical target ${TARGET}`);
  const config = withRemote(local);
  const observed = observedGateway(new Gateway({ config }));
  const started = await startRemoteMcp({
    config,
    gateway: observed.gateway,
    tokenVerifier: new CheckpointETokenVerifier(),
  });
  assert.equal(started.enabled, true);
  const server = started as ListeningRemoteMcpServer;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${server.host}:${server.port}${server.path}`),
    {
      authProvider: { token: async () => TOKEN },
      onInsufficientScope: 'throw',
      reconnectionOptions: {
        maxReconnectionDelay: 10,
        initialReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    },
  );
  const client = new Client({ name: 'checkpoint-e-real-client', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const send = resultData(await client.callTool({
      name: 'firstmate_send',
      arguments: { target: TARGET, message: PROMPT },
    }));
    assert.equal(send.accepted, true);
    assert.equal(observed.sendCount(), 1, 'non-idempotent send must reach Gateway exactly once');

    let observedMarker = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const read = resultData(await client.callTool({
        name: 'firstmate_read',
        arguments: {
          target: TARGET,
          mode: 'raw',
          source: 'recent-unwrapped',
          count: 240,
        },
      }));
      if (String(read.text).split(/\r?\n/).some((line) => line.trim() === MARKER)) {
        observedMarker = true;
        break;
      }
      await delay(1_000);
    }
    assert.equal(observedMarker, true, `authorized read did not observe exact marker ${MARKER}`);
    assert.equal(observed.sendCount(), 1, 'read polling must never replay send');
  } finally {
    await client.close();
    await server.close();
  }
});
