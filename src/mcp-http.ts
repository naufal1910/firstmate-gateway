import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';

import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
  type NodeIncomingMessageLike,
  type NodeServerResponseLike,
} from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  type AuthInfo,
} from '@modelcontextprotocol/server';

import {
  ConfigError,
  REMOTE_MCP_PATH,
  loadConfigFile,
  validateConfig,
  type EnabledRemoteConfig,
  type GatewayConfig,
} from './config.js';
import { Gateway } from './gateway.js';
import { createMcpServer, type GatewayForMcp } from './mcp.js';
import {
  authenticateBearer,
  authorizeGateway,
  type PrincipalResolver,
  type RemoteTokenVerifier,
} from './remote-auth.js';

export const REMOTE_MAX_REQUEST_BODY_BYTES = 128 * 1024;
export const REMOTE_MAX_HEADER_BYTES = 16 * 1024;
export const REMOTE_HEADERS_TIMEOUT_MS = 10_000;
export const REMOTE_REQUEST_TIMEOUT_MS = 15_000;
export const REMOTE_KEEP_ALIVE_TIMEOUT_MS = 5_000;

export type RemoteDiagnosticEvent =
  | 'client_protocol_error'
  | 'mcp_handler_error'
  | 'request_error';

export interface StartRemoteMcpOptions {
  readonly config?: GatewayConfig;
  readonly configPath?: string;
  readonly gateway?: GatewayForMcp;
  readonly tokenVerifier?: RemoteTokenVerifier;
  readonly principalResolver?: PrincipalResolver;
  /** Receives fixed event names only; errors and request data are never forwarded. */
  readonly onDiagnostic?: (event: RemoteDiagnosticEvent) => void;
}

export interface DisabledRemoteMcpServer {
  readonly enabled: false;
  readonly listening: false;
  close(): Promise<void>;
}

export interface ListeningRemoteMcpServer {
  readonly enabled: true;
  readonly listening: true;
  readonly host: string;
  readonly port: number;
  readonly path: typeof REMOTE_MCP_PATH;
  close(): Promise<void>;
}

export type RemoteMcpServer = DisabledRemoteMcpServer | ListeningRemoteMcpServer;

class RequestBoundaryError extends Error {
  public constructor(
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly closeConnection = false,
  ) {
    super(publicMessage);
    this.name = 'RequestBoundaryError';
  }
}

function toRawConfig(config: GatewayConfig): unknown {
  const targets = Object.fromEntries(Object.entries(config.targets).map(([alias, target]) => [alias, {
    herdr_session: target.herdrSession,
    firstmate_home: target.firstmateHome,
    agent: target.agent,
  }]));
  if (!config.remote.enabled) return { version: config.version, targets, remote: { enabled: false } };
  return {
    version: config.version,
    targets,
    remote: {
      enabled: true,
      bind_host: config.remote.bindHost,
      port: config.remote.port,
      allow_public_bind: config.remote.allowPublicBind,
      resource: config.remote.resource,
      allowed_hosts: [...config.remote.allowedHosts],
      allowed_origins: [...config.remote.allowedOrigins],
      authorization: {
        principals: Object.fromEntries(Object.entries(config.remote.principals).map(([principal, policy]) => [
          principal,
          { targets: [...policy.targets] },
        ])),
      },
    },
  };
}

