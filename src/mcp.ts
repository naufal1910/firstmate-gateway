import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  DEFAULT_READ_LINES,
  DEFAULT_READ_SOURCE,
  MAX_PROMPT_BYTES,
  MAX_READ_LINES,
  MIN_READ_LINES,
  type Gateway,
  type ReadResult,
  type TargetStatus,
  type TargetSummary,
} from './gateway.js';
import { GATEWAY_ERROR_CODES, GatewayError, withRequestId, type GatewayErrorCode } from './errors.js';

export const MCP_TOOL_NAMES = [
  'firstmate_list',
  'firstmate_status',
  'firstmate_send',
  'firstmate_read',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

const TARGET_ALIAS = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);

const REQUEST_ID = z.string().min(1).max(128);
const MAX_MCP_TEXT_BYTES = 1024 * 1024;
const boundedText = z.string().max(MAX_MCP_TEXT_BYTES).refine(
  (value) => Buffer.byteLength(value, 'utf8') <= MAX_MCP_TEXT_BYTES,
  { message: `text must be at most ${MAX_MCP_TEXT_BYTES} UTF-8 bytes` },
);
const AGENT_STATUS = z.enum(['idle', 'working', 'blocked', 'done', 'unknown']);
const READ_SOURCE = z.enum(['visible', 'recent', 'recent-unwrapped', 'detection']);
const READ_FORMAT = z.enum(['text', 'ansi']);
const SAFE_DETAIL = z.union([z.boolean(), z.number(), z.string(), z.null()]);
const SAFE_DETAILS = z.record(z.string().max(64), SAFE_DETAIL).refine(
  (details) => Object.keys(details).length <= 16,
  { message: 'details must contain at most 16 fields' },
);

const errorSchema = z.object({
  code: z.enum(GATEWAY_ERROR_CODES),
  message: z.string().min(1).max(512),
  requestId: REQUEST_ID,
  details: SAFE_DETAILS.optional(),
}).strict();

const listInputSchema = z.object({}).strict();
const statusInputSchema = z.object({ target: TARGET_ALIAS }).strict();
const sendInputSchema = z.object({
  target: TARGET_ALIAS,
  message: z
    .string()
    .min(1)
    .max(MAX_PROMPT_BYTES)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_BYTES, {
      message: `message must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes`,
    }),
}).strict();
const readInputSchema = z.object({
  target: TARGET_ALIAS,
  mode: z.enum(['raw', 'semantic']).default('raw'),
  source: READ_SOURCE.optional(),
  count: z.number().int().min(MIN_READ_LINES).max(MAX_READ_LINES).optional(),
}).strict().superRefine((input, context) => {
  if (input.mode === 'semantic' && (input.source !== undefined || input.count !== undefined)) {
    context.addIssue({ code: 'custom', message: 'source and count are only valid for raw mode' });
  }
});

