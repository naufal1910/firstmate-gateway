import { randomUUID } from 'node:crypto';

import { loadConfigFile, type GatewayConfig, type TargetConfig } from './config.js';
import { GatewayError, type SafeErrorDetails, withRequestId } from './errors.js';
import {
  HerdrCompatibilityError,
  HerdrError,
  HerdrSocketClient,
  HerdrProtocolError,
  HerdrMalformedResponseError,
  HerdrTransportError,
  type AgentStatus,
  type HerdrAgent,
  type HerdrAgentClient,
  type HerdrRead,
  type ReadSource,
} from './herdr/protocol.js';
import {
  HerdrSessionLocator,
  type HerdrSessionEndpoint,
  type HerdrSessionInfo,
} from './herdr/session.js';
import { resolveTarget, type ResolvedTarget } from './target.js';
import {
  selectSemanticReader,
  type SemanticReaderProvider,
} from './semantic.js';

export const MAX_PROMPT_BYTES = 64 * 1024;
export const DEFAULT_READ_SOURCE: ReadSource = 'recent-unwrapped';
export const DEFAULT_READ_LINES = 120;
export const MIN_READ_LINES = 1;
export const MAX_READ_LINES = 1_000;
/** Aliases make the CLI/API terminology explicit without changing the wire contract. */
export const DEFAULT_READ_COUNT = DEFAULT_READ_LINES;
export const MIN_READ_COUNT = MIN_READ_LINES;
export const MAX_READ_COUNT = MAX_READ_LINES;

export type ReadMode = 'raw' | 'semantic';

export interface SendPromptInput {
  readonly target: string;
  readonly message: string;
}

export interface SendPromptResult {
  readonly target: string;
  readonly accepted: true;
  readonly requestId: string;
  readonly observedState: AgentStatus;
}

export interface ReadInput {
  readonly target: string;
  readonly mode?: ReadMode;
  readonly source?: ReadSource;
  /** Preferred API spelling; the CLI exposes this as --count. */
  readonly lines?: number;
  /** Compatibility alias for callers that use the CLI spelling in Core. */
  readonly count?: number;
}

export interface RawReadResult {
  readonly target: string;
  readonly mode: 'raw';
  readonly requestId: string;
  readonly source: ReadSource;
  readonly format: HerdrRead['format'];
  readonly text: string;
  readonly revision: number;
  readonly truncated: boolean;
}

export interface SemanticReadResult {
  readonly target: string;
  readonly mode: 'semantic';
  readonly requestId: string;
  readonly provider: string;
  readonly text: string;
}

export type ReadResult = RawReadResult | SemanticReadResult;

export interface TargetSummary {
  readonly target: string;
  readonly herdrSession: string;
  readonly agent: string;
}

export interface TargetStatus {
  readonly target: string;
  readonly state: ResolvedTarget['state'];
  readonly resolved: true;
  readonly evidence: ResolvedTarget['evidence'];
  readonly diagnostic?: string;
}

