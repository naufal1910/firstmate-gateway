import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

export const EXPECTED_HERDR_PROTOCOL = 20;

const READ_SOURCES = ['visible', 'recent', 'recent-unwrapped', 'detection'] as const;
const READ_FORMATS = ['text', 'ansi'] as const;
const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const;
const EXPECTED_PROBE_REJECTIONS = new Set(['agent_not_found', 'target_not_found']);
const MISSING_METHOD_CODES = new Set([
  'method_not_found',
  'unknown_method',
  'unsupported_method',
  'not_implemented',
]);

export type ReadSource = (typeof READ_SOURCES)[number];
export type ReadFormat = (typeof READ_FORMATS)[number];
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type RequiredHerdrMethod = 'ping' | 'agent.list' | 'agent.prompt' | 'agent.read';

export interface HerdrRequest {
  readonly id: string;
  readonly method: RequiredHerdrMethod;
  readonly params: Record<string, unknown>;
}

export interface HerdrPing {
  readonly type: 'pong';
  readonly version: string;
  readonly protocol: number;
  readonly capabilities: Readonly<Record<string, unknown>> | null;
}

export interface HerdrAgent {
  readonly terminalId: string;
  readonly agentStatus: AgentStatus;
  readonly workspaceId: string;
  readonly tabId: string;
  /** Runtime-only address. It is never written by this package to configuration. */
  readonly paneId: string;
  readonly focused: boolean;
  readonly revision: number;
  readonly agent?: string;
  readonly cwd?: string;
  readonly foregroundCwd?: string;
}

export interface HerdrRead {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly source: ReadSource;
  readonly format: ReadFormat;
  readonly text: string;
  readonly revision: number;
  readonly truncated: boolean;
}

export interface AgentReadOptions {
  readonly source: ReadSource;
  readonly format?: ReadFormat;
  readonly lines?: number;
  readonly stripAnsi?: boolean;
}

export interface HerdrCompatibilityReport {
  readonly version: string;
  readonly protocol: number;
  readonly methods: Readonly<Record<RequiredHerdrMethod, 'supported'>>;
  readonly agentCount: number;
}

export type HerdrExchange = (request: HerdrRequest) => Promise<unknown>;

export interface HerdrSocketClientOptions {
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  readonly exchange?: HerdrExchange;
  readonly expectedProtocol?: number;
}

export class HerdrError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | 'HERDR_TRANSPORT_ERROR'
      | 'HERDR_PROTOCOL_ERROR'
      | 'HERDR_MALFORMED_RESPONSE'
      | 'HERDR_INCOMPATIBLE',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class HerdrTransportError extends HerdrError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'HERDR_TRANSPORT_ERROR', options);
  }
}

export class HerdrMalformedResponseError extends HerdrError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'HERDR_MALFORMED_RESPONSE', options);
  }
}

export class HerdrProtocolError extends HerdrError {
  public constructor(
    message: string,
    public readonly remoteCode: string,
    public readonly requestId: string,
  ) {
    super(message, 'HERDR_PROTOCOL_ERROR');
  }
}

export class HerdrCompatibilityError extends HerdrError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'HERDR_INCOMPATIBLE', options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string, context: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string') {
    throw new HerdrMalformedResponseError(`${context} is missing string field ${key}`);
  }
  return candidate;
}

function requiredBoolean(value: Record<string, unknown>, key: string, context: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== 'boolean') {
    throw new HerdrMalformedResponseError(`${context} is missing boolean field ${key}`);
  }
  return candidate;
}

function requiredNonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw new HerdrMalformedResponseError(`${context} is missing non-negative integer field ${key}`);
  }
  return candidate;
}

function optionalNullableString(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) {
    return undefined;
  }
  if (typeof candidate !== 'string') {
    throw new HerdrMalformedResponseError(`${context} has invalid string field ${key}`);
  }
  return candidate;
}

function parseObjectResponse(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HerdrMalformedResponseError(`${context} result must be an object`);
  }
  return value;
}

