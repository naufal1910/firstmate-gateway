import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import { createAuth0TokenVerifier } from '../auth0-verifier.js';
import { ConfigError, ConfigNotFoundError, validateConfig } from '../config.js';
import { GatewayError } from '../errors.js';
import { startAuth0RemoteMcp } from '../mcp-http-auth0.js';
import type { GatewayForMcp } from '../mcp.js';
import {
  REMOTE_SCOPES,
  authenticateBearer,
  authorizeGateway,
} from '../remote-auth.js';

const ISSUER = 'https://placeholder-tenant.jp.auth0.com/';
const JWKS_URL = `${ISSUER}.well-known/jwks.json`;
const AUDIENCE = 'https://tunnel.example.test/v1/mcp/tunnel_0123456789abcdef0123456789abcdef';
const OTHER_AUDIENCE = 'https://other.example.test/v1/mcp/tunnel_fedcba9876543210fedcba9876543210';
const PRIVATE_RESOURCE = 'https://private-gateway.example.test/mcp';
const CLIENT_ID = 'placeholder-chatgpt-client';
const TARGET_HOME = '/safe/placeholder/firstmate';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

interface SigningFixture {
  readonly privateKey: SigningKey;
  readonly jwk: JWK;
}

async function signingFixture(kid = 'placeholder-key'): Promise<SigningFixture> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    jwk: {
      ...publicJwk,
      alg: 'RS256',
      use: 'sig',
      kid,
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function auth0Fetch(
  jwks: unknown,
  discovery: unknown = { issuer: ISSUER, jwks_uri: JWKS_URL },
): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ISSUER}.well-known/openid-configuration`) return jsonResponse(discovery);
    if (url === JWKS_URL) return jsonResponse(jwks);
    return jsonResponse({ error: 'not_found' }, 404);
  };
}

async function signToken(
  privateKey: SigningKey,
  overrides: Readonly<Record<string, unknown>> = {},
  algorithm = 'RS256',
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'auth0|placeholder-user',
    client_id: CLIENT_ID,
    azp: CLIENT_ID,
    iat: now,
    exp: now + 300,
    scope: `${REMOTE_SCOPES.read} ${REMOTE_SCOPES.send} ${REMOTE_SCOPES.diagnostics}`,
    ...overrides,
  })
    .setProtectedHeader({ alg: algorithm, typ: 'JWT', kid: 'placeholder-key' })
    .sign(privateKey);
}

async function verifierFixture(fixture: SigningFixture) {
  return createAuth0TokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    fetch: auth0Fetch({ keys: [fixture.jwk] }),
  });
}

function enabledRemoteConfig() {
  const config = validateConfig({
    version: 1,
    targets: {
      firstmate: {
        herdr_session: 'placeholder-session',
        firstmate_home: TARGET_HOME,
        agent: 'pi',
      },
    },
    remote: {
      enabled: true,
      bind_host: '127.0.0.1',
      port: 0,
      resource: PRIVATE_RESOURCE,
      external_resource: AUDIENCE,
      authorization_servers: [ISSUER],
      allowed_hosts: ['127.0.0.1'],
      authorization: {
        principals: {
          [CLIENT_ID]: { targets: ['firstmate'] },
        },
      },
    },
  });
  assert.equal(config.remote.enabled, true);
  return config.remote;
}

function neverInvokedGateway(counter: { calls: number }): GatewayForMcp {
  const invoked = (): never => {
    counter.calls += 1;
    throw new Error('Gateway must not be invoked');
  };
  return {
    listTargets: async () => invoked(),
    getStatus: async () => invoked(),
    sendPrompt: async () => invoked(),
    read: async () => invoked(),
  };
}

async function withConfig(source: string, callback: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'firstmate-gateway-auth0-'));
  const path = join(directory, 'local.yaml');
  await writeFile(path, source, { encoding: 'utf8', mode: 0o600 });
  try {
    await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Auth0 verifier accepts a valid RS256 JWT and maps verified client, scopes, expiry, and exact resource', async () => {
  const fixture = await signingFixture();
  const verifier = await verifierFixture(fixture);
  const token = await signToken(fixture.privateKey);

  const principal = await authenticateBearer(`Bearer ${token}`, verifier, AUDIENCE);
  assert.equal(principal.id, CLIENT_ID);
  assert.deepEqual([...principal.scopes], [
    REMOTE_SCOPES.read,
    REMOTE_SCOPES.send,
    REMOTE_SCOPES.diagnostics,
  ]);
  const authInfo = await verifier.verifyAccessToken(token);
  assert.equal(authInfo.clientId, CLIENT_ID);
  assert.equal(authInfo.resource?.href, AUDIENCE);
  assert.ok((authInfo.expiresAt ?? 0) > Math.floor(Date.now() / 1000));

  const azpOnlyToken = await signToken(fixture.privateKey, { client_id: undefined });
  const azpOnly = await verifier.verifyAccessToken(azpOnlyToken);
  assert.equal(azpOnly.clientId, CLIENT_ID);

  const conflictingClaims = await signToken(fixture.privateKey, { client_id: 'different-placeholder-client' });
  await assert.rejects(verifier.verifyAccessToken(conflictingClaims));
});

test('Auth0 verifier rejects wrong issuer, signature, expiry, not-before, and exact resource', async () => {
  const fixture = await signingFixture();
  const attacker = await signingFixture('placeholder-key');
  const wrongAlgorithm = await generateKeyPair('RS512');
  const verifier = await verifierFixture(fixture);
  const now = Math.floor(Date.now() / 1000);
  const tokens = [
    await signToken(fixture.privateKey, { iss: 'https://other-tenant.jp.auth0.com/' }),
    await signToken(attacker.privateKey),
    await signToken(wrongAlgorithm.privateKey, {}, 'RS512'),
    await signToken(fixture.privateKey, { exp: now - 60 }),
    await signToken(fixture.privateKey, { exp: undefined }),
    await signToken(fixture.privateKey, { sub: 123 }),
    await signToken(fixture.privateKey, { nbf: now + 120 }),
    await signToken(fixture.privateKey, { iat: now + 120 }),
    await signToken(fixture.privateKey, { aud: OTHER_AUDIENCE }),
  ];

  for (const token of tokens) {
    await assert.rejects(authenticateBearer(`Bearer ${token}`, verifier, AUDIENCE));
  }
});

test('Auth0 scopes are parsed strictly and only approved scopes reach Gateway authorization', async () => {
  const fixture = await signingFixture();
  const verifier = await verifierFixture(fixture);
  const unsupportedToken = await signToken(fixture.privateKey, { scope: 'unapproved:admin offline_access' });
  const principal = await authenticateBearer(`Bearer ${unsupportedToken}`, verifier, AUDIENCE);
  assert.deepEqual([...principal.scopes], []);

  const counter = { calls: 0 };
  const authorized = authorizeGateway(
    neverInvokedGateway(counter),
    principal,
    enabledRemoteConfig(),
  );
  await assert.rejects(authorized.listTargets(), (error: unknown) =>
    error instanceof GatewayError && error.code === 'FORBIDDEN');
  assert.equal(counter.calls, 0);

  const malformedScope = await signToken(fixture.privateKey, { scope: `${REMOTE_SCOPES.read}  ${REMOTE_SCOPES.send}` });
  await assert.rejects(authenticateBearer(`Bearer ${malformedScope}`, verifier, AUDIENCE));
});

test('Auth0 discovery, JWKS, and verifier configuration fail closed before use', async () => {
  const fixture = await signingFixture();

  await assert.rejects(
    createAuth0TokenVerifier({ issuer: 'http://placeholder.auth0.com/', audience: AUDIENCE, fetch: auth0Fetch({ keys: [fixture.jwk] }) }),
    (error: unknown) => error instanceof ConfigError && error.code === 'CONFIG_INVALID',
  );
  await assert.rejects(
    createAuth0TokenVerifier({ issuer: 'https://identity.example.test/', audience: AUDIENCE, fetch: auth0Fetch({ keys: [fixture.jwk] }) }),
    (error: unknown) => error instanceof ConfigError && error.code === 'CONFIG_INVALID',
  );
  await assert.rejects(
    createAuth0TokenVerifier({ issuer: ISSUER, audience: 'not-a-resource', fetch: auth0Fetch({ keys: [fixture.jwk] }) }),
    (error: unknown) => error instanceof ConfigError && error.code === 'CONFIG_INVALID',
  );
  await assert.rejects(
    createAuth0TokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: async () => { throw new Error('unreachable placeholder'); },
    }),
    (error: unknown) => error instanceof ConfigError && error.message === 'Auth0 issuer discovery is unavailable or invalid',
  );
  await assert.rejects(
    createAuth0TokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: auth0Fetch({ keys: [fixture.jwk] }, {
        issuer: 'https://different-tenant.jp.auth0.com/',
        jwks_uri: JWKS_URL,
      }),
    }),
    (error: unknown) => error instanceof ConfigError && error.message === 'Auth0 issuer discovery metadata is invalid',
  );
  await assert.rejects(
    createAuth0TokenVerifier({ issuer: ISSUER, audience: AUDIENCE, fetch: auth0Fetch({ keys: [] }) }),
    (error: unknown) => error instanceof ConfigError && error.message.includes('JWKS'),
  );
});

test('Auth0 remote runner keeps remote off by default and missing or malformed local config fails before listening', async () => {
  const missingPath = join(tmpdir(), `firstmate-gateway-missing-${process.pid}.yaml`);
  await assert.rejects(
    startAuth0RemoteMcp({ configPath: missingPath }),
    (error: unknown) => error instanceof ConfigNotFoundError && error.code === 'CONFIG_NOT_FOUND',
  );

  await withConfig(`version: 1
