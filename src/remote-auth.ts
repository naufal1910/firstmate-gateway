import {
  verifyBearerToken,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';

import type { EnabledRemoteConfig } from './config.js';
import { GatewayError } from './errors.js';
import type { GatewayInvocationOptions, ReadInput, SendPromptInput } from './gateway.js';
import type { GatewayForMcp } from './mcp.js';

export const REMOTE_SCOPES = Object.freeze({
  read: 'firstmate-gateway:read',
  send: 'firstmate-gateway:send',
  diagnostics: 'firstmate-gateway:diagnostics',
} as const);

export type RemoteScope = (typeof REMOTE_SCOPES)[keyof typeof REMOTE_SCOPES];
export type RemoteTokenVerifier = OAuthTokenVerifier;

export interface AuthenticatedPrincipal {
  readonly id: string;
  readonly scopes: ReadonlySet<string>;
}

export type PrincipalResolver = (authInfo: Readonly<AuthInfo>) => string;

/** Authentication failures deliberately carry no token or verifier detail. */
export class RemoteAuthenticationError extends Error {
  public constructor() {
    super('remote authentication failed');
    this.name = 'RemoteAuthenticationError';
  }
}

const BEARER_HEADER = /^Bearer ([A-Za-z0-9\-._~+/]+={0,})$/i;
const MAX_BEARER_TOKEN_BYTES = 16 * 1024;
const MAX_PRINCIPAL_ID_BYTES = 256;
const MAX_SCOPE_BYTES = 256;

function defaultPrincipalResolver(authInfo: Readonly<AuthInfo>): string {
  return authInfo.clientId;
}

function hasOnlyVisibleCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 32 && code !== 127;
  });
}

function validPrincipalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_PRINCIPAL_ID_BYTES &&
    hasOnlyVisibleCharacters(value);
}

function validScopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 256 && value.every((scope) =>
    typeof scope === 'string' && scope.length > 0 &&
    Buffer.byteLength(scope, 'utf8') <= MAX_SCOPE_BYTES &&
    hasOnlyVisibleCharacters(scope));
}

/**
 * Validates a bearer access token through the official MCP OAuth resource-
 * server verifier seam, then returns only the non-secret principal data used
 * by Gateway authorization.
 */
export async function authenticateBearer(
  authorizationHeader: string | undefined,
  verifier: RemoteTokenVerifier,
  expectedResource: string,
  resolvePrincipal: PrincipalResolver = defaultPrincipalResolver,
): Promise<AuthenticatedPrincipal> {
  const match = authorizationHeader?.match(BEARER_HEADER);
  if (match === null || match === undefined) throw new RemoteAuthenticationError();
  const token = match[1];
  if (token === undefined || Buffer.byteLength(token, 'utf8') > MAX_BEARER_TOKEN_BYTES) {
    throw new RemoteAuthenticationError();
  }

  try {
    const authInfo = await verifyBearerToken(authorizationHeader, { verifier });
    if (!validScopes(authInfo.scopes) || !validPrincipalId(authInfo.clientId)) {
      throw new RemoteAuthenticationError();
    }
    if (authInfo.resource === undefined || authInfo.resource.href !== new URL(expectedResource).href) {
      throw new RemoteAuthenticationError();
    }
    const principalId = resolvePrincipal(authInfo);
    if (!validPrincipalId(principalId)) throw new RemoteAuthenticationError();
    return Object.freeze({
      id: principalId,
      scopes: new Set(authInfo.scopes),
    });
  } catch {
    throw new RemoteAuthenticationError();
  }
}

function forbidden(): GatewayError {
  return new GatewayError('FORBIDDEN', 'the authenticated principal is not authorized for this operation');
}

/**
 * Applies operation scopes and the configured per-principal target allowlist
 * before delegating to the existing MCP adapter/Gateway Core boundary.
 */
export function authorizeGateway(
  gateway: GatewayForMcp,
  principal: AuthenticatedPrincipal,
  remote: EnabledRemoteConfig,
): GatewayForMcp {
  const policy = remote.principals[principal.id];
  const allowedTargets = new Set(policy?.targets ?? []);

  const requireScope = (scope: RemoteScope): void => {
    if (policy === undefined || !principal.scopes.has(scope)) throw forbidden();
  };
  const requireTarget = (target: string): void => {
    if (!allowedTargets.has(target)) throw forbidden();
  };

  return Object.freeze({
    async listTargets(options: GatewayInvocationOptions = {}) {
      requireScope(REMOTE_SCOPES.read);
      const targets = await gateway.listTargets(options);
      return targets.filter((target) => allowedTargets.has(target.target));
    },
    async getStatus(target: string, options: GatewayInvocationOptions = {}) {
      requireScope(REMOTE_SCOPES.read);
      requireTarget(target);
      return gateway.getStatus(target, options);
    },
    async sendPrompt(input: SendPromptInput, options: GatewayInvocationOptions = {}) {
      requireScope(REMOTE_SCOPES.send);
      requireTarget(input.target);
      return gateway.sendPrompt(input, options);
    },
    async read(input: ReadInput, options: GatewayInvocationOptions = {}) {
      requireScope(input.mode === 'semantic' ? REMOTE_SCOPES.read : REMOTE_SCOPES.diagnostics);
      requireTarget(input.target);
      return gateway.read(input, options);
    },
  });
}
