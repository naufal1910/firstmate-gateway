# FirstMate Gateway

A safe gateway for connecting ChatGPT and other clients to FirstMate instances running under Herdr.

> **Status:** Phase 2 Tasks 4–6 and Checkpoint B are implemented: read-only target listing, dynamic status resolution, and diagnostics are available. Prompt delivery, raw-read product flow, MCP, HTTP, and authentication remain intentionally disabled.

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

The current milestone exposes the reusable YAML validator, Herdr session locator, exact-one target resolver, Gateway Core read-only operations, and the structured Herdr socket compatibility client as TypeScript APIs. It does not expose prompt delivery, raw-read product flow, MCP, HTTP, authentication, or authorization commands; those belong to later authorized tasks.

Read-only CLI usage:

```sh
firstmate-gateway targets
firstmate-gateway status firstmate2
firstmate-gateway doctor
firstmate-gateway targets --json
firstmate-gateway status firstmate2 --json
firstmate-gateway doctor --json
```

`targets` lists only logical aliases, expected agent kinds, and Herdr session names. `status` discovers the current runtime agent on every invocation. `doctor` checks configuration, Herdr session discovery, the discovered socket, protocol compatibility, and exact-one target resolution. Runtime pane IDs are never configuration identity.

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

The implemented milestone is Phase 2:

- **Tasks 1–3 / Checkpoint A:** package foundation, Herdr protocol compatibility, and validated YAML configuration;
- **Task 4:** named Herdr session discovery with argv-style, non-shell execution;
- **Task 5:** dynamic exact-one target resolution using agent kind and canonical foreground CWD/CWD evidence;
- **Task 6 / Checkpoint B:** read-only `targets`, `status`, and `doctor` CLI commands with stable JSON output.

Do not continue into Task 7 or later without explicit approval.

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
