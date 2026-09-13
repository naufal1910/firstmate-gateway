import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';

import { ConfigError, validateConfig, type GatewayConfig } from '../config.js';
import { GatewayError } from '../errors.js';
import type {
  GatewayInvocationOptions,
  ReadInput,
  SendPromptInput,
} from '../gateway.js';
import {
  REMOTE_MAX_REQUEST_BODY_BYTES,
  startRemoteMcp,
  type ListeningRemoteMcpServer,
  type RemoteDiagnosticEvent,
} from '../mcp-http.js';
import type { GatewayForMcp } from '../mcp.js';

const RESOURCE = 'https://gateway.example.test/mcp';
const TUNNEL_RESOURCE = 'https://mcp.openai.example/v1/mcp/tunnel_0123456789abcdef0123456789abcdef';
const MARKER = 'FIRSTMATE_GATEWAY_CHECKPOINT_E_OK';
const SECRET_TOKEN = 'operator-token-secret-value';
const SECRET_PROMPT = 'prompt-body-must-not-leak';
const SECRET_RAW = 'raw-output-must-not-leak';
const SECRET_SEMANTIC = 'semantic-output-must-not-leak';
const SECRET_PATH = '/home/private/firstmate';
const SECRET_PANE = 'workspace:tab:pane-secret';
const UUID_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface McpCallResult {
  readonly structuredContent?: Record<string, unknown>;
  readonly toolResult?: Record<string, unknown>;
  readonly isError?: boolean;
}

function objectResult(result: unknown): McpCallResult {
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
  return result as McpCallResult;
}

function structured(result: McpCallResult): Record<string, unknown> {
  const content = result.structuredContent ?? result.toolResult;
  assert.notEqual(content, undefined);
  return content as Record<string, unknown>;
}

function remoteConfig(externalResource?: string): GatewayConfig {
  return validateConfig({
    version: 1,
    targets: {
      firstmate2: {
        herdr_session: 'firstmate-b',
        firstmate_home: SECRET_PATH,
        agent: 'pi',
      },
      reviewer: {
        herdr_session: 'review-session',
        firstmate_home: '/home/private/reviewer',
        agent: 'pi',
      },
    },
    remote: {
      enabled: true,
      bind_host: '127.0.0.1',
      port: 0,
      resource: RESOURCE,
      ...(externalResource === undefined ? {} : { external_resource: externalResource }),
      authorization_servers: [
        'https://identity.example.test/tenant',
        'https://backup-identity.example.test',
      ],
      allowed_hosts: ['127.0.0.1'],
      authorization: {
        principals: {
          'read-client': { targets: ['firstmate2'] },
          'operator-client': { targets: ['firstmate2'] },
          'restricted-client': { targets: ['reviewer'] },
        },
      },
    },
  });
}

interface GatewayCounters {
  list: number;
  status: number;
  send: number;
  read: number;
}

