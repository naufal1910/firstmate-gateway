import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConfigError,
  parseConfig,
  validateConfig,
} from '../config.js';

test('loads and canonicalizes a valid single-target YAML document', () => {
  const config = parseConfig(`
version: 1
targets:
  firstmate2:
    herdr_session: session-a
    firstmate_home: /srv/firstmate2/../firstmate2
    agent: pi
`);

  assert.equal(config.version, 1);
  assert.deepEqual(config.remote, { enabled: false });
  assert.deepEqual(config.targets.firstmate2, {
    alias: 'firstmate2',
    herdrSession: 'session-a',
    firstmateHome: '/srv/firstmate2',
    agent: 'pi',
  });
});

test('loads multiple named targets without pane identity', () => {
  const config = parseConfig(`
version: 1
targets:
  firstmate:
    herdr_session: session-a
    firstmate_home: /srv/firstmate
    agent: pi
  reviewer:
    herdr_session: session-b
    firstmate_home: /srv/reviewer
    agent: codex
`);

  assert.deepEqual(Object.keys(config.targets), ['firstmate', 'reviewer']);
  assert.equal('pane_id' in config.targets.firstmate!, false);
});

test('validates explicit remote security and per-principal target policy', () => {
  const config = parseConfig(`
version: 1
targets:
  firstmate2:
    herdr_session: session-a
    firstmate_home: /srv/firstmate2
    agent: pi
remote:
  enabled: true
  bind_host: 127.0.0.1
  port: 0
  resource: https://gateway.example.test/mcp
  authorization_servers:
    - https://identity.example.test/tenant
    - https://backup-identity.example.test
  allowed_hosts: [127.0.0.1]
  authorization:
    principals:
      oauth-client:
        targets: [firstmate2]
`);

  assert.deepEqual(config.remote, {
    enabled: true,
    bindHost: '127.0.0.1',
    port: 0,
    allowPublicBind: false,
    resource: 'https://gateway.example.test/mcp',
    externalResource: 'https://gateway.example.test/mcp',
    authorizationServers: [
      'https://identity.example.test/tenant',
      'https://backup-identity.example.test/',
    ],
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: [],
    principals: { 'oauth-client': { targets: ['firstmate2'] } },
  });
});

test('accepts a Secure MCP Tunnel resource separately from the private MCP resource', () => {
  const config = parseConfig(`
version: 1
targets:
  firstmate2:
    herdr_session: session-a
    firstmate_home: /srv/firstmate2
    agent: pi
remote:
  enabled: true
  bind_host: 127.0.0.1
  port: 3000
  resource: https://gateway.example.test/mcp
  external_resource: https://mcp.openai.example/v1/mcp/tunnel_0123456789abcdef0123456789abcdef
  authorization_servers:
    - https://identity.example.test
  allowed_hosts: [127.0.0.1]
  authorization:
    principals:
      oauth-client:
        targets: [firstmate2]
`);

  assert.equal(config.remote.enabled, true);
  if (!config.remote.enabled) return;
  assert.equal(config.remote.resource, 'https://gateway.example.test/mcp');
  assert.equal(config.remote.externalResource, 'https://mcp.openai.example/v1/mcp/tunnel_0123456789abcdef0123456789abcdef');
});

