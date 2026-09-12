import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';

import { GatewayError, type SafeErrorDetails } from '../errors.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const SESSION_LIST_ARGS = ['session', 'list', '--json'] as const;

export interface HerdrSessionInfo {
  readonly name: string;
  readonly running: boolean;
  readonly socketPath?: string;
}

export interface HerdrSessionEndpoint extends HerdrSessionInfo {
  readonly socketPath: string;
}

export interface HerdrCommandOptions {
  readonly shell: false;
  readonly timeoutMs: number;
}

export interface HerdrCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type HerdrCommandRunner = (
  executable: string,
  args: readonly string[],
  options: HerdrCommandOptions,
) => Promise<HerdrCommandResult>;

export type HerdrSocketValidator = (socketPath: string) => Promise<void>;

export interface HerdrSessionLocatorOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly run?: HerdrCommandRunner;
  readonly validateSocket?: HerdrSocketValidator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000');
}

function safeDiscoveryDetails(reason: string): SafeErrorDetails {
  return { reason };
}

function parseSessionList(source: string): readonly HerdrSessionInfo[] {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new GatewayError('HERDR_INCOMPATIBLE', 'Herdr session discovery returned invalid JSON', safeDiscoveryDetails('invalid_json'), {
      cause: error,
    });
  }

  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new GatewayError(
      'HERDR_INCOMPATIBLE',
      'Herdr session discovery returned an invalid session list',
      safeDiscoveryDetails('invalid_shape'),
    );
  }

  const sessions: HerdrSessionInfo[] = [];
  const names = new Set<string>();
  for (const [index, item] of value.sessions.entries()) {
    if (!isRecord(item) || !isNonEmptyString(item.name) || typeof item.running !== 'boolean') {
      throw new GatewayError(
        'HERDR_INCOMPATIBLE',
        `Herdr session discovery returned an invalid session entry at index ${index}`,
        safeDiscoveryDetails('invalid_entry'),
      );
    }
    if (names.has(item.name)) {
      throw new GatewayError(
        'HERDR_INCOMPATIBLE',
        'Herdr session discovery returned duplicate session names',
        safeDiscoveryDetails('duplicate_session'),
      );
    }
    names.add(item.name);

    const socketPathValue = item.socket_path;
    if (socketPathValue !== undefined && !isNonEmptyString(socketPathValue)) {
      throw new GatewayError(
        'HERDR_INCOMPATIBLE',
        `Herdr session discovery returned an invalid socket path for session ${item.name}`,
        safeDiscoveryDetails('invalid_socket_path'),
      );
    }

    const socketPath = socketPathValue as string | undefined;
    if (socketPath !== undefined && !isAbsolute(socketPath)) {
      throw new GatewayError(
        'HERDR_INCOMPATIBLE',
        `Herdr session discovery returned a non-absolute socket path for session ${item.name}`,
        safeDiscoveryDetails('non_absolute_socket_path'),
      );
    }

    sessions.push({
      name: item.name,
      running: item.running,
      ...(socketPath === undefined ? {} : { socketPath }),
    });
  }

  return sessions;
}

async function defaultCommandRunner(
  executable: string,
  args: readonly string[],
  options: HerdrCommandOptions,
): Promise<HerdrCommandResult> {
  return new Promise<HerdrCommandResult>((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        shell: options.shell,
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function defaultSocketValidator(socketPath: string): Promise<void> {
  try {
    const stats = await lstat(socketPath);
    if (!stats.isSocket()) {
      throw new Error('discovered path is not a Unix socket');
    }
  } catch (error) {
    throw new GatewayError('HERDR_UNAVAILABLE', 'the discovered Herdr socket is not usable', {
      reason: 'socket_unavailable',
    }, { cause: error });
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket: Socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new GatewayError('HERDR_UNAVAILABLE', 'the discovered Herdr socket did not accept a connection', {
        reason: 'socket_connect_timeout',
      }));
    }, DEFAULT_TIMEOUT_MS);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };

    socket.once('connect', () => finish(resolve));
    socket.once('error', (error) => finish(() => reject(new GatewayError(
      'HERDR_UNAVAILABLE',
      'the discovered Herdr socket refused the connection',
      { reason: 'socket_connect_failed' },
      { cause: error },
    ))));
  });
}

function isExecutableMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export class HerdrSessionLocator {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly run: HerdrCommandRunner;
  private readonly validateSocket: HerdrSocketValidator;

  public constructor(options: HerdrSessionLocatorOptions = {}) {
    this.executable = options.executable ?? process.env.HERDR_BIN_PATH ?? 'herdr';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.run = options.run ?? defaultCommandRunner;
    this.validateSocket = options.validateSocket ?? defaultSocketValidator;

    if (!isNonEmptyString(this.executable)) {
      throw new GatewayError('HERDR_NOT_FOUND', 'Herdr executable is not configured');
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new GatewayError('INVALID_ARGUMENT', 'Herdr command timeout must be a positive integer');
    }
  }

  public async discover(): Promise<readonly HerdrSessionInfo[]> {
    let result: HerdrCommandResult;
    try {
      result = await this.run(this.executable, SESSION_LIST_ARGS, {
        shell: false,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (isExecutableMissing(error)) {
        throw new GatewayError('HERDR_NOT_FOUND', 'Herdr executable is unavailable', undefined, { cause: error });
      }
      throw new GatewayError('HERDR_UNAVAILABLE', 'Herdr session discovery could not be completed', {
        reason: 'session_list_failed',
      }, { cause: error });
    }

    return parseSessionList(result.stdout);
  }

  public async locate(sessionName: string): Promise<HerdrSessionEndpoint> {
    const sessions = await this.discover();
    return this.locateFromDiscovery(sessions, sessionName);
  }

  public getSessionFromDiscovery(
    sessions: readonly HerdrSessionInfo[],
    sessionName: string,
  ): HerdrSessionEndpoint {
    const session = sessions.find((candidate) => candidate.name === sessionName);
    if (session === undefined) {
      throw new GatewayError('HERDR_SESSION_NOT_FOUND', 'configured Herdr session was not found');
    }
    if (!session.running) {
      throw new GatewayError('HERDR_SESSION_NOT_RUNNING', 'configured Herdr session is not running');
    }
    if (session.socketPath === undefined) {
      throw new GatewayError(
        'HERDR_INCOMPATIBLE',
        'running Herdr session discovery did not include a socket path',
        safeDiscoveryDetails('missing_socket_path'),
      );
    }
    return {
      name: session.name,
      running: session.running,
      socketPath: session.socketPath,
    };
  }

  public async validateSocketPath(socketPath: string): Promise<void> {
    try {
      await this.validateSocket(socketPath);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('HERDR_UNAVAILABLE', 'the discovered Herdr socket is not usable', {
        reason: 'socket_unavailable',
      }, { cause: error });
    }
  }

  public async locateFromDiscovery(
    sessions: readonly HerdrSessionInfo[],
    sessionName: string,
  ): Promise<HerdrSessionEndpoint> {
    const session = this.getSessionFromDiscovery(sessions, sessionName);
    await this.validateSocketPath(session.socketPath);
    return session;
  }
}

export { parseSessionList };