function fakeGateway(): { readonly gateway: GatewayForMcp; readonly counters: GatewayCounters } {
  const counters: GatewayCounters = { list: 0, status: 0, send: 0, read: 0 };
  let markerReady = false;
  const gateway: GatewayForMcp = {
    async listTargets() {
      counters.list += 1;
      return [
        { target: 'firstmate2', herdrSession: 'firstmate-b', agent: 'pi' },
        { target: 'reviewer', herdrSession: 'review-session', agent: 'pi' },
      ];
    },
    async getStatus(target: string) {
      counters.status += 1;
      return {
        target,
        resolved: true,
        state: 'idle',
        evidence: {
          cwdSource: 'foreground_cwd',
          weakerCwdEvidence: false,
        },
        diagnostic: `${SECRET_PATH} ${SECRET_PANE}`,
      };
    },
    async sendPrompt(input: SendPromptInput, options: GatewayInvocationOptions = {}) {
      counters.send += 1;
      if (input.message === 'uncertain') {
        throw new GatewayError(
          'PROMPT_DELIVERY_UNCERTAIN',
          'prompt delivery outcome is uncertain; no retry was attempted',
          undefined,
          options.requestId === undefined ? undefined : { requestId: options.requestId },
        );
      }
      markerReady = input.message === `Reply exactly with: ${MARKER}`;
      return {
        target: input.target,
        accepted: true,
        requestId: options.requestId ?? 'fixture-request',
        observedState: 'working',
      };
    },
    async read(input: ReadInput, options: GatewayInvocationOptions = {}) {
      counters.read += 1;
      if (input.mode === 'semantic') {
        throw new GatewayError(
          'SEMANTIC_OUTPUT_UNAVAILABLE',
          'semantic output is unavailable for this target',
          { reason: 'no_validated_provider' },
          options.requestId === undefined ? undefined : { requestId: options.requestId },
        );
      }
      return {
        target: input.target,
        mode: 'raw',
        requestId: options.requestId ?? 'fixture-request',
        source: input.source ?? 'recent-unwrapped',
        format: 'text',
        text: markerReady ? MARKER : SECRET_RAW,
        revision: 1,
        truncated: false,
      };
    },
  };
  return { gateway, counters };
}

/** Explicit test fixture only; production supplies the exported verifier seam. */
class FixtureTokenVerifier implements OAuthTokenVerifier {
  public constructor(private readonly resource = RESOURCE) {}

  public async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token === 'invalid-token' || token === 'rejected-token') throw new Error('fixture rejection');
    const expiresAt = token === 'expired-token'
      ? Math.floor(Date.now() / 1000) - 60
      : Math.floor(Date.now() / 1000) + 3_600;
    const base = { token, expiresAt, resource: new URL(this.resource) };
    switch (token) {
      case 'read-token':
        return { ...base, clientId: 'read-client', scopes: ['firstmate-gateway:read'] };
      case 'no-diagnostics-token':
        return { ...base, clientId: 'operator-client', scopes: ['firstmate-gateway:read', 'firstmate-gateway:send'] };
      case SECRET_TOKEN:
        return {
          ...base,
          clientId: 'operator-client',
          scopes: [
            'firstmate-gateway:read',
            'firstmate-gateway:send',
            'firstmate-gateway:diagnostics',
          ],
        };
      case 'restricted-token':
        return {
          ...base,
          clientId: 'restricted-client',
          scopes: [
            'firstmate-gateway:read',
            'firstmate-gateway:send',
            'firstmate-gateway:diagnostics',
          ],
        };
      case 'unmapped-token':
        return { ...base, clientId: 'unmapped-client', scopes: ['firstmate-gateway:read'] };
      case 'wrong-resource-token':
        return { ...base, clientId: 'operator-client', scopes: ['firstmate-gateway:read'], resource: new URL('https://other.example.test/mcp') };
      case 'private-resource-token':
        return { ...base, clientId: 'operator-client', scopes: ['firstmate-gateway:read'], resource: new URL(RESOURCE) };
      case 'expired-token':
        return { ...base, clientId: 'operator-client', scopes: ['firstmate-gateway:read'] };
      default:
        throw new Error('fixture rejection');
    }
  }
}

interface RunningFixture {
  readonly server: ListeningRemoteMcpServer;
  readonly url: URL;
  readonly counters: GatewayCounters;
  readonly diagnostics: RemoteDiagnosticEvent[];
}

