#!/usr/bin/env node

import { open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createRequestId,
  DEFAULT_READ_LINES,
  DEFAULT_READ_SOURCE,
  Gateway,
  isReadSource,
  MAX_READ_LINES,
  MAX_PROMPT_BYTES,
  type ReadInput,
  type ReadMode,
  type RawReadResult,
  type SendPromptResult,
  type SemanticReadResult,
  type TargetStatus,
  type TargetSummary,
  type DoctorReport,
} from './gateway.js';
import { VERSION } from './index.js';
import { GatewayError, withRequestId, type GatewayErrorPayload } from './errors.js';

const HELP = `firstmate-gateway ${VERSION}

Usage:
  firstmate-gateway --help
  firstmate-gateway --version
  firstmate-gateway targets [--json]
  firstmate-gateway status <target> [--json]
  firstmate-gateway send <target> [message] [--file <path>] [--json]
  firstmate-gateway read <target> [--source <source>] [--count <n>] [--json]
  firstmate-gateway read <target> --semantic [--json]
  firstmate-gateway doctor [--json]

Send accepts exactly one message source: a positional message, --file, or stdin.
Raw read defaults to source ${DEFAULT_READ_SOURCE} and ${DEFAULT_READ_LINES} lines (maximum ${MAX_READ_LINES}).
`;

type Command = 'targets' | 'status' | 'doctor' | 'send' | 'read';

interface ParsedArgs {
  readonly command?: Command;
  readonly target?: string;
  readonly message?: string;
  readonly file?: string;
  readonly fileSpecified: boolean;
  readonly source?: ReadInput['source'];
  readonly count?: number;
  readonly mode?: ReadMode;
  readonly json: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly error?: string;
}

export interface CliDependencies {
  readonly gateway?: Gateway;
  readonly stdin?: NodeJS.ReadableStream;
}

function optionValue(args: readonly string[], index: number, option: string):
  | { readonly value: string; readonly nextIndex: number }
  | { readonly error: string } {
  const value = args[index + 1];
  if (value === undefined || value.length === 0) {
    return { error: `${option} requires a value` };
  }
  return { value, nextIndex: index + 1 };
}

