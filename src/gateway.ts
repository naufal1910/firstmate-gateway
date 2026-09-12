import { randomUUID } from 'node:crypto';

import { loadConfigFile, type GatewayConfig, type TargetConfig } from './config.js';
import { GatewayError, type SafeErrorDetails, withRequestId } from './errors.js';
import {
  HerdrCompatibilityError,
  HerdrError,
  HerdrSocketClient,
  type HerdrAgent,
} from './herdr/protocol.js';
import {
  HerdrSessionLocator,
  type HerdrSessionEndpoint,
  type HerdrSessionInfo,
} from './herdr/session.js';
import { resolveTarget, type ResolvedTarget } from './target.js';

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
  readonly createClient?: (endpoint: HerdrSessionEndpoint) => HerdrSocketClient;
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
  private readonly createClient: (endpoint: HerdrSessionEndpoint) => HerdrSocketClient;

  public constructor(dependencies: GatewayDependencies = {}) {
    this.config = dependencies.config;
    this.configPath = dependencies.configPath;
    this.suppliedLocator = dependencies.sessionLocator;
    this.createClient = dependencies.createClient ?? ((endpoint) => new HerdrSocketClient({ socketPath: endpoint.socketPath }));
  }

  public listTargets(options: GatewayInvocationOptions = {}): Promise<readonly TargetSummary[]> {
    return runGatewayOperation(options.requestId, () => this.listTargetsOperation());
  }

  public getStatus(alias: string, options: GatewayInvocationOptions = {}): Promise<TargetStatus> {
    return runGatewayOperation(options.requestId, () => this.getStatusOperation(alias));
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
    if (alias.length === 0) {
      throw new GatewayError('INVALID_ARGUMENT', 'target alias must not be empty');
    }
    const config = await this.getConfig();
    const target = config.targets[alias];
    if (target === undefined) {
      throw new GatewayError('TARGET_NOT_CONFIGURED', 'target alias is not configured');
    }
    return { config, target };
  }

  private async getAgents(target: TargetConfig): Promise<{ readonly client: HerdrSocketClient; readonly agents: readonly HerdrAgent[] }> {
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