const listDataSchema = z.object({
  requestId: REQUEST_ID,
  targets: z.array(z.object({
    target: TARGET_ALIAS,
    agent: z.string().min(1).max(64),
  }).strict()).max(256),
}).strict();
const statusDataSchema = z.object({
  target: TARGET_ALIAS,
  resolved: z.literal(true),
  state: AGENT_STATUS,
  requestId: REQUEST_ID,
}).strict();
const sendDataSchema = z.object({
  target: TARGET_ALIAS,
  accepted: z.literal(true),
  requestId: REQUEST_ID,
  observedState: AGENT_STATUS,
}).strict();
const rawReadDataSchema = z.object({
  target: TARGET_ALIAS,
  mode: z.literal('raw'),
  requestId: REQUEST_ID,
  source: READ_SOURCE,
  format: READ_FORMAT,
  text: boundedText,
  revision: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();
const semanticReadDataSchema = z.object({
  target: TARGET_ALIAS,
  mode: z.literal('semantic'),
  requestId: REQUEST_ID,
  provider: z.string().min(1).max(128),
  text: boundedText,
}).strict();

const envelope = <Data extends z.ZodTypeAny>(data: Data) => {
  const nullableData: z.ZodTypeAny = data.nullable();
  return z.object({
    ok: z.boolean(),
    data: nullableData,
    error: errorSchema.nullable(),
  }).strict().refine((value: { readonly ok: boolean; readonly data: unknown; readonly error: unknown }) => value.ok
    ? value.data !== null && value.error === null
    : value.data === null && value.error !== null, {
  message: 'MCP result must contain exactly one of data or error',
  });
};

export const MCP_SCHEMAS = Object.freeze({
  firstmate_list: Object.freeze({ input: listInputSchema, output: envelope(listDataSchema) }),
  firstmate_status: Object.freeze({ input: statusInputSchema, output: envelope(statusDataSchema) }),
  firstmate_send: Object.freeze({ input: sendInputSchema, output: envelope(sendDataSchema) }),
  firstmate_read: Object.freeze({
    input: readInputSchema,
    output: envelope(z.discriminatedUnion('mode', [rawReadDataSchema, semanticReadDataSchema])),
  }),
});

export type GatewayForMcp = Pick<Gateway, 'listTargets' | 'getStatus' | 'sendPrompt' | 'read'>;

type McpEnvelope = {
  readonly ok: true;
  readonly data: Record<string, unknown>;
  readonly error: null;
} | {
  readonly ok: false;
  readonly data: null;
  readonly error: ReturnType<GatewayError['toJSON']>;
};

function requestIdOf(value: string | number): string {
  return String(value);
}

function success(data: Record<string, unknown>): CallToolResult {
  const result: McpEnvelope = { ok: true, data, error: null };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function publicError(error: unknown, requestId: string): ReturnType<GatewayError['toJSON']> {
  const gatewayError = withRequestId(error, requestId);
  const details = gatewayError.details;
  const safeDetails = details === undefined
    ? undefined
    : Object.fromEntries(Object.entries(details).filter(([key]) =>
      key === 'limitBytes' || key === 'promptBytes' || key === 'reason' ||
      key === 'requestedSource' || key === 'returnedSource'));
  return {
    code: gatewayError.code,
    message: gatewayError.message,
    requestId: gatewayError.requestId,
    ...(safeDetails === undefined || Object.keys(safeDetails).length === 0 ? {} : { details: safeDetails }),
  };
}

function failure(error: unknown, requestId: string): CallToolResult {
  const result: McpEnvelope = { ok: false, data: null, error: publicError(error, requestId) };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  };
}

function callRequestId(requestId: string | number): string {
  return requestIdOf(requestId);
}

function listData(targets: readonly TargetSummary[], requestId: string): Record<string, unknown> {
  return {
    requestId,
    targets: targets.map((target) => ({ target: target.target, agent: target.agent })),
  };
}

function statusData(status: TargetStatus, requestId: string): Record<string, unknown> {
  return {
    target: status.target,
    resolved: true,
    state: status.state,
    requestId,
  };
}

function readData(result: ReadResult): Record<string, unknown> {
  if (Buffer.byteLength(result.text, 'utf8') > MAX_MCP_TEXT_BYTES) {
    throw new GatewayError(
      result.mode === 'raw' ? 'READ_FAILED' : 'SEMANTIC_OUTPUT_UNAVAILABLE',
      'MCP output exceeds the bounded text limit',
      { limitBytes: MAX_MCP_TEXT_BYTES },
    );
  }
  if (result.mode === 'raw') {
    return {
      target: result.target,
      mode: result.mode,
      requestId: result.requestId,
      source: result.source,
      format: result.format,
      text: result.text,
      revision: result.revision,
      truncated: result.truncated,
    };
  }
  return {
    target: result.target,
    mode: result.mode,
    requestId: result.requestId,
    provider: result.provider,
    text: result.text,
  };
}

/**
 * Creates the client-neutral MCP adapter. The adapter has no Herdr access; all
 * operations are delegated to the supplied Gateway Core instance.
 */
export function createMcpServer(gateway: GatewayForMcp): McpServer {
  const server = new McpServer(
    { name: 'firstmate-gateway', version: '0.4.0' },
    { capabilities: {} },
  );

  server.registerTool('firstmate_list', {
    title: 'List FirstMate targets',
    description: 'List configured logical FirstMate targets using safe public metadata.',
    inputSchema: listInputSchema,
    outputSchema: MCP_SCHEMAS.firstmate_list.output,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (_input, extra) => {
    const requestId = callRequestId(extra.mcpReq.id);
    try {
      return success(listData(await gateway.listTargets({ requestId }), requestId));
    } catch (error) {
      return failure(error, requestId);
    }
  });

  server.registerTool('firstmate_status', {
    title: 'Get FirstMate status',
    description: 'Resolve one logical target and report its live normalized status.',
    inputSchema: statusInputSchema,
    outputSchema: MCP_SCHEMAS.firstmate_status.output,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    const requestId = callRequestId(extra.mcpReq.id);
    try {
      return success(statusData(await gateway.getStatus(input.target, { requestId }), requestId));
    } catch (error) {
      return failure(error, requestId);
    }
  });

  server.registerTool('firstmate_send', {
    title: 'Send a FirstMate prompt',
    description: 'Side-effecting, non-idempotent prompt delivery. Accepted means delivered to FirstMate, not completed; uncertain delivery is never retried.',
    inputSchema: sendInputSchema,
    outputSchema: MCP_SCHEMAS.firstmate_send.output,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input, extra) => {
    const requestId = callRequestId(extra.mcpReq.id);
    try {
      const result = await gateway.sendPrompt(input, { requestId });
      return success({
        target: result.target,
        accepted: true,
        requestId: result.requestId,
        observedState: result.observedState,
      });
    } catch (error) {
      return failure(error, requestId);
    }
  });

  server.registerTool('firstmate_read', {
    title: 'Read FirstMate output',
    description: 'Read bounded raw output or validated semantic output. Semantic unavailability never falls back to raw output.',
    inputSchema: readInputSchema,
    outputSchema: MCP_SCHEMAS.firstmate_read.output,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    const requestId = callRequestId(extra.mcpReq.id);
    try {
      const gatewayInput = {
        target: input.target,
        ...(input.mode === 'semantic' ? { mode: 'semantic' as const } : {
          mode: 'raw' as const,
          ...(input.source === undefined ? {} : { source: input.source }),
          ...(input.count === undefined ? {} : { count: input.count }),
        }),
      };
      return success(readData(await gateway.read(gatewayInput, { requestId })));
    } catch (error) {
      return failure(error, requestId);
    }
  });

  return server;
}

export type { GatewayErrorCode };
export { DEFAULT_READ_LINES, DEFAULT_READ_SOURCE };