function parseAgent(value: unknown, context: string): HerdrAgent {
  const agent = parseObjectResponse(value, context);
  const status = requiredString(agent, 'agent_status', context);
  if (!(AGENT_STATUSES as readonly string[]).includes(status)) {
    throw new HerdrMalformedResponseError(`${context} has unsupported agent_status`);
  }

  const parsed: HerdrAgent = {
    terminalId: requiredString(agent, 'terminal_id', context),
    agentStatus: status as AgentStatus,
    workspaceId: requiredString(agent, 'workspace_id', context),
    tabId: requiredString(agent, 'tab_id', context),
    paneId: requiredString(agent, 'pane_id', context),
    focused: requiredBoolean(agent, 'focused', context),
    revision: requiredNonNegativeInteger(agent, 'revision', context),
  };

  const agentKind = optionalNullableString(agent, 'agent', context);
  const cwd = optionalNullableString(agent, 'cwd', context);
  const foregroundCwd = optionalNullableString(agent, 'foreground_cwd', context);

  return {
    ...parsed,
    ...(agentKind === undefined ? {} : { agent: agentKind }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(foregroundCwd === undefined ? {} : { foregroundCwd }),
  };
}

function parsePingResult(value: unknown): HerdrPing {
  const result = parseObjectResponse(value, 'ping');
  if (result.type !== 'pong') {
    throw new HerdrMalformedResponseError('ping result has unexpected type');
  }

  const protocol = requiredNonNegativeInteger(result, 'protocol', 'ping');
  const version = requiredString(result, 'version', 'ping');
  const capabilities = result.capabilities;
  if (capabilities !== undefined && capabilities !== null && !isRecord(capabilities)) {
    throw new HerdrMalformedResponseError('ping has invalid capabilities');
  }

  return {
    type: 'pong',
    version,
    protocol,
    capabilities: capabilities === undefined ? null : capabilities,
  };
}

function parseAgentListResult(value: unknown): readonly HerdrAgent[] {
  const result = parseObjectResponse(value, 'agent.list');
  if (result.type !== 'agent_list') {
    throw new HerdrMalformedResponseError('agent.list result has unexpected type');
  }
  if (!Array.isArray(result.agents)) {
    throw new HerdrMalformedResponseError('agent.list result is missing agents array');
  }
  return result.agents.map((agent, index) => parseAgent(agent, `agent.list agents[${index}]`));
}

function parsePromptResult(value: unknown): HerdrAgent {
  const result = parseObjectResponse(value, 'agent.prompt');
  if (result.type !== 'agent_prompted') {
    throw new HerdrMalformedResponseError('agent.prompt result has unexpected type');
  }
  return parseAgent(result.agent, 'agent.prompt agent');
}

function parseReadResult(value: unknown): HerdrRead {
  const result = parseObjectResponse(value, 'agent.read');
  if (result.type !== 'pane_read') {
    throw new HerdrMalformedResponseError('agent.read result has unexpected type');
  }
  const read = parseObjectResponse(result.read, 'agent.read read');
  const source = requiredString(read, 'source', 'agent.read read');
  if (!(READ_SOURCES as readonly string[]).includes(source)) {
    throw new HerdrMalformedResponseError('agent.read read has unsupported source');
  }
  const format = requiredString(read, 'format', 'agent.read read');
  if (!(READ_FORMATS as readonly string[]).includes(format)) {
    throw new HerdrMalformedResponseError('agent.read read has unsupported format');
  }

  return {
    paneId: requiredString(read, 'pane_id', 'agent.read read'),
    workspaceId: requiredString(read, 'workspace_id', 'agent.read read'),
    tabId: requiredString(read, 'tab_id', 'agent.read read'),
    source: source as ReadSource,
    format: format as ReadFormat,
    text: requiredString(read, 'text', 'agent.read read'),
    revision: requiredNonNegativeInteger(read, 'revision', 'agent.read read'),
    truncated: requiredBoolean(read, 'truncated', 'agent.read read'),
  };
}

function parseEnvelope(value: unknown, requestId: string): unknown {
  let envelope: unknown = value;
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope) as unknown;
    } catch (error) {
      throw new HerdrMalformedResponseError('Herdr returned invalid JSON', { cause: error });
    }
  }
  if (!isRecord(envelope)) {
    throw new HerdrMalformedResponseError('Herdr response must be an object');
  }

  const responseId = envelope.id;
  if (typeof responseId !== 'string' || responseId !== requestId) {
    throw new HerdrMalformedResponseError('Herdr response has an unexpected id');
  }

  const hasResult = Object.prototype.hasOwnProperty.call(envelope, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(envelope, 'error');
  if (hasResult === hasError) {
    throw new HerdrMalformedResponseError('Herdr response must contain exactly one result or error');
  }

  if (hasError) {
    const error = envelope.error;
    if (!isRecord(error)) {
      throw new HerdrMalformedResponseError('Herdr error response must be an object');
    }
    const remoteCode = requiredString(error, 'code', 'Herdr error');
    const message = requiredString(error, 'message', 'Herdr error');
    throw new HerdrProtocolError(message, remoteCode, requestId);
  }

  return envelope.result;
}