async function startFixture(
  config = remoteConfig(),
  verifier: OAuthTokenVerifier = new FixtureTokenVerifier(),
): Promise<RunningFixture> {
  const { gateway, counters } = fakeGateway();
  const diagnostics: RemoteDiagnosticEvent[] = [];
  const started = await startRemoteMcp({
    config,
    gateway,
    tokenVerifier: verifier,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  assert.equal(started.enabled, true);
  const server = started as ListeningRemoteMcpServer;
  return {
    server,
    url: new URL(`http://${server.host}:${server.port}${server.path}`),
    counters,
    diagnostics,
  };
}

async function connect(url: URL, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    ...(token === undefined ? {} : { authProvider: { token: async () => token } }),
    onInsufficientScope: 'throw',
    reconnectionOptions: {
      maxReconnectionDelay: 10,
      initialReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client({ name: 'checkpoint-e-test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function errorCode(result: unknown): Promise<string> {
  const call = objectResult(result);
  assert.equal(call.isError, true);
  const error = structured(call).error as Record<string, unknown>;
  assert.match(String(error.requestId), UUID_REQUEST_ID);
  return String(error.code);
}

function assertNoSensitiveLeak(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [
    SECRET_TOKEN,
    SECRET_PROMPT,
    SECRET_RAW,
    SECRET_SEMANTIC,
    SECRET_PATH,
    SECRET_PANE,
  ]) {
    assert.equal(text.includes(secret), false, `response leaked ${secret}`);
  }
}

test('remote mode defaults disabled and incomplete enabled mode refuses startup before listening', async () => {
  const disabled = await startRemoteMcp({
    config: validateConfig({
      version: 1,
      targets: {
        firstmate2: {
          herdr_session: 'firstmate-b',
          firstmate_home: SECRET_PATH,
          agent: 'pi',
        },
      },
    }),
  });
  assert.deepEqual({ enabled: disabled.enabled, listening: disabled.listening }, {
    enabled: false,
    listening: false,
  });
  await disabled.close();

  await assert.rejects(startRemoteMcp({ config: remoteConfig() }), (error: unknown) =>
    error instanceof ConfigError && error.message.includes('access-token verifier'));
});

test('RFC 9728 metadata is public, path-aware, points to configured issuers, and does not invoke Gateway', async () => {
  const fixture = await startFixture();
  try {
    const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', fixture.url);
    const nonAllowlistedOrigin = 'https://web-client.example.test';
    const metadataResponse = await fetch(metadataUrl, {
      headers: { Origin: nonAllowlistedOrigin },
    });
    assert.equal(metadataResponse.status, 200);
    assert.equal(metadataResponse.headers.get('access-control-allow-origin'), '*');
    const metadataText = await metadataResponse.text();
    const metadata = JSON.parse(metadataText) as Record<string, unknown>;
    assert.deepEqual(metadata, {
      resource: RESOURCE,
      authorization_servers: [
        'https://identity.example.test/tenant',
        'https://backup-identity.example.test/',
      ],
      scopes_supported: [
        'firstmate-gateway:read',
        'firstmate-gateway:send',
        'firstmate-gateway:diagnostics',
      ],
      resource_name: 'FirstMate Gateway',
    });
    assertNoSensitiveLeak(metadataText);
    assert.deepEqual(fixture.counters, { list: 0, status: 0, send: 0, read: 0 });

    const requestedHeaders = 'Authorization, MCP-Protocol-Version';
    const metadataPreflight = await fetch(metadataUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: nonAllowlistedOrigin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': requestedHeaders,
      },
    });
    assert.equal(metadataPreflight.status, 204);
    assert.equal(metadataPreflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(metadataPreflight.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
    assert.equal(metadataPreflight.headers.get('access-control-allow-headers'), requestedHeaders);
    assert.equal(metadataPreflight.headers.get('vary'), 'Access-Control-Request-Headers');
    assert.equal(await metadataPreflight.text(), '');
    assert.deepEqual(fixture.counters, { list: 0, status: 0, send: 0, read: 0 });

    const challenge = await fetch(fixture.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(challenge.status, 401);
    assert.equal(
      challenge.headers.get('www-authenticate'),
      'Bearer error="invalid_token", error_description="Authentication required", resource_metadata="https://gateway.example.test/.well-known/oauth-protected-resource/mcp"',
    );
    const challengeText = await challenge.text();
    assert.match(challengeText, /UNAUTHENTICATED/);
    assertNoSensitiveLeak(challengeText);
    assertNoSensitiveLeak(challenge.headers.get('www-authenticate') ?? '');
    assert.deepEqual(fixture.counters, { list: 0, status: 0, send: 0, read: 0 });
  } finally {
    await fixture.server.close();
  }
});

test('Secure MCP Tunnel resource rewriting keeps local metadata private and binds auth to the external resource', async () => {
  const fixture = await startFixture(
    remoteConfig(TUNNEL_RESOURCE),
    new FixtureTokenVerifier(TUNNEL_RESOURCE),
  );
  try {
    const metadataResponse = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', fixture.url));
    assert.equal(metadataResponse.status, 200);
    const metadata = JSON.parse(await metadataResponse.text()) as Record<string, unknown>;
    assert.equal(metadata.resource, RESOURCE);

    const challenge = await fetch(fixture.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(challenge.status, 401);
    assert.equal(
      challenge.headers.get('www-authenticate'),
      'Bearer error="invalid_token", error_description="Authentication required", resource_metadata="https://gateway.example.test/.well-known/oauth-protected-resource/mcp"',
    );

    const client = await connect(fixture.url, 'read-token');
    try {
      const list = objectResult(await client.callTool({ name: 'firstmate_list', arguments: {} }));
      assert.deepEqual((structured(list).data as Record<string, unknown>).targets, [
        { target: 'firstmate2', agent: 'pi' },
      ]);
      assert.equal(fixture.counters.list, 1);
    } finally {
      await client.close();
    }

    await assert.rejects(
      connect(fixture.url, 'private-resource-token'),
      (error: unknown) => {
        assertNoSensitiveLeak(error instanceof Error ? error.message : error);
        return true;
      },
    );
    assert.equal(fixture.counters.list, 1);
  } finally {
    await fixture.server.close();
  }
});

test('invalid protected-resource issuer configuration fails before a listener or Gateway action', async () => {
  const { gateway, counters } = fakeGateway();
  const base = remoteConfig();
  const invalid = {
    ...base,
    remote: {
      ...base.remote,
      authorizationServers: ['http://identity.example.test'],
    },
  } as unknown as GatewayConfig;
  await assert.rejects(
    startRemoteMcp({ config: invalid, gateway, tokenVerifier: new FixtureTokenVerifier() }),
    (error: unknown) => error instanceof ConfigError && error.code === 'CONFIG_INVALID',
  );
  assert.deepEqual(counters, { list: 0, status: 0, send: 0, read: 0 });
});

test('real Streamable HTTP client rejects missing, malformed, invalid, expired, rejected, and wrong-resource credentials before Gateway action', async () => {
  const fixture = await startFixture();
  try {
    const failures: unknown[] = [];
    for (const token of [undefined, 'invalid-token', 'expired-token', 'rejected-token', 'wrong-resource-token']) {
      try {
        const client = await connect(fixture.url, token);
        await client.close();
        assert.fail('authentication unexpectedly succeeded');
      } catch (error) {
        failures.push(error);
      }
    }
    assert.equal(failures.length, 5);
    for (const error of failures) {
      assertNoSensitiveLeak(error instanceof Error ? error.message : error);
    }

    const malformed = await fetch(fixture.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer malformed token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const malformedBody = await malformed.text();
    assert.equal(malformed.status, 401);
    assert.match(malformed.headers.get('www-authenticate') ?? '', /^Bearer /);
    assert.match(malformedBody, /UNAUTHENTICATED/);
    assertNoSensitiveLeak(malformedBody);
    assert.deepEqual(fixture.counters, { list: 0, status: 0, send: 0, read: 0 });
  } finally {
    await fixture.server.close();
  }
});

test('read-only remote principal can list/status but scopes and target allowlist deny before Gateway invocation', async () => {
  const fixture = await startFixture();
  const client = await connect(fixture.url, 'read-token');
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      'firstmate_list',
      'firstmate_status',
      'firstmate_send',
      'firstmate_read',
    ]);
    assertNoSensitiveLeak(tools);

    const list = objectResult(await client.callTool({ name: 'firstmate_list', arguments: {} }));
    const listData = structured(list).data as Record<string, unknown>;
    assert.deepEqual(listData.targets, [{ target: 'firstmate2', agent: 'pi' }]);
    assert.match(String(listData.requestId), UUID_REQUEST_ID);

    const status = objectResult(await client.callTool({
      name: 'firstmate_status',
      arguments: { target: 'firstmate2' },
    }));
    assert.equal(structured(status).ok, true);
    assert.equal((structured(status).data as Record<string, unknown>).state, 'idle');
    assertNoSensitiveLeak(status);

    const deniedSend = await client.callTool({
      name: 'firstmate_send',
      arguments: { target: 'firstmate2', message: SECRET_PROMPT },
    });
    assert.equal(await errorCode(deniedSend), 'FORBIDDEN');
    assertNoSensitiveLeak(deniedSend);
    assert.equal(fixture.counters.send, 0);

    const deniedRaw = await client.callTool({
      name: 'firstmate_read',
      arguments: { target: 'firstmate2' },
    });
    assert.equal(await errorCode(deniedRaw), 'FORBIDDEN');
    assertNoSensitiveLeak(deniedRaw);
    assert.equal(fixture.counters.read, 0);

    const deniedTarget = await client.callTool({
      name: 'firstmate_status',
      arguments: { target: 'reviewer' },
    });
    assert.equal(await errorCode(deniedTarget), 'FORBIDDEN');
    assert.equal(fixture.counters.status, 1);

    const semantic = await client.callTool({
      name: 'firstmate_read',
      arguments: { target: 'firstmate2', mode: 'semantic' },
    });
    assert.equal(await errorCode(semantic), 'SEMANTIC_OUTPUT_UNAVAILABLE');
    assertNoSensitiveLeak(semantic);
    assert.equal(fixture.counters.read, 1);
  } finally {
    await client.close();
    await fixture.server.close();
  }
});

test('authenticated missing scope and unmapped principal are forbidden deterministically', async () => {
  const fixture = await startFixture();
  try {
    const noDiagnostics = await connect(fixture.url, 'no-diagnostics-token');
    try {
      const denied = await noDiagnostics.callTool({
        name: 'firstmate_read',
        arguments: { target: 'firstmate2', mode: 'raw' },
      });
      assert.equal(await errorCode(denied), 'FORBIDDEN');
      assert.equal(fixture.counters.read, 0);
    } finally {
      await noDiagnostics.close();
    }

    const unmapped = await connect(fixture.url, 'unmapped-token');
    try {
      const denied = await unmapped.callTool({ name: 'firstmate_list', arguments: {} });
      assert.equal(await errorCode(denied), 'FORBIDDEN');
      assert.equal(fixture.counters.list, 0);
    } finally {
      await unmapped.close();
    }

    const restricted = await connect(fixture.url, 'restricted-token');
    try {
      const list = objectResult(await restricted.callTool({ name: 'firstmate_list', arguments: {} }));
      assert.deepEqual((structured(list).data as Record<string, unknown>).targets, [
        { target: 'reviewer', agent: 'pi' },
      ]);
      const status = await restricted.callTool({
        name: 'firstmate_status',
        arguments: { target: 'firstmate2' },
      });
      const send = await restricted.callTool({
        name: 'firstmate_send',
        arguments: { target: 'firstmate2', message: SECRET_PROMPT },
      });
      const read = await restricted.callTool({
        name: 'firstmate_read',
        arguments: { target: 'firstmate2', mode: 'raw' },
      });
      assert.equal(await errorCode(status), 'FORBIDDEN');
      assert.equal(await errorCode(send), 'FORBIDDEN');
      assert.equal(await errorCode(read), 'FORBIDDEN');
      assertNoSensitiveLeak([status, send, read]);
      assert.deepEqual(fixture.counters, { list: 1, status: 0, send: 0, read: 0 });
    } finally {
      await restricted.close();
    }
  } finally {
    await fixture.server.close();
  }
});

test('allowed send is delivered once, authorized raw read observes marker, and uncertain send is never retried', async () => {
  const fixture = await startFixture();
  const client = await connect(fixture.url, SECRET_TOKEN);
  try {
    const send = objectResult(await client.callTool({
      name: 'firstmate_send',
      arguments: { target: 'firstmate2', message: `Reply exactly with: ${MARKER}` },
    }));
    const sendData = structured(send).data as Record<string, unknown>;
    assert.equal(sendData.accepted, true);
    assert.match(String(sendData.requestId), UUID_REQUEST_ID);
    assert.equal(fixture.counters.send, 1);

    const read = objectResult(await client.callTool({
      name: 'firstmate_read',
      arguments: { target: 'firstmate2', mode: 'raw' },
    }));
    const readData = structured(read).data as Record<string, unknown>;
    assert.equal(readData.mode, 'raw');
    assert.equal(readData.source, 'recent-unwrapped');
    assert.equal(readData.text, MARKER);
    assert.match(String(readData.requestId), UUID_REQUEST_ID);
    assert.notEqual(readData.requestId, sendData.requestId);

    const uncertain = await client.callTool({
      name: 'firstmate_send',
      arguments: { target: 'firstmate2', message: 'uncertain' },
    });
    assert.equal(await errorCode(uncertain), 'PROMPT_DELIVERY_UNCERTAIN');
    assert.equal(fixture.counters.send, 2);
  } finally {
    await client.close();
    await fixture.server.close();
  }
});

test('malformed, oversized, wrong-route, and unsupported HTTP requests are rejected before Gateway action without leakage', async () => {
  const fixture = await startFixture();
  try {
    const headers = {
      Authorization: `Bearer ${SECRET_TOKEN}`,
      'Content-Type': 'application/json',
    };
    const malformed = await fetch(fixture.url, {
      method: 'POST',
      headers,
      body: '{ definitely not JSON',
    });
    const malformedText = await malformed.text();
    assert.equal(malformed.status, 400);
    assertNoSensitiveLeak(malformedText);

    const oversized = await fetch(fixture.url, {
      method: 'POST',
      headers,
      body: 'x'.repeat(REMOTE_MAX_REQUEST_BODY_BYTES + 1),
    });
    const oversizedText = await oversized.text();
    assert.equal(oversized.status, 413);
    assertNoSensitiveLeak(oversizedText);

    const malformedProtocol = await fetch(fixture.url, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(malformedProtocol.status, 400);
    assertNoSensitiveLeak(await malformedProtocol.text());

    const wrongOrigin = await fetch(fixture.url, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://attacker.example.test' },
      body: '{}',
    });
    assert.equal(wrongOrigin.status, 403);
    assertNoSensitiveLeak(await wrongOrigin.text());

    const wrongRoute = await fetch(new URL('/not-rest', fixture.url), {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(wrongRoute.status, 404);
    assertNoSensitiveLeak(await wrongRoute.text());

    const unsupported = await fetch(fixture.url, { method: 'PUT', headers });
    assert.equal(unsupported.status, 405);
    assertNoSensitiveLeak(await unsupported.text());

    assert.deepEqual(fixture.counters, { list: 0, status: 0, send: 0, read: 0 });
    assertNoSensitiveLeak(fixture.diagnostics);
    assert.ok(fixture.diagnostics.every((event) =>
      event === 'request_error' || event === 'client_protocol_error' || event === 'mcp_handler_error'));
  } finally {
    await fixture.server.close();
  }
});