targets:
  firstmate:
    herdr_session: placeholder-session
    firstmate_home: ${TARGET_HOME}
    agent: pi
remote:
  enabled: false
`, async (path) => {
    const remote = await startAuth0RemoteMcp({
      configPath: path,
      fetch: async () => { throw new Error('disabled mode must not fetch'); },
    });
    assert.deepEqual({ enabled: remote.enabled, listening: remote.listening }, {
      enabled: false,
      listening: false,
    });
  });

  await withConfig(`version: 1
targets:
  firstmate:
    herdr_session: placeholder-session
    firstmate_home: ${TARGET_HOME}
    agent: pi
remote:
  enabled: true
  bind_host: 127.0.0.1
  port: 3100
  resource: ${PRIVATE_RESOURCE}
  allowed_hosts: [127.0.0.1]
  authorization:
    principals:
      ${CLIENT_ID}:
        targets: [firstmate]
`, async (path) => {
    await assert.rejects(
      startAuth0RemoteMcp({ configPath: path }),
      (error: unknown) => error instanceof ConfigError && error.code === 'CONFIG_INVALID',
    );
  });

  const protectedPlaceholder = 'protected-config-value-must-not-print';
  await withConfig(`version: [${protectedPlaceholder}\n`, async (path) => {
    const result = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'mcp-http-auth0.js')], {
      encoding: 'utf8',
      env: { ...process.env, FIRSTMATE_GATEWAY_CONFIG: path },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'CONFIG_INVALID: remote MCP configuration or Auth0 verifier is invalid\n');
    assert.equal(result.stderr.includes(protectedPlaceholder), false);
  });
});

test('Auth0 remote runner injects the concrete verifier into the loopback MCP listener', async () => {
  const fixture = await signingFixture();
  const token = await signToken(fixture.privateKey);
  await withConfig(`version: 1
targets:
  firstmate:
    herdr_session: placeholder-session
    firstmate_home: ${TARGET_HOME}
    agent: pi
remote:
  enabled: true
  bind_host: 127.0.0.1
  port: 0
  resource: ${PRIVATE_RESOURCE}
  external_resource: ${AUDIENCE}
  authorization_servers:
    - ${ISSUER}
  allowed_hosts: [127.0.0.1]
  authorization:
    principals:
      ${CLIENT_ID}:
        targets: [firstmate]
`, async (path) => {
    const server = await startAuth0RemoteMcp({
      configPath: path,
      gateway: neverInvokedGateway({ calls: 0 }),
      fetch: auth0Fetch({ keys: [fixture.jwk] }),
    });
    try {
      assert.equal(server.enabled, true);
      if (!server.enabled) return;
      const response = await fetch(`http://${server.host}:${server.port}${server.path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
  });
});