test('remote startup configuration fails closed when security policy is incomplete or unsafe', () => {
  const target = {
    herdr_session: 'session-a',
    firstmate_home: '/srv/firstmate2',
    agent: 'pi',
  };
  assert.throws(() => validateConfig({
    version: 1,
    targets: { firstmate2: target },
    remote: { enabled: true, bind_host: '127.0.0.1', port: 3000 },
  }), ConfigError);

  assert.throws(() => validateConfig({
    version: 1,
    targets: { firstmate2: target },
    remote: {
      enabled: true,
      bind_host: '0.0.0.0',
      port: 3000,
      resource: 'https://gateway.example.test/mcp',
      authorization_servers: ['https://identity.example.test'],
      allowed_hosts: ['gateway.example.test'],
      authorization: { principals: { operator: { targets: ['firstmate2'] } } },
    },
  }), (error: unknown) => error instanceof ConfigError && error.message.includes('allow_public_bind'));

  assert.throws(() => validateConfig({
    version: 1,
    targets: { firstmate2: target },
    remote: {
      enabled: true,
      bind_host: '127.0.0.1',
      port: 3000,
      resource: 'http://gateway.example.test/mcp',
      authorization_servers: ['http://identity.example.test'],
      allowed_hosts: ['127.0.0.1'],
      authorization: { principals: { operator: { targets: ['not-configured'] } } },
    },
  }), ConfigError);

  for (const authorizationServers of [
    [],
    ['http://identity.example.test'],
    ['https://user:secret@identity.example.test'],
    ['https://identity.example.test?tenant=secret'],
    ['https://identity.example.test', 'https://identity.example.test/'],
  ]) {
    assert.throws(() => validateConfig({
      version: 1,
      targets: { firstmate2: target },
      remote: {
        enabled: true,
        bind_host: '127.0.0.1',
        port: 3000,
        resource: 'https://gateway.example.test/mcp',
        authorization_servers: authorizationServers,
        allowed_hosts: ['127.0.0.1'],
        authorization: { principals: { operator: { targets: ['firstmate2'] } } },
      },
    }), ConfigError);
  }

  for (const externalResource of [
    'https://gateway.example.test/mcp',
    'https://mcp.openai.example/v1/mcp/tunnel_INVALID',
    'https://mcp.openai.example/v1/mcp/tunnel_0123456789abcdef0123456789abcdef?x=1',
    'http://mcp.openai.example/v1/mcp/tunnel_0123456789abcdef0123456789abcdef',
  ]) {
    assert.throws(() => validateConfig({
      version: 1,
      targets: { firstmate2: target },
      remote: {
        enabled: true,
        bind_host: '127.0.0.1',
        port: 3000,
        resource: 'https://gateway.example.test/mcp',
        external_resource: externalResource,
        authorization_servers: ['https://identity.example.test'],
        allowed_hosts: ['127.0.0.1'],
        authorization: { principals: { operator: { targets: ['firstmate2'] } } },
      },
    }), ConfigError);
  }
});

test('rejects malformed YAML before configuration validation', () => {
  assert.throws(
    () => parseConfig('version: [1\ntargets: {}'),
    (error: unknown) => error instanceof ConfigError && error.message.includes('valid YAML'),
  );
});

test('rejects missing and malformed target values', () => {
  assert.throws(
    () =>
      validateConfig({
        version: 1,
        targets: {
          firstmate2: {
            herdr_session: 'session-a',
            firstmate_home: 'relative/path',
          },
        },
      }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes('firstmate_home') &&
      error.message.includes('agent'),
  );

  assert.throws(
    () =>
      validateConfig({
        version: 1,
        targets: {
          'Not-an-alias': {
            herdr_session: 'session-a',
            firstmate_home: '/srv/firstmate',
            agent: 'pi',
          },
        },
      }),
    ConfigError,
  );
});

test('rejects duplicate YAML keys', () => {
  assert.throws(
    () =>
      parseConfig(`
version: 1
targets:
  firstmate:
    herdr_session: firstmate-a
    herdr_session: firstmate-b
    firstmate_home: /srv/firstmate
    agent: pi
`),
    (error: unknown) => error instanceof ConfigError && error.message.includes('unique'),
  );

  assert.throws(
    () =>
      parseConfig(`
version: 1
targets:
  firstmate:
    herdr_session: firstmate-a
    firstmate_home: /srv/firstmate
    agent: pi
  firstmate:
    herdr_session: firstmate-b
    firstmate_home: /srv/other
    agent: pi
`),
    (error: unknown) => error instanceof ConfigError && error.message.includes('unique'),
  );
});

test('rejects unknown top-level and target fields', () => {
  assert.throws(
    () =>
      parseConfig(`
version: 1
unexpected: true
targets:
  firstmate:
    herdr_session: firstmate-a
    firstmate_home: /srv/firstmate
    agent: pi
`),
    ConfigError,
  );

  assert.throws(
    () =>
      parseConfig(`
version: 1
targets:
  firstmate:
    herdr_session: firstmate-a
    firstmate_home: /srv/firstmate
    agent: pi
    pane_id: w1:p1
`),
    ConfigError,
  );
});