export interface DoctorCheck {
  readonly name: 'configuration' | 'executable' | 'session' | 'socket' | 'protocol' | 'target';
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly requestId?: string;
  readonly details?: SafeErrorDetails;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export interface GatewayDependencies {
  readonly config?: GatewayConfig;
  readonly configPath?: string;
  readonly sessionLocator?: HerdrSessionLocator;
  readonly createClient?: (endpoint: HerdrSessionEndpoint) => HerdrAgentClient;
  readonly semanticProviders?: readonly SemanticReaderProvider[];
  /** Convenience form for a single validated semantic provider. */
  readonly semanticReader?: SemanticReaderProvider;
}

export interface GatewayInvocationOptions {
  /** An opaque ID for this Gateway operation; never use prompt or output content. */
  readonly requestId?: string;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof GatewayError
    ? error.code
    : error instanceof HerdrError
      ? error.code
      : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected failure';
}

function errorDetails(error: unknown): SafeErrorDetails | undefined {
  if (error instanceof GatewayError) return error.details;
  if (error instanceof HerdrError) return { reason: error.code.toLowerCase() };
  return undefined;
}

function isHerdrCompatibilityError(error: unknown): boolean {
  return error instanceof HerdrCompatibilityError || (error instanceof HerdrError && error.code === 'HERDR_INCOMPATIBLE');
}

function mapHerdrError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (isHerdrCompatibilityError(error)) {
    return new GatewayError('HERDR_INCOMPATIBLE', 'Herdr protocol compatibility validation failed', undefined, {
      cause: error,
    });
  }
  if (error instanceof HerdrError) {
    const code = error.code === 'HERDR_MALFORMED_RESPONSE' || error.code === 'HERDR_PROTOCOL_ERROR'
      ? 'HERDR_INCOMPATIBLE'
      : 'HERDR_UNAVAILABLE';
    return new GatewayError(code, code === 'HERDR_INCOMPATIBLE'
      ? 'Herdr protocol compatibility validation failed'
      : 'Herdr socket communication failed', {
      reason: error.code.toLowerCase(),
    }, { cause: error });
  }
  return new GatewayError('INTERNAL_ERROR', 'unexpected Gateway failure', undefined, {
    cause: error instanceof Error ? error : undefined,
  });
}

const BLOCKED_REMOTE_CODES = new Set([
  'blocked',
  'target_blocked',
  'agent_blocked',
  'pane_blocked',
]);

const UNCERTAIN_REMOTE_CODES = new Set([
  'timeout',
  'timed_out',
  'request_timeout',
  'delivery_uncertain',
  'uncertain_delivery',
  'agent_prompt_stalled',
]);

function looksUncertain(error: unknown): boolean {
  return error instanceof Error && /(?:timed? ?out|timeout|uncertain|connection reset|connection closed)/i.test(error.message);
}

export function isReadSource(value: unknown): value is ReadSource {
  return value === 'visible' || value === 'recent' || value === 'recent-unwrapped' || value === 'detection';
}

function invalidArgument(message: string): GatewayError {
  return new GatewayError('INVALID_ARGUMENT', message);
}

function validateTargetAlias(alias: unknown): asserts alias is string {
  if (typeof alias !== 'string' || alias.length === 0) {
    throw invalidArgument('target alias must not be empty');
  }
}

function validateSendInput(input: SendPromptInput): void {
  if (typeof input !== 'object' || input === null) {
    throw invalidArgument('send input must be an object');
  }
  validateTargetAlias(input.target);
  if (typeof input.message !== 'string') {
    throw invalidArgument('prompt message must be a string');
  }
  if (input.message.length === 0) {
    throw invalidArgument('prompt message must not be empty');
  }
  const promptBytes = Buffer.byteLength(input.message, 'utf8');
  if (promptBytes > MAX_PROMPT_BYTES) {
    throw new GatewayError('PROMPT_TOO_LARGE', `prompt exceeds the ${MAX_PROMPT_BYTES}-byte limit`, {
      limitBytes: MAX_PROMPT_BYTES,
      promptBytes,
    });
  }
}

interface NormalizedRawReadInput {
  readonly mode: 'raw';
  readonly source: ReadSource;
  readonly lines: number;
}

interface NormalizedSemanticReadInput {
  readonly mode: 'semantic';
}

type NormalizedReadInput = NormalizedRawReadInput | NormalizedSemanticReadInput;

