#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAuth0TokenVerifier, type Auth0TokenVerifierOptions } from './auth0-verifier.js';
import { ConfigError, ConfigNotFoundError, loadConfigFile } from './config.js';
import { GatewayError } from './errors.js';
import { VERSION } from './version.js';
import {
  startRemoteMcp,
  type RemoteDiagnosticEvent,
  type RemoteMcpServer,
} from './mcp-http.js';
import type { GatewayForMcp } from './mcp.js';

const HELP = `firstmate-gateway-remote ${VERSION}

Usage:
  firstmate-gateway-remote
  firstmate-gateway-remote --help
  firstmate-gateway-remote --version

Loads FIRSTMATE_GATEWAY_CONFIG (or config/local.yaml), validates one Auth0 issuer,
preloads its JWKS, and starts the secured MCP listener only on explicit loopback.
`;

export interface StartAuth0RemoteMcpOptions {
  readonly configPath?: string;
  readonly gateway?: GatewayForMcp;
  readonly fetch?: Auth0TokenVerifierOptions['fetch'];
  readonly onDiagnostic?: (event: RemoteDiagnosticEvent) => void;
}

/**
 * Operational Auth0 wrapper around the provider-neutral remote MCP seam.
 * This executable path deliberately refuses every non-loopback bind, even when
 * the lower-level library API has an explicit public-bind escape hatch.
 */
export async function startAuth0RemoteMcp(
  options: StartAuth0RemoteMcpOptions = {},
): Promise<RemoteMcpServer> {
  const config = await loadConfigFile(options.configPath);
  if (!config.remote.enabled) return startRemoteMcp({ config });
  if (config.remote.bindHost !== '127.0.0.1' && config.remote.bindHost !== '::1') {
    throw new ConfigError('the Auth0 remote runner requires an explicit loopback bind');
  }
  if (config.remote.authorizationServers.length !== 1) {
    throw new ConfigError('the Auth0 remote runner requires exactly one authorization server issuer');
  }

  const verifier = await createAuth0TokenVerifier({
    issuer: config.remote.authorizationServers[0] as string,
    audience: config.remote.externalResource ?? config.remote.resource,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return startRemoteMcp({
    config,
    tokenVerifier: verifier,
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });
}

function installShutdownHandlers(server: RemoteMcpServer): void {
  if (!server.enabled) return;
  const close = (): void => {
    void server.close().catch(() => {
      process.exitCode = 1;
      console.error('INTERNAL_ERROR: remote MCP shutdown failed');
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(HELP);
    return 0;
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
    console.log(VERSION);
    return 0;
  }
  if (args.length !== 0) {
    console.error('INVALID_ARGUMENT: firstmate-gateway-remote accepts no arguments');
    return 2;
  }

  try {
    const server = await startAuth0RemoteMcp();
    if (!server.enabled) throw new ConfigError('remote MCP is disabled in configuration');
    console.error(`remote MCP listening on http://${server.host}:${server.port}${server.path}`);
    installShutdownHandlers(server);
    return 0;
  } catch (error) {
    if (error instanceof ConfigNotFoundError) {
      console.error('CONFIG_NOT_FOUND: configuration file was not found');
    } else if (error instanceof ConfigError) {
      // Parser diagnostics can contain source excerpts; never write protected
      // local configuration values to service output.
      console.error('CONFIG_INVALID: remote MCP configuration or Auth0 verifier is invalid');
    } else if (error instanceof GatewayError) {
      console.error(`${error.code}: remote MCP startup failed`);
    } else {
      console.error('INTERNAL_ERROR: remote MCP startup failed');
    }
    return 1;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main();
}
