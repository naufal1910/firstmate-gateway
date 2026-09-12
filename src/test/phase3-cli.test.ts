import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateConfig } from '../config.js';
import { Gateway } from '../gateway.js';
import { main } from '../cli.js';
import type { GatewayInvocationOptions, SendPromptInput, SendPromptResult } from '../gateway.js';

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

interface CapturedOutput {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

async function capture(action: () => Promise<number>): Promise<CapturedOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => stdout.push(values.join(' '));
  console.error = (...values: unknown[]) => stderr.push(values.join(' '));
  try {
    return { code: await action(), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function sendGateway(onSend: (message: string) => void): Gateway {
  return {
    sendPrompt: async (input: SendPromptInput, options: GatewayInvocationOptions): Promise<SendPromptResult> => {
      onSend(input.message);
      return {
        target: input.target,
        accepted: true,
        requestId: options.requestId as string,
        observedState: 'working',
      };
    },
  } as unknown as Gateway;
}

test('CLI preserves positional, file, and stdin prompt sources literally', { concurrency: false }, async () => {
  const messages: string[] = [];
  const literal = `quote ' " ; $() &&\nUnicode 日本語 🚀\nlast line`;
  const positional = await capture(() => main(
    ['send', 'firstmate2', literal, '--json'],
    { gateway: sendGateway((message) => messages.push(message)), stdin: Readable.from([]) },
  ));
  assert.equal(positional.code, 0);
  assert.equal(messages[0], literal);
  assert.deepEqual(JSON.parse(positional.stdout[0] as string), {
    target: 'firstmate2',
    accepted: true,
    requestId: (JSON.parse(positional.stdout[0] as string) as { requestId: string }).requestId,
    observedState: 'working',
  });

  const directory = mkdtempSync(join(tmpdir(), 'firstmate-gateway-phase3-'));
  const file = join(directory, 'prompt.txt');
  const fileText = 'file line one\nfile line two — données';
  writeFileSync(file, fileText, 'utf8');
  try {
    const fromFile = await capture(() => main(
      ['send', 'firstmate2', '--file', file, '--json'],
      { gateway: sendGateway((message) => messages.push(message)), stdin: Readable.from([]) },
    ));
    assert.equal(fromFile.code, 0);
    assert.equal(messages[1], fileText);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const stdinText = 'stdin prompt\nwith Unicode: 日本語';
  const fromStdin = await capture(() => main(
    ['send', 'firstmate2', '--json'],
    { gateway: sendGateway((message) => messages.push(message)), stdin: Readable.from([stdinText]) },
  ));
  assert.equal(fromStdin.code, 0);
  assert.equal(messages[2], stdinText);
});

test('CLI rejects conflicting prompt sources with a stable JSON request envelope', { concurrency: false }, async () => {
  let called = false;
  const result = await capture(() => main(
    ['send', 'firstmate2', 'positional', '--json'],
    {
      gateway: sendGateway(() => { called = true; }),
      stdin: Readable.from(['stdin']),
    },
  ));
  assert.equal(result.code, 2);
  assert.equal(called, false);
  assert.equal(result.stderr.length, 0);
  const payload = JSON.parse(result.stdout[0] as string) as {
    readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
  };
  assert.equal(payload.error.code, 'INVALID_ARGUMENT');
  assert.equal(payload.error.message, 'send accepts exactly one prompt source');
  assert.match(payload.error.requestId, /^[0-9a-f-]{36}$/);
});

test('CLI delegates empty prompt and unsupported semantic mode without raw fallback', { concurrency: false }, async () => {
  const gateway = new Gateway({ config });
  const empty = await capture(() => main(
    ['send', 'firstmate2', '', '--json'],
    { gateway, stdin: Readable.from([]) },
  ));
  assert.equal(empty.code, 2);
  assert.equal((JSON.parse(empty.stdout[0] as string) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');

  const humanEmpty = await capture(() => main(
    ['send', 'firstmate2', ''],
    { gateway, stdin: Readable.from([]) },
  ));
  assert.equal(humanEmpty.code, 2);
  assert.match(humanEmpty.stderr[0] as string, /^INVALID_ARGUMENT: .*requestId: [0-9a-f-]{36}/);

  const semantic = await capture(() => main(
    ['read', 'firstmate2', '--semantic', '--json'],
    { gateway },
  ));
  assert.equal(semantic.code, 1);
  assert.equal(
    (JSON.parse(semantic.stdout[0] as string) as { error: { code: string } }).error.code,
    'SEMANTIC_OUTPUT_UNAVAILABLE',
  );
});

test('CLI validates raw read counts before Herdr I/O', { concurrency: false }, async () => {
  const result = await capture(() => main(
    ['read', 'firstmate2', '--count', '0', '--json'],
    { gateway: new Gateway({ config }) },
  ));
  assert.equal(result.code, 2);
  assert.equal((JSON.parse(result.stdout[0] as string) as { error: { code: string } }).error.code, 'INVALID_ARGUMENT');
});