function validateTarget(target: string): void {
  if (target.length === 0) {
    throw new HerdrCompatibilityError('Herdr target must not be empty');
  }
}

function validateReadOptions(options: AgentReadOptions): void {
  if (!(READ_SOURCES as readonly string[]).includes(options.source)) {
    throw new HerdrCompatibilityError('Herdr read source is unsupported');
  }
  if (options.format !== undefined && !(READ_FORMATS as readonly string[]).includes(options.format)) {
    throw new HerdrCompatibilityError('Herdr read format is unsupported');
  }
  if (
    options.lines !== undefined &&
    (!Number.isSafeInteger(options.lines) || options.lines < 0)
  ) {
    throw new HerdrCompatibilityError('Herdr read line count must be a non-negative integer');
  }
  if (options.stripAnsi !== undefined && typeof options.stripAnsi !== 'boolean') {
    throw new HerdrCompatibilityError('Herdr strip_ansi option must be boolean');
  }
}

function isExpectedProbeRejection(error: HerdrProtocolError): boolean {
  return EXPECTED_PROBE_REJECTIONS.has(error.remoteCode);
}

function isMissingMethod(error: HerdrProtocolError): boolean {
  if (MISSING_METHOD_CODES.has(error.remoteCode)) {
    return true;
  }
  return (
    error.remoteCode === 'invalid_request' &&
    /unknown (?:variant|method)|unsupported method|method not found/i.test(error.message)
  );
}