function inlineOptionValue(arg: string, option: string): string | undefined {
  const prefix = `${option}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : undefined;
}

function parseCount(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let json = false;
  let help = false;
  let version = false;
  let file: string | undefined;
  let fileSpecified = false;
  let source: ReadInput['source'];
  let count: number | undefined;
  let mode: ReadMode | undefined;
  const positional: string[] = [];
  let optionsTerminated = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (optionsTerminated || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      optionsTerminated = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--version' || arg === '-V') {
      version = true;
      continue;
    }

    const inlineFile = inlineOptionValue(arg, '--file');
    if (inlineFile !== undefined) {
      if (inlineFile.length === 0) return { json, help, version, fileSpecified: true, error: '--file requires a value' };
      if (fileSpecified) return { json, help, version, fileSpecified: true, error: '--file may be specified only once' };
      file = inlineFile;
      fileSpecified = true;
      continue;
    }
    if (arg === '--file') {
      const result = optionValue(args, index, '--file');
      if ('error' in result) return { json, help, version, fileSpecified, error: result.error };
      if (fileSpecified) return { json, help, version, fileSpecified: true, error: '--file may be specified only once' };
      file = result.value;
      fileSpecified = true;
      index = result.nextIndex;
      continue;
    }

    const inlineSource = inlineOptionValue(arg, '--source');
    if (inlineSource !== undefined) {
      if (!isReadSource(inlineSource)) return { json, help, version, fileSpecified, error: 'read source is unsupported' };
      if (source !== undefined) return { json, help, version, fileSpecified, error: '--source may be specified only once' };
      source = inlineSource;
      continue;
    }
    if (arg === '--source') {
      const result = optionValue(args, index, '--source');
      if ('error' in result) return { json, help, version, fileSpecified, error: result.error };
      if (!isReadSource(result.value)) return { json, help, version, fileSpecified, error: 'read source is unsupported' };
      if (source !== undefined) return { json, help, version, fileSpecified, error: '--source may be specified only once' };
      source = result.value;
      index = result.nextIndex;
      continue;
    }

    const inlineCount = inlineOptionValue(arg, '--count') ?? inlineOptionValue(arg, '--lines');
    if (inlineCount !== undefined) {
      const parsedCount = parseCount(inlineCount);
      if (parsedCount === undefined) return { json, help, version, fileSpecified, error: 'read count must be a safe non-negative integer' };
      if (count !== undefined) return { json, help, version, fileSpecified, error: '--count may be specified only once' };
      count = parsedCount;
      continue;
    }
    if (arg === '--count' || arg === '--lines') {
      const result = optionValue(args, index, arg);
      if ('error' in result) return { json, help, version, fileSpecified, error: result.error };
      const parsedCount = parseCount(result.value);
      if (parsedCount === undefined) return { json, help, version, fileSpecified, error: 'read count must be a safe non-negative integer' };
      if (count !== undefined) return { json, help, version, fileSpecified, error: '--count may be specified only once' };
      count = parsedCount;
      index = result.nextIndex;
      continue;
    }

    const inlineMode = inlineOptionValue(arg, '--mode');
    if (inlineMode !== undefined) {
      if (inlineMode !== 'raw' && inlineMode !== 'semantic') return { json, help, version, fileSpecified, error: 'read mode must be raw or semantic' };
      if (mode !== undefined && mode !== inlineMode) return { json, help, version, fileSpecified, error: 'read mode was specified more than once' };
      mode = inlineMode;
      continue;
    }
    if (arg === '--mode') {
      const result = optionValue(args, index, '--mode');
      if ('error' in result) return { json, help, version, fileSpecified, error: result.error };
      if (result.value !== 'raw' && result.value !== 'semantic') return { json, help, version, fileSpecified, error: 'read mode must be raw or semantic' };
      if (mode !== undefined && mode !== result.value) return { json, help, version, fileSpecified, error: 'read mode was specified more than once' };
      mode = result.value;
      index = result.nextIndex;
      continue;
    }
    if (arg === '--semantic') {
      if (mode !== undefined && mode !== 'semantic') return { json, help, version, fileSpecified, error: 'read mode was specified more than once' };
      mode = 'semantic';
      continue;
    }

    return { json, help, version, fileSpecified, error: `unknown option: ${arg}` };
  }

  if (help || version) {
    return { json, help, version, fileSpecified };
  }

  const command = positional[0];
  if (command !== 'targets' && command !== 'status' && command !== 'doctor' && command !== 'send' && command !== 'read') {
    return { json, help, version, fileSpecified, error: 'a command is required: targets, status, doctor, send, or read' };
  }

  const target = positional[1];
  if ((command === 'status' || command === 'send' || command === 'read') && target === undefined) {
    return { json, help, version, fileSpecified, error: `${command} requires a target alias` };
  }
  if ((command === 'targets' || command === 'doctor') && target !== undefined) {
    return { json, help, version, fileSpecified, error: `${command} does not accept a target alias` };
  }

  if (command === 'send') {
    if (positional.length > 3) return { json, help, version, fileSpecified, error: 'send accepts one positional message' };
    if (fileSpecified && positional[2] !== undefined) return { json, help, version, fileSpecified, error: 'send accepts exactly one prompt source' };
    if (source !== undefined || count !== undefined || mode !== undefined) {
      return { json, help, version, fileSpecified, error: 'send accepts only a positional message, --file, or stdin' };
    }
  }

  if (command === 'read') {
    if (positional.length > 2) return { json, help, version, fileSpecified, error: 'read accepts one target alias' };
    if (fileSpecified) return { json, help, version, fileSpecified, error: 'read does not accept --file' };
    if (mode === 'semantic' && (source !== undefined || count !== undefined)) {
      return { json, help, version, fileSpecified, error: 'raw read options cannot be used with semantic mode' };
    }
  }

  if (command !== 'read' && command !== 'send' && (fileSpecified || source !== undefined || count !== undefined || mode !== undefined)) {
    return { json, help, version, fileSpecified, error: `${command} does not accept read/input options` };
  }
  if (command !== 'send' && command !== 'read' && positional.length > 2) {
    return { json, help, version, fileSpecified, error: `unexpected argument: ${positional[2]}` };
  }

  return {
    command,
    ...(target === undefined ? {} : { target }),
    ...(positional[2] === undefined ? {} : { message: positional[2] }),
    ...(file === undefined ? {} : { file }),
    fileSpecified,
    ...(source === undefined ? {} : { source }),
    ...(count === undefined ? {} : { count }),
    ...(mode === undefined ? {} : { mode }),
    json,
    help,
    version,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function printTargets(targets: readonly TargetSummary[], json: boolean): void {
  if (json) {
    printJson({ targets });
    return;
  }
  if (targets.length === 0) {
    console.log('No configured targets.');
    return;
  }
  for (const target of targets) {
    console.log(`${target.target}\t${target.agent}\tHerdr session: ${target.herdrSession}`);
  }
}

function printStatus(status: TargetStatus, json: boolean): void {
  if (json) {
    printJson(status);
    return;
  }
  console.log(`${status.target}: ${status.state}`);
  if (status.evidence.cwdSource === 'cwd') {
    console.log('  diagnostic: used fallback runtime cwd evidence');
  }
  if (status.diagnostic !== undefined) {
    console.log(`  diagnostic: ${status.diagnostic}`);
  }
}

function printDoctor(report: DoctorReport, json: boolean): void {
  if (json) {
    printJson(report);
    return;
  }
  console.log(`doctor: ${report.ok ? 'ok' : 'failed'}`);
  for (const check of report.checks) {
    const status = check.ok ? 'ok' : 'failed';
    const code = check.code === undefined ? '' : ` [${check.code}]`;
    console.log(`  ${status} ${check.name}${code}: ${check.message}`);
  }
}

function printSend(result: SendPromptResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }
  console.log(`${result.target}: prompt accepted (requestId: ${result.requestId})`);
}

function printRead(result: RawReadResult | SemanticReadResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }
  process.stdout.write(result.text);
}

function errorPayload(error: unknown, requestId: string): GatewayErrorPayload {
  return withRequestId(error, requestId).toJSON();
}

function printError(error: unknown, json: boolean, requestId: string): void {
  const payload = errorPayload(error, requestId);
  if (json) {
    printJson({ error: payload });
    return;
  }
  console.error(`${payload.code}: ${payload.message} (requestId: ${payload.requestId})`);
}

interface BoundedText {
  readonly text: string;
  readonly bytes: number;
}

function chunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(String(chunk), 'utf8');
}

const FILE_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads at most `byteLimit` bytes from a stream, stopping as soon as the limit
 * is reached so a long-lived or oversized source is never drained. The returned
 * `bytes` count is capped at `byteLimit`, which is enough for callers to decide
 * overflow by reading `byteLimit - 1` or `byteLimit` bytes.
 */
async function readBoundedStream(stream: NodeJS.ReadableStream, byteLimit: number): Promise<BoundedText> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<unknown>) {
    const buffer = chunkToBuffer(chunk);
    if (buffer.length === 0) continue;
    const accepted = Math.min(buffer.length, byteLimit - bytes);
    if (accepted > 0) {
      chunks.push(buffer.subarray(0, accepted));
      bytes += accepted;
    }
    if (bytes >= byteLimit) break;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return { text, bytes };
}

/**
 * Reads at most `byteLimit` bytes from a file, allocating and issuing I/O only
 * for the bounded prefix instead of loading the whole file first.
 */
async function readBoundedFile(path: string, byteLimit: number): Promise<BoundedText> {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const scratch = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, byteLimit));
    while (bytes < byteLimit) {
      const wanted = Math.min(scratch.length, byteLimit - bytes);
      const { bytesRead } = await handle.read(scratch, 0, wanted, bytes);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
      bytes += bytesRead;
    }
    return { text: Buffer.concat(chunks).toString('utf8'), bytes };
  } finally {
    await handle.close();
  }
}

function shouldInspectStdin(stream: NodeJS.ReadableStream): boolean {
  return stream !== process.stdin || process.stdin.isTTY !== true;
}

function promptSizeError(bytes: number, requestId: string): GatewayError {
  return new GatewayError('PROMPT_TOO_LARGE', `prompt exceeds the ${MAX_PROMPT_BYTES}-byte limit`, {
    limitBytes: MAX_PROMPT_BYTES,
    promptBytes: bytes,
  }, { requestId });
}

async function resolvePrompt(parsed: ParsedArgs, stdin: NodeJS.ReadableStream, requestId: string): Promise<string> {
  const explicitSource = parsed.message !== undefined || parsed.fileSpecified;
  if (explicitSource && shouldInspectStdin(stdin)) {
    // Only enough input to know whether stdin is a competing source; never drain it.
    const piped = await readBoundedStream(stdin, 1);
    if (piped.bytes > 0) throw new GatewayError('INVALID_ARGUMENT', 'send accepts exactly one prompt source', undefined, { requestId });
  }

  if (parsed.message !== undefined) return parsed.message;

  if (parsed.fileSpecified) {
    let source: BoundedText;
    try {
      source = await readBoundedFile(parsed.file as string, MAX_PROMPT_BYTES + 1);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('INVALID_ARGUMENT', 'unable to read prompt file', undefined, {
        requestId,
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (source.bytes > MAX_PROMPT_BYTES) throw promptSizeError(source.bytes, requestId);
    return source.text;
  }

  const stdinText = await readBoundedStream(stdin, MAX_PROMPT_BYTES + 1);
  if (stdinText.bytes > MAX_PROMPT_BYTES) throw promptSizeError(stdinText.bytes, requestId);
  return stdinText.text;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const requestId = createRequestId();
  const parsed = parseArgs(args);

  if (parsed.version) {
    console.log(VERSION);
    return 0;
  }
  if (parsed.help || args.length === 0) {
    console.log(HELP);
    return 0;
  }
  if (parsed.error !== undefined) {
    printError(new GatewayError('INVALID_ARGUMENT', parsed.error, undefined, { requestId }), parsed.json, requestId);
    if (!parsed.json) {
      console.error('Run "firstmate-gateway --help" for usage.');
    }
    return 2;
  }

  const gateway = dependencies.gateway ?? new Gateway();
  const stdin = dependencies.stdin ?? process.stdin;
  try {
    switch (parsed.command) {
      case 'targets':
        printTargets(await gateway.listTargets({ requestId }), parsed.json);
        return 0;
      case 'status':
        printStatus(await gateway.getStatus(parsed.target as string, { requestId }), parsed.json);
        return 0;
      case 'doctor': {
        const report = await gateway.doctor({ requestId });
        printDoctor(report, parsed.json);
        return report.ok ? 0 : 1;
      }
      case 'send': {
        const message = await resolvePrompt(parsed, stdin, requestId);
        const result = await gateway.sendPrompt({ target: parsed.target as string, message }, { requestId });
        printSend(result, parsed.json);
        return 0;
      }
      case 'read': {
        const input: ReadInput = {
          target: parsed.target as string,
          ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
          ...(parsed.source === undefined ? {} : { source: parsed.source }),
          ...(parsed.count === undefined ? {} : { count: parsed.count }),
        };
        const result = await gateway.read(input, { requestId });
        printRead(result, parsed.json);
        return 0;
      }
    }
  } catch (error) {
    const gatewayError = withRequestId(error, requestId);
    printError(gatewayError, parsed.json, requestId);
    return gatewayError.code === 'INVALID_ARGUMENT' ? 2 : 1;
  }

  return 2;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }

  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main();
}