function revalidateConfig(config: GatewayConfig): GatewayConfig {
  try {
    return validateConfig(toRawConfig(config));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('remote startup configuration is invalid', {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  closeConnection = false,
): void {
  if (response.headersSent || response.destroyed) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    ...(closeConnection ? { Connection: 'close' } : {}),
    ...headers,
  });
  response.end(text);
}

function protocolBoundaryError(
  response: ServerResponse,
  status: number,
  message: string,
  closeConnection = false,
): void {
  sendJson(response, status, {
    jsonrpc: '2.0',
    error: { code: -32_700, message },
    id: null,
  }, {}, closeConnection);
}

function unauthenticated(response: ServerResponse): void {
  sendJson(response, 401, {
    error: 'invalid_token',
    error_description: 'UNAUTHENTICATED',
  }, {
    'WWW-Authenticate': 'Bearer error="invalid_token", error_description="Authentication required"',
  }, true);
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const distinct = request.headersDistinct[name];
  if (distinct !== undefined) {
    if (distinct.length !== 1) return undefined;
    return distinct[0];
  }
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function contentLength(request: IncomingMessage): number | undefined {
  const header = singleHeader(request, 'content-length');
  if (header === undefined) return undefined;
  if (!/^\d+$/.test(header)) throw new RequestBoundaryError(400, 'Malformed MCP request', true);
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw new RequestBoundaryError(413, 'MCP request is too large', true);
  return length;
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const header = singleHeader(request, 'content-type');
  return header?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new RequestBoundaryError(408, 'MCP request timed out', true)));
      request.pause();
    }, REMOTE_REQUEST_TIMEOUT_MS);
    timer.unref();

    const cleanup = (): void => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > REMOTE_MAX_REQUEST_BODY_BYTES) {
        finish(() => reject(new RequestBoundaryError(413, 'MCP request is too large', true)));
        request.pause();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      finish(() => {
        try {
          const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
          resolve(JSON.parse(source) as unknown);
        } catch {
          reject(new RequestBoundaryError(400, 'Malformed MCP request'));
        }
      });
    };
    const onAborted = (): void => finish(() => reject(new RequestBoundaryError(400, 'Malformed MCP request', true)));
    const onError = (): void => finish(() => reject(new RequestBoundaryError(400, 'Malformed MCP request', true)));

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('aborted', onAborted);
    request.on('error', onError);
  });
}

async function authenticateWithinDeadline(
  authorization: string | undefined,
  verifier: RemoteTokenVerifier,
  resource: string,
  principalResolver: PrincipalResolver | undefined,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      authenticateBearer(authorization, verifier, resource, principalResolver),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('authentication deadline exceeded')), REMOTE_REQUEST_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isEndpoint(request: IncomingMessage): boolean {
  if (request.url === undefined) return false;
  try {
    const url = new URL(request.url, 'http://firstmate-gateway.invalid');
    return url.pathname === REMOTE_MCP_PATH && url.search === '';
  } catch {
    return false;
  }
}

