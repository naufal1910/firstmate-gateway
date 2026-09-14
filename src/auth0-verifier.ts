import type { AuthInfo } from '@modelcontextprotocol/server';
import {
  createRemoteJWKSet,
  customFetch,
  importJWK,
  jwtVerify,
  type FetchImplementation,
  type JSONWebKeySet,
  type JWK,
} from 'jose';

import { ConfigError } from './config.js';
import {
  REMOTE_SCOPES,
  RemoteAuthenticationError,
  type RemoteTokenVerifier,
} from './remote-auth.js';

const AUTH0_DISCOVERY_TIMEOUT_MS = 5_000;
const AUTH0_MAX_DISCOVERY_BYTES = 64 * 1024;
const AUTH0_MAX_JWKS_BYTES = 256 * 1024;
const AUTH0_MAX_TOKEN_BYTES = 16 * 1024;
const AUTH0_MAX_SCOPE_BYTES = 4 * 1024;
const AUTH0_CLOCK_TOLERANCE_SECONDS = 30;
const AUTH0_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+auth0\.com$/;
const OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const APPROVED_SCOPES = new Set<string>(Object.values(REMOTE_SCOPES));

type Auth0Fetch = typeof globalThis.fetch;

export interface Auth0TokenVerifierOptions {
  /** Exact Auth0 tenant issuer. No placeholder or default issuer is used. */
  readonly issuer: string;
  /** Exact API identifier expected in the JWT audience claim. */
  readonly audience: string;
  /** Test/embedding seam; production defaults to the runtime fetch implementation. */
  readonly fetch?: Auth0Fetch;
}

