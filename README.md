# FirstMate Gateway

A safe gateway for connecting ChatGPT and other clients to FirstMate instances running under Herdr.

> **Status:** Phase 6 implementation work covers the safe tunnel-compatible path, operator documentation, and dry-run release automation. A live ChatGPT workspace/plan verification remains environment-dependent and is not claimed unless explicitly run against a connected workspace.

## What It Is

FirstMate Gateway is a client-neutral integration layer that lets approved external clients interact with one or more FirstMate instances without exposing arbitrary shell or terminal access.

```text
Client
  ↓
FirstMate Gateway
  ↓
validated, constrained operations
  ↓
Herdr
  ↓
FirstMate
```

The Gateway Core is intentionally independent from ChatGPT, MCP, HTTP, Telegram, Discord, or another specific client. ChatGPT is the first remote integration target, not an architectural dependency.

## Initial Capability Surface

The planned initial Gateway operations are deliberately small:

```text
list configured targets
get target status
send a prompt
read target output
diagnose installation/configuration
```

The project does **not** expose arbitrary shell, sudo, filesystem, or generic terminal-control operations.

## Technical Foundation

- TypeScript
- Node.js 24 LTS
- ESM
- pnpm
- YAML configuration with runtime validation
- reusable Gateway Core + CLI
- Herdr structured local socket API for programmatic agent operations
- dynamic target discovery; no persistent pane IDs
- MCP as an adapter over Gateway Core
- local/private-first deployment
- npm as the primary distribution channel, with trusted-publishing release automation

## Local foundation

Prerequisites are Node.js 24 LTS or newer, a supported Herdr installation, and a
FirstMate instance running under Herdr. The complete operator procedure, including
installation, `init`, `doctor`, remote setup, ChatGPT setup, and troubleshooting is
in the [operator guide](./docs/operator-guide.md).

For a published package:

```sh
npm install --global firstmate-gateway
firstmate-gateway --version
```

For a project-local package, use `npm install firstmate-gateway` and `npx firstmate-gateway ...`. From a source checkout, use the pinned pnpm version:

```sh
corepack pnpm install --frozen-lockfile
pnpm check
```

The package targets Node.js 24 LTS, uses ESM, and is developed with pnpm:

```sh
pnpm install
pnpm check
node dist/cli.js --help
node dist/cli.js --version
```

The committed [`config/example.yaml`](./config/example.yaml) is safe to copy. Keep real machine configuration in the ignored `config/local.yaml` (or set `FIRSTMATE_GATEWAY_CONFIG` to another local path):

```yaml
version: 1

targets:
  firstmate2:
    herdr_session: firstmate-b
    firstmate_home: /absolute/path/to/firstmate2
    agent: pi
```

The current milestone exposes the reusable YAML validator, Herdr session locator, exact-one target resolver, Gateway Core status/send/read operations, and the structured Herdr socket client as TypeScript APIs. Prompt delivery is bounded and non-idempotent; raw reads use explicit bounded sources. Semantic reads are a separate provider boundary and currently return `SEMANTIC_OUTPUT_UNAVAILABLE` because no Pi semantic source contract has been validated. MCP adapters delegate to those same Core operations; no transport duplicates Gateway or Herdr logic.

CLI usage:

```sh
firstmate-gateway init
firstmate-gateway init --path "$HOME/.config/firstmate-gateway/local.yaml"
firstmate-gateway doctor
firstmate-gateway targets
firstmate-gateway status firstmate2
firstmate-gateway send firstmate2 "Reply exactly with: ..."
printf '%s' 'prompt from stdin' | firstmate-gateway send firstmate2
firstmate-gateway send firstmate2 --file ./prompt.txt
firstmate-gateway read firstmate2
firstmate-gateway read firstmate2 --source recent --count 40 --json
firstmate-gateway read firstmate2 --semantic --json
firstmate-gateway doctor --json
firstmate-gateway-mcp
```

`firstmate-gateway-mcp` is the minimal local MCP stdio entry point. Its stdout is reserved exclusively for MCP protocol traffic; diagnostics go to stderr. It does not start a listener or manage FirstMate/Herdr lifecycle state. It exposes exactly `firstmate_list`, `firstmate_status`, `firstmate_send`, and `firstmate_read`.

### Opt-in remote MCP

Remote networking remains off when `remote` is absent or has `enabled: false`. The exported `startRemoteMcp(...)` API starts only after both validated enabled configuration and an injected operational OAuth/OIDC resource-server token verifier are present. No test token verifier or identity provider is shipped in production code.

```yaml
remote:
  enabled: true
  bind_host: 127.0.0.1
  port: 3100
  resource: https://gateway.example.com/mcp
  # For Secure MCP Tunnel v0.0.14, keep the private /mcp resource above and
  # set the external token audience to the OpenAI-hosted tunnel path:
  # external_resource: https://<tunnel-origin>/v1/mcp/tunnel_<32-lowercase-hexadecimal-characters>
  authorization_servers:
    - https://identity.example.com/tenant
  allowed_hosts: [gateway.example.com]
  allowed_origins: []
  authorization:
    principals:
      replace-with-verified-client-principal:
        targets: [firstmate2]
```

```ts
import { startRemoteMcp } from 'firstmate-gateway';

// `verifier` implements the official OAuthTokenVerifier resource-server seam.
await startRemoteMcp({ tokenVerifier: verifier });
```