function createRemoteHttpServer(
  config: GatewayConfig & { readonly remote: EnabledRemoteConfig },
  gateway: GatewayForMcp,
  verifier: RemoteTokenVerifier,
  principalResolver: PrincipalResolver | undefined,
  diagnostic: (event: RemoteDiagnosticEvent) => void,
): { readonly server: Server; readonly closeHandler: () => Promise<void> } {
  const mcpHandler = createMcpHandler(({ authInfo }) => {
    if (authInfo === undefined) throw new Error('authenticated MCP context missing');
    return createMcpServer(authorizeGateway(gateway, {
      id: authInfo.clientId,
      scopes: new Set(authInfo.scopes),
    }, config.remote));
  }, {
    legacy: 'stateless',
    keepAliveMs: 0,
    onerror: () => diagnostic('mcp_handler_error'),
  });
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: () => diagnostic('mcp_handler_error'),
  });
  const validateHost = hostHeaderValidation([...config.remote.allowedHosts]);
  const validateOrigin = originValidation([...config.remote.allowedOrigins]);

  const server = createServer({
    maxHeaderSize: REMOTE_MAX_HEADER_BYTES,
    requireHostHeader: true,
    rejectNonStandardBodyWrites: true,
  }, async (request, response) => {
    try {
      if (!isEndpoint(request)) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, DELETE' });
        return;
      }

      const length = contentLength(request);
      if (length !== undefined && length > REMOTE_MAX_REQUEST_BODY_BYTES) {
        throw new RequestBoundaryError(413, 'MCP request is too large', true);
      }
      if (request.method !== 'POST' &&
          ((length !== undefined && length > 0) || request.headers['transfer-encoding'] !== undefined)) {
        throw new RequestBoundaryError(400, 'Malformed MCP request', true);
      }

      const authorization = singleHeader(request, 'authorization');
      let principal;
      try {
        principal = await authenticateWithinDeadline(
          authorization,
          verifier,
          config.remote.resource,
          principalResolver,
        );
      } catch {
        unauthenticated(response);
        return;
      } finally {
        delete request.headers.authorization;
      }

      let parsedBody: unknown;
      if (request.method === 'POST') {
        if (!hasJsonContentType(request)) {
          throw new RequestBoundaryError(415, 'MCP requests must use application/json', true);
        }
        parsedBody = await readJsonBody(request);
      }

      (request as IncomingMessage & { auth?: AuthInfo }).auth = {
        token: '',
        clientId: principal.id,
        scopes: [...principal.scopes],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        resource: new URL(config.remote.resource),
      };
      await nodeHandler(
        request as unknown as NodeIncomingMessageLike,
        response as unknown as NodeServerResponseLike,
        parsedBody,
      );
    } catch (error) {
      diagnostic('request_error');
      if (error instanceof RequestBoundaryError) {
        protocolBoundaryError(response, error.status, error.publicMessage, error.closeConnection);
      } else {
        protocolBoundaryError(response, 500, 'MCP request failed', true);
      }
    }
  });

  server.maxHeadersCount = 64;
  server.headersTimeout = REMOTE_HEADERS_TIMEOUT_MS;
  server.requestTimeout = REMOTE_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = REMOTE_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => {
    diagnostic('client_protocol_error');
    if (!socket.writableEnded) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });

  return { server, closeHandler: mcpHandler.close };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeIdleConnections();
  });
}

/**
 * Starts the secured Streamable HTTP MCP endpoint only when validated config
 * explicitly enables it and an operational resource-server verifier is
 * supplied. No verifier fixture or provider-specific authentication ships in
 * production code.
 */
export async function startRemoteMcp(options: StartRemoteMcpOptions = {}): Promise<RemoteMcpServer> {
  const loaded = options.config ?? await loadConfigFile(options.configPath);
  const config = revalidateConfig(loaded);
  if (!config.remote.enabled) {
    return Object.freeze({
      enabled: false,
      listening: false,
      close: async () => undefined,
    });
  }
  if (options.tokenVerifier === undefined || typeof options.tokenVerifier.verifyAccessToken !== 'function') {
    throw new ConfigError('remote mode requires an operational OAuth/OIDC access-token verifier');
  }

  const gateway = options.gateway ?? new Gateway({ config });
  const diagnostic = (event: RemoteDiagnosticEvent): void => {
    try {
      options.onDiagnostic?.(event);
    } catch {
      // Diagnostics are reporting-only and cannot alter request handling.
    }
  };
  const { server, closeHandler } = createRemoteHttpServer(
    config as GatewayConfig & { readonly remote: EnabledRemoteConfig },
    gateway,
    options.tokenVerifier,
    options.principalResolver,
    diagnostic,
  );

  try {
    await listen(server, config.remote.port, config.remote.bindHost);
  } catch (error) {
    await closeHandler();
    throw new ConfigError('remote MCP listener could not start', {
      cause: error instanceof Error ? error : undefined,
    });
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeHandler();
    await closeServer(server);
    throw new ConfigError('remote MCP listener address is unavailable');
  }
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await Promise.all([closeHandler(), closeServer(server)]);
    })();
    return closePromise;
  };
  return Object.freeze({
    enabled: true,
    listening: true,
    host: isIP(address.address) === 6 ? `[${address.address}]` : address.address,
    port: address.port,
    path: REMOTE_MCP_PATH,
    close,
  });
}
