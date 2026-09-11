import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const MAX_CONFIG_BYTES = 1024 * 1024;
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AGENT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

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

const rawConfigSchema = z
  .object({
    version: z.literal(1),
    targets: z.record(aliasSchema, targetSchema).refine(
      (targets) => Object.keys(targets).length > 0,
      'targets must contain at least one named target',
    ),
  })
  .strict();

export interface TargetConfig {
  readonly alias: string;
  readonly herdrSession: string;
  readonly firstmateHome: string;
  readonly agent: string;
}

export interface GatewayConfig {
  readonly version: 1;
  readonly targets: Readonly<Record<string, TargetConfig>>;
}

export class ConfigError extends Error {
  public readonly code = 'CONFIG_INVALID';

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigError';
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
  return Object.freeze({
    version: 1,
    targets: Object.freeze(targets),
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

export function loadConfigFileSync(filePath = defaultConfigPath()): GatewayConfig {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`unable to read configuration file ${filePath}`, { cause: error });
  }
  return parseConfig(source);
}

export async function loadConfigFile(filePath = defaultConfigPath()): Promise<GatewayConfig> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`unable to read configuration file ${filePath}`, { cause: error });
  }
  return parseConfig(source);
}

export const loadConfig = loadConfigFile;