function normalizeReadInput(input: ReadInput): NormalizedReadInput {
  if (typeof input !== 'object' || input === null) {
    throw invalidArgument('read input must be an object');
  }
  validateTargetAlias(input.target);

  const mode = input.mode ?? 'raw';
  if (mode !== 'raw' && mode !== 'semantic') {
    throw invalidArgument('read mode must be raw or semantic');
  }

  const hasSource = input.source !== undefined;
  if (hasSource && !isReadSource(input.source)) {
    throw invalidArgument('read source is unsupported');
  }

  const hasLines = input.lines !== undefined;
  const hasCount = input.count !== undefined;
  if (hasLines && hasCount && input.lines !== input.count) {
    throw invalidArgument('read lines and count must match when both are provided');
  }
  const requestedLines = input.lines ?? input.count;

  if (mode === 'semantic') {
    if (hasSource || hasLines || hasCount) {
      throw invalidArgument('raw read options cannot be used with semantic mode');
    }
    return { mode: 'semantic' };
  }

  const lines = requestedLines ?? DEFAULT_READ_LINES;
  if (!Number.isSafeInteger(lines) || lines < MIN_READ_LINES || lines > MAX_READ_LINES) {
    throw invalidArgument(`read line count must be an integer from ${MIN_READ_LINES} to ${MAX_READ_LINES}`);
  }

  return {
    mode: 'raw',
    source: input.source ?? DEFAULT_READ_SOURCE,
    lines,
  };
}

function mapPromptError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof HerdrProtocolError) {
    const remoteCode = error.remoteCode.toLowerCase();
    if (BLOCKED_REMOTE_CODES.has(remoteCode)) {
      return new GatewayError('TARGET_BLOCKED', 'the resolved target is blocked by Herdr', {
        reason: 'target_blocked',
      }, { cause: error });
    }
    if (UNCERTAIN_REMOTE_CODES.has(remoteCode)) {
      return new GatewayError('PROMPT_DELIVERY_UNCERTAIN', 'prompt delivery outcome is uncertain; no retry was attempted', {
        reason: 'herdr_timeout',
      }, { cause: error });
    }
    return new GatewayError('PROMPT_DELIVERY_FAILED', 'Herdr rejected prompt delivery', {
      reason: 'herdr_rejected',
    }, { cause: error });
  }
  if (error instanceof HerdrTransportError || error instanceof HerdrMalformedResponseError) {
    return new GatewayError('PROMPT_DELIVERY_UNCERTAIN', 'prompt delivery outcome is uncertain; no retry was attempted', {
      reason: error instanceof HerdrTransportError ? 'transport_uncertain' : 'malformed_response',
    }, { cause: error });
  }
  if (error instanceof HerdrError) {
    return new GatewayError('PROMPT_DELIVERY_FAILED', 'prompt delivery could not be completed', {
      reason: 'herdr_error',
    }, { cause: error });
  }
  if (looksUncertain(error)) {
    return new GatewayError('PROMPT_DELIVERY_UNCERTAIN', 'prompt delivery outcome is uncertain; no retry was attempted', {
      reason: 'uncertain_error',
    }, { cause: error instanceof Error ? error : undefined });
  }
  return new GatewayError('PROMPT_DELIVERY_FAILED', 'prompt delivery could not be completed', {
    reason: 'unexpected_error',
  }, { cause: error instanceof Error ? error : undefined });
}

function mapReadError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof HerdrCompatibilityError) {
    return new GatewayError('HERDR_INCOMPATIBLE', 'Herdr protocol compatibility validation failed', undefined, {
      cause: error,
    });
  }
  if (error instanceof HerdrError) {
    return new GatewayError('READ_FAILED', 'Herdr raw output read failed', {
      reason: error instanceof HerdrProtocolError ? 'herdr_rejected' : error.code.toLowerCase(),
    }, { cause: error });
  }
  return new GatewayError('READ_FAILED', 'raw output read failed', {
    reason: 'unexpected_error',
  }, { cause: error instanceof Error ? error : undefined });
}

async function runGatewayOperation<T>(
  requestId: string | undefined,
  operation: (operationRequestId: string) => Promise<T>,
): Promise<T> {
  const operationRequestId = requestId ?? createRequestId();
  try {
    return await operation(operationRequestId);
  } catch (error) {
    throw withRequestId(error, operationRequestId);
  }
}

export class Gateway {
  private readonly config: GatewayConfig | undefined;
  private readonly configPath: string | undefined;
  private readonly suppliedLocator: HerdrSessionLocator | undefined;
  private readonly createClient: (endpoint: HerdrSessionEndpoint) => HerdrAgentClient;
  private readonly semanticProviders: readonly SemanticReaderProvider[];

