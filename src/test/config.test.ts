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