function probeTarget(): string {
  return `firstmate-gw-compat-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

function closeSocket(socket: Socket, timer: NodeJS.Timeout): void {
  clearTimeout(timer);
  socket.removeAllListeners();
  socket.destroy();
}


export function createUnixSocketExchange(socketPath: string, timeoutMs = 5_000): HerdrExchange {
  if (socketPath.length === 0) {
    throw new HerdrTransportError('Herdr socket path must not be empty');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new HerdrTransportError('Herdr socket timeout must be a positive integer');
  }

  return (request) =>
    new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const socket = createConnection({ path: socketPath });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new HerdrTransportError(`Timed out talking to the Herdr socket`));
      }, timeoutMs);

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        closeSocket(socket, timer);
        callback();
      };

      socket.once('connect', () => {
        socket.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error !== null) {
            finish(() => reject(new HerdrTransportError('Failed to write to the Herdr socket', { cause: error })));
          }
        });
      });
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        finish(() => {
          try {
            resolve(JSON.parse(line) as unknown);
          } catch (error) {
            reject(new HerdrMalformedResponseError('Herdr returned invalid JSON', { cause: error }));
          }
        });
      });
      socket.once('error', (error) => {
        finish(() => reject(new HerdrTransportError('Unable to communicate with the Herdr socket', { cause: error })));
      });
      socket.once('close', () => {
        if (!settled) {
          finish(() => reject(new HerdrTransportError('Herdr socket closed before responding')));
        }
      });
    });
}

export class HerdrSocketClient {
  private readonly exchange: HerdrExchange;
  private readonly expectedProtocol: number;

  public constructor(options: HerdrSocketClientOptions) {
    if (options.exchange !== undefined && options.socketPath !== undefined) {
      throw new HerdrTransportError('Configure either exchange or socketPath, not both');
    }
    if (options.exchange === undefined && options.socketPath === undefined) {
      throw new HerdrTransportError('Herdr socketPath or exchange is required');
    }
    this.exchange = options.exchange ?? createUnixSocketExchange(options.socketPath as string, options.timeoutMs);
    this.expectedProtocol = options.expectedProtocol ?? EXPECTED_HERDR_PROTOCOL;
    if (!Number.isSafeInteger(this.expectedProtocol) || this.expectedProtocol < 0) {
      throw new HerdrCompatibilityError('Expected Herdr protocol must be a non-negative integer');
    }
  }

  public async ping(): Promise<HerdrPing> {
    const result = await this.call('ping', {});
    return parsePingResult(result);
  }

  public async listAgents(): Promise<readonly HerdrAgent[]> {
    const result = await this.call('agent.list', {});
    return parseAgentListResult(result);
  }

  public async prompt(target: string, text: string): Promise<HerdrAgent> {
    validateTarget(target);
    if (text.length === 0) {
      throw new HerdrCompatibilityError('Herdr prompt text must not be empty');
    }
    const result = await this.call('agent.prompt', { target, text });
    return parsePromptResult(result);
  }

  public async read(target: string, options: AgentReadOptions): Promise<HerdrRead> {
    validateTarget(target);
    validateReadOptions(options);
    const result = await this.call('agent.read', {
      target,
      source: options.source,
      ...(options.format === undefined ? {} : { format: options.format }),
      ...(options.lines === undefined ? {} : { lines: options.lines }),
      ...(options.stripAnsi === undefined ? {} : { strip_ansi: options.stripAnsi }),
    });
    return parseReadResult(result);
  }

  /**
   * Proves the four required methods without targeting a live agent. The prompt/read
   * checks use a freshly generated, valid-but-unconfigured agent name and accept the
   * server's normal `agent_not_found` response as evidence that the method exists.
   */
  public async probeCompatibility(): Promise<HerdrCompatibilityReport> {
    const ping = await this.probeCall('ping', () => this.ping());
    if (ping.protocol !== this.expectedProtocol) {
      throw new HerdrCompatibilityError(
        `Herdr protocol ${ping.protocol} is incompatible; expected ${this.expectedProtocol}`,
      );
    }

    const agents = await this.probeCall('agent.list', () => this.listAgents());
    const target = probeTarget();
    await this.proveAgentMethod('agent.prompt', { target, text: 'firstmate-gateway compatibility probe' }, (result) => {
      parsePromptResult(result);
    });
    await this.proveAgentMethod(
      'agent.read',
      { target, source: 'detection', format: 'text', lines: 1, strip_ansi: true },
      (result) => {
        parseReadResult(result);
      },
    );

    return {
      version: ping.version,
      protocol: ping.protocol,
      methods: {
        ping: 'supported',
        'agent.list': 'supported',
        'agent.prompt': 'supported',
        'agent.read': 'supported',
      },
      agentCount: agents.length,
    };
  }

  public probe(): Promise<HerdrCompatibilityReport> {
    return this.probeCompatibility();
  }

  private async call(method: RequiredHerdrMethod, params: Record<string, unknown>): Promise<unknown> {
    const request: HerdrRequest = { id: randomUUID(), method, params };
    let response: unknown;
    try {
      response = await this.exchange(request);
    } catch (error) {
      if (error instanceof HerdrError) throw error;
      throw new HerdrTransportError('Herdr exchange failed', { cause: error });
    }
    return parseEnvelope(response, request.id);
  }

  private async probeCall<T>(method: RequiredHerdrMethod, parse: () => Promise<T>): Promise<T> {
    try {
      return await parse();
    } catch (error) {
      if (error instanceof HerdrProtocolError && isMissingMethod(error)) {
        throw new HerdrCompatibilityError(`Herdr does not support required method ${method}`, {
          cause: error,
        });
      }
      if (error instanceof HerdrProtocolError) {
        throw new HerdrCompatibilityError(`Herdr rejected required method ${method}`, { cause: error });
      }
      if (error instanceof HerdrError) throw error;
      throw new HerdrCompatibilityError(`Unable to prove required method ${method}`, { cause: error });
    }
  }

  private async proveAgentMethod(
    method: 'agent.prompt' | 'agent.read',
    params: Record<string, unknown>,
    parseResult: (result: unknown) => void,
  ): Promise<void> {
    try {
      const result = await this.call(method, params);
      parseResult(result);
    } catch (error) {
      if (error instanceof HerdrProtocolError && isExpectedProbeRejection(error)) {
        return;
      }
      if (error instanceof HerdrProtocolError && isMissingMethod(error)) {
        throw new HerdrCompatibilityError(`Herdr does not support required method ${method}`, {
          cause: error,
        });
      }
      if (error instanceof HerdrError) {
        throw new HerdrCompatibilityError(`Herdr gave an incompatible response for ${method}`, {
          cause: error,
        });
      }
      throw new HerdrCompatibilityError(`Unable to prove required method ${method}`, { cause: error });
    }
  }
}