  public constructor(dependencies: GatewayDependencies = {}) {
    this.config = dependencies.config;
    this.configPath = dependencies.configPath;
    this.suppliedLocator = dependencies.sessionLocator;
    this.createClient = dependencies.createClient ?? ((endpoint) => new HerdrSocketClient({ socketPath: endpoint.socketPath }));
    this.semanticProviders = Object.freeze([
      ...(dependencies.semanticProviders ?? []),
      ...(dependencies.semanticReader === undefined ? [] : [dependencies.semanticReader]),
    ]);
  }

  public listTargets(options: GatewayInvocationOptions = {}): Promise<readonly TargetSummary[]> {
    return runGatewayOperation(options.requestId, () => this.listTargetsOperation());
  }

  public getStatus(alias: string, options: GatewayInvocationOptions = {}): Promise<TargetStatus> {
    return runGatewayOperation(options.requestId, () => this.getStatusOperation(alias));
  }

  public sendPrompt(
    input: SendPromptInput,
    options: GatewayInvocationOptions = {},
  ): Promise<SendPromptResult> {
    return runGatewayOperation(options.requestId, (requestId) => this.sendPromptOperation(input, requestId));
  }

  public read(input: ReadInput, options: GatewayInvocationOptions = {}): Promise<ReadResult> {
    return runGatewayOperation(options.requestId, (requestId) => this.readOperation(input, requestId));
  }

  public doctor(options: GatewayInvocationOptions = {}): Promise<DoctorReport> {
    return runGatewayOperation(options.requestId, (requestId) => this.doctorOperation(requestId));
  }

  private async listTargetsOperation(): Promise<readonly TargetSummary[]> {
    const config = await this.getConfig();
    return Object.values(config.targets).map((target) => ({
      target: target.alias,
      herdrSession: target.herdrSession,
      agent: target.agent,
    }));
  }

  private async getStatusOperation(alias: string): Promise<TargetStatus> {
    const { config, target } = await this.getTarget(alias);
    const { agents } = await this.getAgents(target);
    const resolved = resolveTarget(target, agents);
    return {
      target: config.targets[alias]?.alias ?? alias,
      state: resolved.state,
      resolved: true,
      evidence: resolved.evidence,
      ...(resolved.rawState === undefined ? {} : { diagnostic: `runtime status: ${resolved.rawState}` }),
    };
  }

  private async sendPromptOperation(input: SendPromptInput, requestId: string): Promise<SendPromptResult> {
    validateSendInput(input);
    const { target } = await this.getTarget(input.target);

    // This is intentionally the last Gateway step before agent.prompt. The
    // resolved pane is runtime-only and is never accepted from the caller.
    const { client, agents } = await this.getAgents(target);
    const resolved = resolveTarget(target, agents);
    if (resolved.state === 'blocked') {
      throw new GatewayError('TARGET_BLOCKED', 'the resolved target is blocked');
    }

    try {
      const prompted = await client.prompt(resolved.paneId, input.message);
      return {
        target: target.alias,
        accepted: true,
        requestId,
        observedState: prompted.agentStatus,
      };
    } catch (error) {
      throw mapPromptError(error);
    }
  }

  private async readOperation(input: ReadInput, requestId: string): Promise<ReadResult> {
    const normalized = normalizeReadInput(input);
    const { target } = await this.getTarget(input.target);

    if (normalized.mode === 'semantic') {
      return this.readSemantic(target, requestId);
    }

    // As with send, target discovery is deliberately performed immediately
    // before the structured agent.read call. No pane identity is cached.
    const { client, agents } = await this.getAgents(target);
    const resolved = resolveTarget(target, agents);
    let read: HerdrRead;
    try {
      read = await client.read(resolved.paneId, {
        source: normalized.source,
        lines: normalized.lines,
      });
    } catch (error) {
      throw mapReadError(error);
    }

    if (read.source !== normalized.source) {
      throw new GatewayError('READ_FAILED', 'Herdr returned a different raw read source', {
        reason: 'source_mismatch',
        requestedSource: normalized.source,
        returnedSource: read.source,
      });
    }

    return {
      target: target.alias,
      mode: 'raw',
      requestId,
      source: read.source,
      format: read.format,
      text: read.text,
      revision: read.revision,
      truncated: read.truncated,
    };
  }

