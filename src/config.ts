import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, normalize, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import { GatewayError } from './errors.js';

const MAX_CONFIG_BYTES = 1024 * 1024;
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AGENT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
function isPolicyPrincipal(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 32 && code !== 127;
    });
}

export const REMOTE_MCP_PATH = '/mcp';

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1';
}

function isValidHostname(host: string): boolean {
  return isIP(host) !== 0 || HOSTNAME_PATTERN.test(host);
}

function isAllowedHeaderHostname(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return isIP(host.slice(1, -1)) === 6;
  return isValidHostname(host);
}

function isSecureResource(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.hash === '' && url.search === '' && url.pathname === REMOTE_MCP_PATH;
  } catch {
    return false;
  }
}

const nonEmptyString = (name: string) =>
  z
    .string()
    .min(1, `${name} must not be empty`)
    .refine((value) => value.trim() === value, `${name} must not have leading or trailing whitespace`)
    .refine((value) => !value.includes('\u0000'), `${name} must not contain NUL bytes`);

const aliasSchema = z
  .string()
  .regex(ALIAS_PATTERN, 'alias must start with a lowercase letter and contain only lowercase letters, digits, _ or -');

const targetSchema = z
  .object({
    herdr_session: nonEmptyString('herdr_session').regex(
      SESSION_PATTERN,
      'herdr_session contains unsupported characters',
    ),
    firstmate_home: nonEmptyString('firstmate_home').refine(
      (value) => isAbsolute(value),
      'firstmate_home must be an absolute path',
    ),
    agent: nonEmptyString('agent').regex(AGENT_PATTERN, 'agent contains unsupported characters'),
  })
  .strict();

const principalPolicySchema = z.object({
  targets: z.array(aliasSchema).min(1).max(256).refine(
    (targets) => new Set(targets).size === targets.length,
    'targets must not contain duplicates',
  ),
}).strict();

const disabledRemoteSchema = z.object({ enabled: z.literal(false) }).strict();
const enabledRemoteSchema = z.object({
  enabled: z.literal(true),
  bind_host: z.string().refine(isValidHostname, 'bind_host must be an IP address or hostname'),
  port: z.number().int().min(0).max(65_535),
  allow_public_bind: z.boolean().default(false),
  resource: z.string().refine(
    isSecureResource,
    `resource must be an HTTPS URL ending at ${REMOTE_MCP_PATH} without credentials, query, or fragment`,
  ),
  allowed_hosts: z.array(z.string().refine(
    isAllowedHeaderHostname,
    'allowed_hosts entries must be hostnames without schemes or ports',
  )).min(1).max(64).refine(
    (hosts) => new Set(hosts).size === hosts.length,
    'allowed_hosts must not contain duplicates',
  ),
  allowed_origins: z.array(z.string().refine(
    isAllowedHeaderHostname,
    'allowed_origins entries must be hostnames without schemes or ports',
  )).max(64).default([]).refine(
    (origins) => new Set(origins).size === origins.length,
    'allowed_origins must not contain duplicates',
  ),
  authorization: z.object({
    principals: z.record(
      z.string().refine(isPolicyPrincipal, 'principal IDs must be 1-256 non-whitespace characters'),
      principalPolicySchema,
    ).refine(
      (principals) => Object.keys(principals).length > 0,
      'principals must contain at least one target policy',
    ),
  }).strict(),
}).strict().superRefine((remote, context) => {
  if (!isLoopbackHost(remote.bind_host) && !remote.allow_public_bind) {
    context.addIssue({
      code: 'custom',
      path: ['allow_public_bind'],
      message: 'must be true when bind_host is not an explicit loopback address',
    });
  }
});

const remoteSchema = z.discriminatedUnion('enabled', [disabledRemoteSchema, enabledRemoteSchema]);

const rawConfigSchema = z
  .object({
    version: z.literal(1),
    targets: z.record(aliasSchema, targetSchema).refine(
      (targets) => Object.keys(targets).length > 0,
      'targets must contain at least one named target',
    ),
    remote: remoteSchema.default({ enabled: false }),
  })
  .strict()
  .superRefine((config, context) => {
    if (!config.remote.enabled) return;
    for (const [principal, policy] of Object.entries(config.remote.authorization.principals)) {
      for (const target of policy.targets) {
        if (config.targets[target] === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['remote', 'authorization', 'principals', principal, 'targets'],
            message: `target ${target} is not configured`,
          });
        }
      }
    }
  });

