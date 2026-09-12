# FirstMate Gateway

A safe gateway for connecting ChatGPT and other clients to FirstMate instances running under Herdr.

> **Status:** Phase 4 Tasks 10–11 and Checkpoint D are implemented: four client-neutral MCP tools are available over local stdio. HTTP and authentication remain intentionally disabled.

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
- npm as the planned primary distribution channel

## Local foundation

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

The current milestone exposes the reusable YAML validator, Herdr session locator, exact-one target resolver, Gateway Core status/send/read operations, and the structured Herdr socket client as TypeScript APIs. Prompt delivery is bounded and non-idempotent; raw reads use explicit bounded sources. Semantic reads are a separate provider boundary and currently return `SEMANTIC_OUTPUT_UNAVAILABLE` because no Pi semantic source contract has been validated. MCP, HTTP, authentication, and authorization commands remain intentionally disabled.

CLI usage:

```sh
firstmate-gateway targets
firstmate-gateway status firstmate2
firstmate-gateway send firstmate2 "Reply exactly with: ..."
printf '%s' 'prompt from stdin' | firstmate-gateway send firstmate2
firstmate-gateway send firstmate2 --file ./prompt.txt
firstmate-gateway read firstmate2
firstmate-gateway read firstmate2 --source recent --count 40 --json
firstmate-gateway read firstmate2 --semantic --json
firstmate-gateway doctor
firstmate-gateway-mcp
```

`firstmate-gateway-mcp` is the minimal local MCP stdio entry point. Its stdout is reserved exclusively for MCP protocol traffic; diagnostics go to stderr. It does not start a listener or manage FirstMate/Herdr lifecycle state. It exposes exactly `firstmate_list`, `firstmate_status`, `firstmate_send`, and `firstmate_read`.

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

The implemented milestone is Phase 3:

- **Tasks 1–3 / Checkpoint A:** package foundation, Herdr protocol compatibility, and validated YAML configuration;
- **Tasks 4–6 / Checkpoint B:** named session discovery, dynamic exact-one target resolution, and read-only targets/status/doctor CLI commands;
- **Task 7:** bounded, structured `agent.prompt` delivery with no automatic retry after uncertainty;
- **Task 8:** bounded raw `agent.read` with explicit source validation and dynamic re-resolution;
- **Task 9:** separate semantic-reader provider boundary with explicit unavailable behavior;
- **Checkpoint C:** real local Gateway CLI prompt/read round trip;
- **Tasks 10–11 / Checkpoint D:** client-neutral MCP tools and local stdio transport.

Remote HTTP, authentication, authorization, and release work are not included in this milestone.

## MCP SDK compatibility evidence

The MCP adapter uses the official v2 package split pinned to **`@modelcontextprotocol/server@2.0.0`** and **`@modelcontextprotocol/client@2.0.0`**. Immediately before updating the lockfile, `npm view @modelcontextprotocol/server version dist-tags --json` and the equivalent client command both reported `2.0.0` with `latest: 2.0.0`. The official v2 documentation ([overview](https://ts.sdk.modelcontextprotocol.io/v2/) and [protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)) identifies v2 as the stable line. The published v2 declarations confirm `McpServer`/`registerTool` from `@modelcontextprotocol/server`, `serveStdio(...)` from `@modelcontextprotocol/server/stdio`, and `Client`/`StdioClientTransport` from `@modelcontextprotocol/client` and `/stdio`; the lockfile records the exact package integrities.

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
