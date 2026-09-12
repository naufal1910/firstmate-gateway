import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateConfig } from '../config.js';
import { Gateway, MAX_PROMPT_BYTES } from '../gateway.js';
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

/** Readable that counts how many bytes were actually produced by the source. */
class CountingReadable extends Readable {
  public produced = 0;
  readonly #chunkSize: number;
  #remaining: number;

  public constructor(totalBytes: number, chunkSize = 512) {
    super({ highWaterMark: 1024 });
    this.#remaining = totalBytes;
    this.#chunkSize = chunkSize;
  }

  public override _read(size: number): void {
    if (this.#remaining <= 0) {
      this.push(null);
      return;
    }
    const length = Math.min(this.#chunkSize, size, this.#remaining);
    this.#remaining -= length;
    this.produced += length;
    this.push(Buffer.alloc(length, 0x78));
  }
}

function errorCode(stdout: readonly string[]): string {
  return (JSON.parse(stdout[0] as string) as { error: { code: string } }).error.code;
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

test('CLI accepts a stdin prompt exactly at the byte limit and rejects one byte over', { concurrency: false }, async () => {
  const messages: string[] = [];
  const atLimit = await capture(() => main(
    ['send', 'firstmate2', '--json'],
    { gateway: sendGateway((message) => messages.push(message)), stdin: new CountingReadable(MAX_PROMPT_BYTES) },
  ));
  assert.equal(atLimit.code, 0);
  assert.equal(messages.length, 1);
  assert.equal(Buffer.byteLength(messages[0] as string, 'utf8'), MAX_PROMPT_BYTES);

  const overLimit = await capture(() => main(
    ['send', 'firstmate2', '--json'],
    { gateway: sendGateway(() => { throw new Error('must not send'); }), stdin: new CountingReadable(MAX_PROMPT_BYTES + 1) },
  ));
  assert.equal(overLimit.code, 1);
  assert.equal(errorCode(overLimit.stdout), 'PROMPT_TOO_LARGE');
});

test('CLI rejects an oversized stdin prompt without draining the source', { concurrency: false }, async () => {
  const total = 16 * 1024 * 1024;
  const stdin = new CountingReadable(total, 512);
  let called = false;
  const result = await capture(() => main(
    ['send', 'firstmate2', '--json'],
    { gateway: sendGateway(() => { called = true; }), stdin },
  ));
  assert.equal(result.code, 1);
  assert.equal(called, false);
  assert.equal(errorCode(result.stdout), 'PROMPT_TOO_LARGE');
  assert.ok(stdin.produced <= MAX_PROMPT_BYTES + 64 * 1024, `consumed ${stdin.produced} bytes`);
  assert.ok(stdin.produced < total, `drained the whole source (${stdin.produced} bytes)`);
});

test('CLI explicit-source conflict detection consumes only enough stdin to see input', { concurrency: false }, async () => {
  const total = 16 * 1024 * 1024;
  const stdin = new CountingReadable(total, 512);
  let called = false;
  const result = await capture(() => main(
    ['send', 'firstmate2', 'positional', '--json'],
    { gateway: sendGateway(() => { called = true; }), stdin },
  ));
  assert.equal(result.code, 2);
  assert.equal(called, false);
  assert.equal(errorCode(result.stdout), 'INVALID_ARGUMENT');
  assert.match(result.stdout[0] as string, /send accepts exactly one prompt source/);
  assert.ok(stdin.produced <= 8 * 1024, `consumed ${stdin.produced} bytes`);
  assert.ok(stdin.produced < total, `drained the whole source (${stdin.produced} bytes)`);
});

test('CLI rejects an oversized file without loading it entirely', { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'firstmate-gateway-bounded-'));
  const file = join(directory, 'huge.bin');
  const handle = openSync(file, 'w');
  try {
    // A 3 GiB sparse file cannot be loaded by readFile() (> 2 GiB limit); a
    // bounded reader must classify it as an oversized prompt instead.
    ftruncateSync(handle, 3 * 1024 * 1024 * 1024);
  } finally {
    closeSync(handle);
  }
  let called = false;
  try {
    const result = await capture(() => main(
      ['send', 'firstmate2', '--file', file, '--json'],
      { gateway: sendGateway(() => { called = true; }), stdin: Readable.from([]) },
    ));
    assert.equal(result.code, 1);
    assert.equal(called, false);
    assert.equal(errorCode(result.stdout), 'PROMPT_TOO_LARGE');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
