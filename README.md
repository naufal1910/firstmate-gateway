# FirstMate Gateway

A safe gateway for connecting ChatGPT and other clients to FirstMate instances running under Herdr.

> **Status:** the Tasks 1–3 foundation and Checkpoint A compatibility/configuration work are implemented; later product operations remain intentionally disabled.

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

The current milestone exposes the reusable YAML validator and the structured Herdr socket compatibility client as TypeScript APIs. It does not yet expose target resolution, status, prompt delivery, raw reads, MCP, HTTP, authentication, or authorization commands; those belong to later authorized tasks.

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

Only the first milestone is currently authorized:

- **Task 1:** scaffold the TypeScript package;
- **Task 2:** prove the required Herdr structured socket protocol;
- **Task 3:** implement validated local YAML configuration;
- **Checkpoint A:** verify foundation quality and real Herdr compatibility.

Do not continue into later implementation phases without explicit approval.

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