test('Auth0 remote runner refuses public binds, ambiguous issuers, and unreachable discovery before listening', async () => {
  const config = (bindHost: string, issuers: readonly string[], publicBind = false) => `version: 1
targets:
  firstmate:
    herdr_session: placeholder-session
    firstmate_home: ${TARGET_HOME}
    agent: pi
remote:
  enabled: true
  bind_host: ${bindHost}
  port: 3100
  allow_public_bind: ${String(publicBind)}
  resource: ${PRIVATE_RESOURCE}
  external_resource: ${AUDIENCE}
  authorization_servers:
${issuers.map((issuer) => `    - ${issuer}`).join('\n')}
  allowed_hosts: [${bindHost}]
  authorization:
    principals:
      ${CLIENT_ID}:
        targets: [firstmate]
`;
  const noFetch: typeof globalThis.fetch = async () => {
    assert.fail('invalid runner configuration must fail before issuer access');
  };

  await withConfig(config('0.0.0.0', [ISSUER], true), async (path) => {
    await assert.rejects(
      startAuth0RemoteMcp({ configPath: path, fetch: noFetch }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('loopback'),
    );
  });
  await withConfig(config('127.0.0.1', [ISSUER, 'https://backup-placeholder.jp.auth0.com/']), async (path) => {
    await assert.rejects(
      startAuth0RemoteMcp({ configPath: path, fetch: noFetch }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('exactly one'),
    );
  });

  const counter = { calls: 0 };
  await withConfig(config('127.0.0.1', [ISSUER]), async (path) => {
    await assert.rejects(
      startAuth0RemoteMcp({
        configPath: path,
        gateway: neverInvokedGateway(counter),
        fetch: async () => { throw new Error('issuer unavailable'); },
      }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('discovery'),
    );
  });
  assert.equal(counter.calls, 0);
});