  private async readSemantic(target: TargetConfig, requestId: string): Promise<SemanticReadResult> {
    let provider: SemanticReaderProvider | undefined;
    try {
      provider = selectSemanticReader(this.semanticProviders, target);
    } catch (error) {
      throw new GatewayError('SEMANTIC_OUTPUT_UNAVAILABLE', 'semantic output is unavailable for this target', {
        reason: 'provider_selection_failed',
      }, { cause: error instanceof Error ? error : undefined });
    }
    if (provider === undefined) {
      throw new GatewayError('SEMANTIC_OUTPUT_UNAVAILABLE', 'semantic output is unavailable for this target', {
        reason: 'no_validated_provider',
      });
    }

    const { agents } = await this.getAgents(target);
    const resolved = resolveTarget(target, agents);
    try {
      const result = await provider.read({ target, resolvedTarget: resolved, requestId });
      if (typeof result.text !== 'string') {
        throw new Error('semantic provider returned a non-string result');
      }
      return {
        target: target.alias,
        mode: 'semantic',
        requestId,
        provider: provider.name,
        text: result.text,
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('SEMANTIC_OUTPUT_UNAVAILABLE', 'semantic output is unavailable for this target', {
        reason: 'provider_read_failed',
      }, { cause: error instanceof Error ? error : undefined });
    }
  }

  private async doctorOperation(requestId: string): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const report = (): DoctorReport => ({
      ok: checks.every((check) => check.ok),
      checks: checks.map((check) => check.ok ? check : { ...check, requestId }),
    });
    let config: GatewayConfig;
    try {
      config = await this.getConfig();
      checks.push({ name: 'configuration', ok: true, message: 'configuration is valid' });
    } catch (error) {
      const details = errorDetails(error);
      checks.push({
        name: 'configuration',
        ok: false,
        code: errorCode(error) ?? 'CONFIG_INVALID',
        message: errorMessage(error),
        ...(details === undefined ? {} : { details }),
      });
      return report();
    }

    const locator = this.getLocator();
    let sessions: readonly HerdrSessionInfo[] = [];
    let discoveryFailure: GatewayError | undefined;
    try {
      sessions = await locator.discover();
      checks.push({ name: 'executable', ok: true, message: 'Herdr executable is available' });
    } catch (error) {
      const mapped = mapHerdrError(error);
      if (mapped.code === 'HERDR_INCOMPATIBLE') {
        checks.push({ name: 'executable', ok: true, message: 'Herdr executable is available' });
        checks.push({
          name: 'session',
          ok: false,
          code: mapped.code,
          message: `Herdr session discovery is incompatible: ${errorMessage(mapped)}`,
          ...(mapped.details === undefined ? {} : { details: mapped.details }),
        });
        discoveryFailure = mapped;
      } else {
        checks.push({
          name: 'executable',
          ok: false,
          code: mapped.code,
          message: errorMessage(mapped),
          ...(mapped.details === undefined ? {} : { details: mapped.details }),
        });
        return report();
      }
    }

    const targets = Object.values(config.targets);
    const uniqueSessions = [...new Set(targets.map((target) => target.herdrSession))];
    const endpoints = new Map<string, HerdrSessionEndpoint>();
    const sessionFailures = new Map<string, GatewayError>();
    const runtimeFailures = new Map<string, GatewayError>();
    for (const sessionName of uniqueSessions) {
      try {
        const endpoint = locator.getSessionFromDiscovery(sessions, sessionName);
        endpoints.set(sessionName, endpoint);
        checks.push({ name: 'session', ok: true, message: `Herdr session ${sessionName} is running` });
      } catch (error) {
        const mapped = mapHerdrError(error);
        sessionFailures.set(sessionName, mapped);
        checks.push({
          name: 'session',
          ok: false,
          code: mapped.code,
          message: errorMessage(mapped),
          ...(mapped.details === undefined ? {} : { details: mapped.details }),
        });
      }
    }

    for (const [sessionName, endpoint] of endpoints) {
      try {
        await locator.validateSocketPath(endpoint.socketPath);
      } catch (error) {
        const mapped = mapHerdrError(error);
        endpoints.delete(sessionName);
        runtimeFailures.set(sessionName, mapped);
        checks.push({
          name: 'socket',
          ok: false,
          code: mapped.code,
          message: errorMessage(mapped),
          ...(mapped.details === undefined ? {} : { details: mapped.details }),
        });
        continue;
      }

      const client = this.createClient(endpoint);
      try {
        await client.ping();
        checks.push({ name: 'socket', ok: true, message: `Herdr socket responds for ${sessionName}` });
      } catch (error) {
        const mapped = mapHerdrError(error);
        endpoints.delete(sessionName);
        runtimeFailures.set(sessionName, mapped);
        checks.push({
          name: 'socket',
          ok: false,
          code: mapped.code,
          message: errorMessage(mapped),
          ...(mapped.details === undefined ? {} : { details: mapped.details }),
        });
        continue;
      }

      try {
        await client.probeCompatibility();
        checks.push({ name: 'protocol', ok: true, message: `Herdr protocol is compatible for ${sessionName}` });
      } catch (error) {
        const mapped = mapHerdrError(error);
        checks.push({
          name: 'protocol',
          ok: false,
          code: mapped.code,
          message: errorMessage(mapped),
          ...(mapped.details === undefined ? {} : { details: mapped.details }),
        });
      }
    }

    for (const target of targets) {
      const endpoint = endpoints.get(target.herdrSession);
      if (endpoint === undefined) {
        const failure = discoveryFailure ?? runtimeFailures.get(target.herdrSession) ?? sessionFailures.get(target.herdrSession);
        const code = failure?.code ?? 'HERDR_SESSION_NOT_FOUND';
        const details = failure?.details;
        checks.push({
          name: 'target',
          ok: false,
          code,
          message: `target ${target.alias} could not be checked because its session is unavailable`,
          ...(details === undefined ? {} : { details }),
        });
        continue;
      }
      try {
        const agents = await this.createClient(endpoint).listAgents();
        resolveTarget(target, agents);
        checks.push({ name: 'target', ok: true, message: `target ${target.alias} resolves exactly once` });
      } catch (error) {
        const mapped = mapHerdrError(error);
        checks.push({
          name: 'target',
          ok: false,
          code: mapped.code,
          message: `target ${target.alias}: ${errorMessage(mapped)}`,
          ...(mapped.details === undefined ? {} : { details: mapped.details }),
        });
      }
    }

    return report();
  }

  private async getConfig(): Promise<GatewayConfig> {
    if (this.config !== undefined) return this.config;
    return loadConfigFile(this.configPath);
  }

  private getLocator(): HerdrSessionLocator {
    return this.suppliedLocator ?? new HerdrSessionLocator();
  }

  private async getTarget(alias: string): Promise<{ readonly config: GatewayConfig; readonly target: TargetConfig }> {
    validateTargetAlias(alias);
    const config = await this.getConfig();
    const target = config.targets[alias];
    if (target === undefined) {
      throw new GatewayError('TARGET_NOT_CONFIGURED', 'target alias is not configured');
    }
    return { config, target };
  }

  private async getAgents(target: TargetConfig): Promise<{ readonly client: HerdrAgentClient; readonly agents: readonly HerdrAgent[] }> {
    const locator = this.getLocator();
    let endpoint: HerdrSessionEndpoint;
    try {
      endpoint = await locator.locate(target.herdrSession);
    } catch (error) {
      throw mapHerdrError(error);
    }

    const client = this.createClient(endpoint);
    try {
      return { client, agents: await client.listAgents() };
    } catch (error) {
      throw mapHerdrError(error);
    }
  }
}

export function createRequestId(): string {
  return randomUUID();
}