The resource identifier and every provider-neutral authorization-server issuer must be HTTPS even when an internal listener sits behind provider-neutral TLS termination. The Gateway publishes unauthenticated RFC 9728 Protected Resource Metadata at the path-aware `/.well-known/oauth-protected-resource/mcp` endpoint and points to it from 401 Bearer challenges. Metadata advertises only the configured private resource, issuer URLs, and three supported scopes—never credentials. For OpenAI Secure MCP Tunnel v0.0.14, the tunnel service rewrites that metadata resource and challenge to `/v1/mcp/<tunnel_id>`; set `external_resource` to that exact HTTPS URL so access-token resource validation remains enabled rather than accepting either identity. Non-loopback binding additionally requires `allow_public_bind: true`; no public bind is inferred. Host and Origin allowlists, 128 KiB request bodies, header/body timeouts, and bounded connection lifecycles are enforced before MCP dispatch. Access tokens must carry an exact matching resource and expiration. By default the verified OAuth `clientId` selects a configured principal policy; an OIDC-aware host may inject a `principalResolver` without changing Gateway Core.

Authentication runs before authorization. `firstmate_list` and `firstmate_status` require `firstmate-gateway:read`; `firstmate_send` requires `firstmate-gateway:send`; raw `firstmate_read` requires `firstmate-gateway:diagnostics`; semantic read requires read and retains `SEMANTIC_OUTPUT_UNAVAILABLE`. Every target-specific operation is checked against the principal allowlist, and list results are filtered to that allowlist. Authentication failures are safe HTTP 401 responses; authenticated policy failures are `FORBIDDEN` MCP tool errors without Gateway invocation.

`send` accepts exactly one source (positional message, `--file`, or stdin), preserves prompt data literally, rejects empty/oversized input (64 KiB UTF-8 maximum), and reports accepted delivery without waiting for completion. A timeout or other uncertain delivery is never retried. `read` defaults to `recent-unwrapped` and 120 lines; supported sources are `visible`, `recent`, `recent-unwrapped`, and `detection`. Raw reads never silently fall back to another source. Every operation dynamically resolves the current exact-one target; runtime pane IDs are never configuration identity or CLI input.

Milestone runtime finding: installed Herdr 0.8.2 spells the `recent-unwrapped` source as `recent_unwrapped` on the structured wire. The Herdr adapter translates that wire spelling while keeping the approved public source name and rejects any different returned source rather than falling back.

## Project Documentation

The approved product and engineering context lives in [`docs/`](./docs/README.md).

Start with:

1. [`docs/02-product-engineering-spec.md`](./docs/02-product-engineering-spec.md)
2. [`docs/01-tech-stack-decisions.md`](./docs/01-tech-stack-decisions.md)
3. [`docs/03-technical-design.md`](./docs/03-technical-design.md)
4. [`docs/04-implementation-plan.md`](./docs/04-implementation-plan.md)
5. [`docs/00-concept.md`](./docs/00-concept.md)

AI agents and implementers should also read [`AGENTS.md`](./AGENTS.md) before making changes.

## Current Implementation Milestone

The implemented milestone includes:

- **Tasks 1–3 / Checkpoint A:** package foundation, Herdr protocol compatibility, and validated YAML configuration;
- **Tasks 4–6 / Checkpoint B:** named session discovery, dynamic exact-one target resolution, and read-only targets/status/doctor CLI commands;
- **Tasks 7–9 / Checkpoint C:** bounded structured prompt delivery, bounded raw reads, and an explicit semantic-reader capability boundary;
- **Tasks 10–11 / Checkpoint D:** client-neutral MCP tools and local stdio transport;
- **Tasks 12–13 / Checkpoint E:** opt-in Streamable HTTP, provider-neutral bearer verification, independent scope authorization, and per-principal target allowlists;
- **Task 14 compatibility path:** Secure MCP Tunnel v0.0.14 external resource/audience handling without weakening the private `/mcp` identity;
- **Tasks 15–16 / Checkpoint F preparation:** operator documentation, safe `init`, packed-install verification, and CI/release automation with npm trusted publishing.

A live ChatGPT workspace test and provider-specific OAuth deployment remain external
operational evidence. The Gateway does not claim public plugin hosting or a specific
ChatGPT plan's write capability.

## MCP SDK compatibility evidence

The MCP adapter uses the official v2 package split pinned to **`@modelcontextprotocol/server@2.0.0`**, **`@modelcontextprotocol/client@2.0.0`**, and **`@modelcontextprotocol/node@2.0.0`**. Immediately before implementation, `npm view ... version dist-tags --json` reported `2.0.0` with `latest: 2.0.0` for all three. The published v2 declarations confirm `McpServer`/`registerTool` and per-request `createMcpHandler(...)` from the server package, `toNodeHandler(...)` from the Node adapter, official `OAuthTokenVerifier`/`verifyBearerToken(...)` and `getOAuthProtectedResourceMetadataUrl(...)` resource-server seams, `serveStdio(...)` for unchanged local stdio, and `Client` with `StreamableHTTPClientTransport` for real-client tests. The lockfile records exact package integrities.

## Safety Principles

- Never hard-code a Herdr pane ID as target identity.
- Resolve targets from configured Herdr session + expected FirstMate CWD + expected agent kind.
- Require exactly one matching live target; fail closed otherwise.
- Treat prompts and configuration as data, not shell commands.
- Never automatically retry uncertain prompt delivery.
- Do not start a public network listener by default.
- Keep authentication and Gateway authorization separate for remote operation.
- Do not persist Gateway transcripts or log prompt/output content by default.

## License

MIT. See [`LICENSE`](./LICENSE).
