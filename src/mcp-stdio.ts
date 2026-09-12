#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { Gateway } from './gateway.js';
import { createMcpServer, type GatewayForMcp } from './mcp.js';

const MCP_MAX_BUFFER_BYTES = 1024 * 1024;

function diagnostic(kind: string): void {
  process.stderr.write(`[firstmate-gateway-mcp] ${kind}\n`);
}

export async function runStdioMcp(gateway: GatewayForMcp = new Gateway()): Promise<void> {
  serveStdio(
    () => createMcpServer(gateway),
    {
      onerror: () => diagnostic('stdio transport error'),
      transport: new StdioServerTransport(process.stdin, process.stdout, {
        maxBufferSize: MCP_MAX_BUFFER_BYTES,
      }),
    },
  );
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
  try {
    await runStdioMcp();
  } catch {
    diagnostic('unable to start MCP stdio server');
    process.exitCode = 1;
  }
}