interface Auth0DiscoveryDocument {
  readonly issuer: string;
  readonly jwks_uri: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function auth0Issuer(value: string): URL {
  try {
    const issuer = new URL(value);
    if (issuer.protocol !== 'https:' || issuer.username !== '' || issuer.password !== '' ||
      issuer.port !== '' || issuer.search !== '' || issuer.hash !== '' || issuer.pathname !== '/' ||
      !AUTH0_HOST_PATTERN.test(issuer.hostname)) {
      throw new Error('invalid Auth0 issuer');
    }
    return issuer;
  } catch {
    throw new ConfigError('Auth0 issuer must be an HTTPS auth0.com tenant URL ending in /');
  }
}

function tokenAudience(value: string): URL {
  try {
    const audience = new URL(value);
    if (audience.protocol !== 'https:' || audience.username !== '' || audience.password !== '' ||
      audience.search !== '' || audience.hash !== '') {
      throw new Error('invalid audience');
    }
    return audience;
  } catch {
    throw new ConfigError('Auth0 audience must be an exact HTTPS resource URL');
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    throw new Error('response is too large');
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error('response is too large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function hasJsonContentType(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  if (contentType === null) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}

async function fetchDiscovery(url: URL, fetcher: Auth0Fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH0_DISCOVERY_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status !== 200 || !hasJsonContentType(response)) {
      throw new Error('discovery response is invalid');
    }
    const body = await readBoundedBody(response, AUTH0_MAX_DISCOVERY_BYTES);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function parseDiscovery(value: unknown, expectedIssuer: URL): Auth0DiscoveryDocument {
  if (!isObject(value) || typeof value.issuer !== 'string' || typeof value.jwks_uri !== 'string') {
    throw new ConfigError('Auth0 issuer discovery metadata is invalid');
  }

  let discoveredIssuer: URL;
  let jwksUrl: URL;
  try {
    discoveredIssuer = new URL(value.issuer);
    jwksUrl = new URL(value.jwks_uri);
  } catch {
    throw new ConfigError('Auth0 issuer discovery metadata is invalid');
  }
  if (discoveredIssuer.href !== expectedIssuer.href || jwksUrl.protocol !== 'https:' ||
    jwksUrl.origin !== expectedIssuer.origin || jwksUrl.username !== '' || jwksUrl.password !== '' ||
    jwksUrl.port !== '' || jwksUrl.pathname !== '/.well-known/jwks.json' ||
    jwksUrl.search !== '' || jwksUrl.hash !== '') {
    throw new ConfigError('Auth0 issuer discovery metadata is invalid');
  }
  return Object.freeze({ issuer: discoveredIssuer.href, jwks_uri: jwksUrl.href });
}

function boundedJwksFetch(fetcher: Auth0Fetch, expectedUrl: URL): FetchImplementation {
  return async (url, options) => {
    if (new URL(url).href !== expectedUrl.href) throw new Error('unexpected JWKS URL');
    const response = await fetcher(url, options);
    if (response.status !== 200) {
      return new Response(null, { status: response.status, statusText: response.statusText });
    }
    if (!hasJsonContentType(response)) throw new Error('JWKS response is invalid');
    const body = await readBoundedBody(response, AUTH0_MAX_JWKS_BYTES);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function isPublicRs256SigningKey(key: JWK): boolean {
  return key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig' &&
    typeof key.kid === 'string' && key.kid.length > 0 &&
    typeof key.n === 'string' && key.n.length > 0 &&
    typeof key.e === 'string' && key.e.length > 0 &&
    key.d === undefined &&
    (key.key_ops === undefined || key.key_ops.includes('verify'));
}

async function validateJwks(jwks: JSONWebKeySet | undefined): Promise<void> {
  if (jwks === undefined || !Array.isArray(jwks.keys)) {
    throw new ConfigError('Auth0 JWKS is invalid or has no RS256 signing key');
  }
  const signingKeys = jwks.keys.filter(isPublicRs256SigningKey);
  if (signingKeys.length === 0 || new Set(signingKeys.map((key) => key.kid)).size !== signingKeys.length) {
    throw new ConfigError('Auth0 JWKS is invalid or has no RS256 signing key');
  }
  try {
    await Promise.all(signingKeys.map(async (key) => importJWK(key, 'RS256')));
  } catch {
    throw new ConfigError('Auth0 JWKS is invalid or has no RS256 signing key');
  }
}

function visibleIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 32 && code !== 127;
    });
}

function clientIdFromClaims(payload: Readonly<Record<string, unknown>>): string {
  const clientId = payload.client_id;
  const authorizedParty = payload.azp;
  if (clientId !== undefined && !visibleIdentifier(clientId)) throw new RemoteAuthenticationError();
  if (authorizedParty !== undefined && !visibleIdentifier(authorizedParty)) throw new RemoteAuthenticationError();
  if (clientId !== undefined && authorizedParty !== undefined && clientId !== authorizedParty) {
    throw new RemoteAuthenticationError();
  }
  const resolved = clientId ?? authorizedParty;
  if (!visibleIdentifier(resolved)) throw new RemoteAuthenticationError();
  return resolved;
}

function scopesFromClaim(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > AUTH0_MAX_SCOPE_BYTES) {
    throw new RemoteAuthenticationError();
  }
  if (value.length === 0) return [];
  const scopes = value.split(' ');
  if (scopes.length > 256 || new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !OAUTH_SCOPE_TOKEN.test(scope))) {
    throw new RemoteAuthenticationError();
  }
  return scopes.filter((scope) => APPROVED_SCOPES.has(scope));
}

/**
 * Discovers and preloads an Auth0 tenant's JWKS before returning an operational
 * MCP access-token verifier. Startup fails closed when discovery or JWKS cannot
 * be validated; request-time verification remains rotation-aware through JWKS.
 */
export async function createAuth0TokenVerifier(
  options: Auth0TokenVerifierOptions,
): Promise<RemoteTokenVerifier> {
  const issuer = auth0Issuer(options.issuer);
  const audience = tokenAudience(options.audience);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new ConfigError('Auth0 verifier requires a fetch implementation');

  let discovery: Auth0DiscoveryDocument;
  try {
    const document = await fetchDiscovery(new URL('.well-known/openid-configuration', issuer), fetcher);
    discovery = parseDiscovery(document, issuer);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('Auth0 issuer discovery is unavailable or invalid');
  }

  const jwksUrl = new URL(discovery.jwks_uri);
  const remoteJwks = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: AUTH0_DISCOVERY_TIMEOUT_MS,
    [customFetch]: boundedJwksFetch(fetcher, jwksUrl),
  });
  try {
    await remoteJwks.reload();
    await validateJwks(remoteJwks.jwks());
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('Auth0 JWKS is unavailable or invalid');
  }

  return Object.freeze({
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        if (typeof token !== 'string' || token.length === 0 ||
          Buffer.byteLength(token, 'utf8') > AUTH0_MAX_TOKEN_BYTES) {
          throw new RemoteAuthenticationError();
        }
        const { payload } = await jwtVerify(token, remoteJwks, {
          algorithms: ['RS256'],
          issuer: issuer.href,
          audience: audience.href,
          typ: 'JWT',
          requiredClaims: ['exp', 'iat', 'sub'],
          clockTolerance: AUTH0_CLOCK_TOLERANCE_SECONDS,
        });
        if (payload.aud !== audience.href || typeof payload.sub !== 'string' ||
          payload.sub.length === 0 || typeof payload.iat !== 'number' ||
          payload.iat > Math.floor(Date.now() / 1000) + AUTH0_CLOCK_TOLERANCE_SECONDS ||
          typeof payload.exp !== 'number') {
          throw new RemoteAuthenticationError();
        }
        const claims = payload as Readonly<Record<string, unknown>>;
        return {
          token,
          clientId: clientIdFromClaims(claims),
          scopes: scopesFromClaim(claims.scope),
          expiresAt: payload.exp,
          resource: new URL(payload.aud),
        };
      } catch {
        throw new RemoteAuthenticationError();
      }
    },
  });
}