export interface TargetConfig {
  readonly alias: string;
  readonly herdrSession: string;
  readonly firstmateHome: string;
  readonly agent: string;
}

export interface RemotePrincipalPolicy {
  readonly targets: readonly string[];
}

export interface DisabledRemoteConfig {
  readonly enabled: false;
}

export interface EnabledRemoteConfig {
  readonly enabled: true;
  readonly bindHost: string;
  readonly port: number;
  readonly allowPublicBind: boolean;
  readonly resource: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly principals: Readonly<Record<string, RemotePrincipalPolicy>>;
}

export type RemoteConfig = DisabledRemoteConfig | EnabledRemoteConfig;

export interface GatewayConfig {
  readonly version: 1;
  readonly targets: Readonly<Record<string, TargetConfig>>;
  readonly remote: RemoteConfig;
}

export class ConfigError extends GatewayError {
  public constructor(message: string, options?: ErrorOptions) {
    super('CONFIG_INVALID', message, undefined, options);
    this.name = 'ConfigError';
  }
}

export class ConfigNotFoundError extends GatewayError {
  public constructor(message = 'configuration file was not found', options?: ErrorOptions) {
    super('CONFIG_NOT_FOUND', message, undefined, options);
    this.name = 'ConfigNotFoundError';
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? 'config' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function canonicalizeTarget(alias: string, target: z.infer<typeof targetSchema>): TargetConfig {
  return Object.freeze({
    alias,
    herdrSession: target.herdr_session,
    firstmateHome: normalize(resolve(target.firstmate_home)),
    agent: target.agent,
  });
}

export function validateConfig(input: unknown): GatewayConfig {
  const result = rawConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error));
  }

  const targets = Object.fromEntries(
    Object.entries(result.data.targets).map(([alias, target]) => [alias, canonicalizeTarget(alias, target)]),
  );
  const remote: RemoteConfig = result.data.remote.enabled
    ? Object.freeze({
      enabled: true,
      bindHost: result.data.remote.bind_host,
      port: result.data.remote.port,
      allowPublicBind: result.data.remote.allow_public_bind,
      resource: result.data.remote.resource,
      allowedHosts: Object.freeze([...result.data.remote.allowed_hosts]),
      allowedOrigins: Object.freeze([...result.data.remote.allowed_origins]),
      principals: Object.freeze(Object.fromEntries(
        Object.entries(result.data.remote.authorization.principals).map(([principal, policy]) => [
          principal,
          Object.freeze({ targets: Object.freeze([...policy.targets]) }),
        ]),
      )),
    })
    : Object.freeze({ enabled: false });
  return Object.freeze({
    version: 1,
    targets: Object.freeze(targets),
    remote,
  });
}

export function parseConfig(source: string): GatewayConfig {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new ConfigError('configuration must be a non-empty YAML document');
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ConfigError(`configuration exceeds the ${MAX_CONFIG_BYTES}-byte limit`);
  }

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      prettyErrors: true,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new ConfigError('configuration is not valid YAML', { cause: error });
  }
  if (document.errors.length > 0) {
    const message = document.errors.map((error) => error.message).join('; ');
    throw new ConfigError(`configuration is not valid YAML: ${message}`);
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new ConfigError('configuration could not be materialized', { cause: error });
  }
  return validateConfig(value);
}

export function defaultConfigPath(): string {
  return process.env.FIRSTMATE_GATEWAY_CONFIG ?? resolve('config/local.yaml');
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function loadConfigFileSync(filePath = defaultConfigPath()): GatewayConfig {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ConfigNotFoundError();
    }
    throw new ConfigError('unable to read the configuration file', { cause: error });
  }
  return parseConfig(source);
}

export async function loadConfigFile(filePath = defaultConfigPath()): Promise<GatewayConfig> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ConfigNotFoundError();
    }
    throw new ConfigError('unable to read the configuration file', { cause: error });
  }
  return parseConfig(source);
}

export const loadConfig = loadConfigFile;
