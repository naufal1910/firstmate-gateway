# FirstMate Gateway — Product & Engineering Specification

## Problem Statement

FirstMate users primarily interact with a running FirstMate instance through its terminal environment. That creates friction when a user wants to brainstorm, plan, or review work in a separate client such as ChatGPT and then hand approved work to FirstMate for execution.

The user needs a safe way to identify one of multiple FirstMate instances, inspect its state, send a prompt, retrieve output, and later connect external clients without exposing arbitrary shell access, depending on unstable Herdr pane IDs, or embedding ChatGPT-specific behavior into the core integration.

A manual integration test already proved that a prompt can be sent to FirstMate2 through Herdr and its output read back.

## Solution

Build `firstmate-gateway` as a client-neutral integration layer between external clients and FirstMate instances running under Herdr.

Initial capabilities:

- list configured targets;
- resolve target status;
- send prompt to a target;
- read target output;
- diagnose installation/configuration.

The first public user interface is a local CLI. MCP is an adapter over Gateway Core and is added after local core/CLI validation.

## User Stories

1. A user can define one or more named FirstMate targets.
2. Each target maps to a Herdr session, expected FirstMate home/CWD, and expected agent kind.
3. Target configuration lives outside source code.
4. An example config is committed while real local config remains untracked.
5. `firstmate-gateway init` helps establish local configuration.
6. `firstmate-gateway doctor` checks prerequisites and target configuration.
7. Herdr unavailability is reported explicitly.
8. Missing/stopped Herdr sessions produce distinct failures.
9. Runtime panes are discovered dynamically.
10. Target resolution uses session + expected CWD + agent kind.
11. Resolution succeeds only for exactly one live match.
12. Zero matches fail closed.
13. Multiple matches fail closed as ambiguous.
14. Terminal title/workspace labels are diagnostics only.
15. `firstmate-gateway targets` lists configured logical targets.
16. `status <target>` reports normalized runtime state without requiring pane IDs.
17. A user can send a normal text prompt to an explicit target.
18. Unknown target aliases are rejected.
19. Identity validation failure prevents prompt delivery.
20. Prompt delivery uses supported Herdr agent automation rather than simulated keyboard input.
21. Raw recent output can be retrieved for diagnostics.
22. Semantic response output is only exposed through a validated structured source.
23. Semantic extraction never silently falls back to raw terminal noise.
24. Gateway Core exposes reusable operations independently of CLI/MCP.
25. CLI delegates to Gateway Core.
26. MCP delegates to Gateway Core.
27. Another client adapter can be added without rewriting target discovery or Herdr integration.
28. ChatGPT can eventually list/status/send/read through MCP.
29. Arbitrary shell execution is not part of the public API.
30. Local installation does not start a public listener.
31. Remote MCP is explicit opt-in.
32. Anonymous public remote access is rejected.
33. Authentication and Gateway authorization are separate controls.
34. Remote clients are limited to allowed operations and allowed targets.
35. Public installation is available through npm.
36. Contributors can clone and use pnpm.
37. Invalid YAML/target definitions fail before Herdr action.
38. Errors distinguish configuration, target resolution, Herdr failures, and semantic-output unavailability.
39. FirstMate remains the orchestrator; Gateway does not become a second orchestrator.
40. The first usable release proves a real ChatGPT → Gateway → FirstMate round trip where the client plan permits write-capable MCP.

## Implementation Decisions

### Runtime

- TypeScript
- Node.js 24 LTS
- ESM
- pnpm

### Product Boundary

The normal capability surface is intentionally narrow:

```text
list
status
send
read
doctor
```

No generic Herdr administration or arbitrary terminal/shell control is exposed.

### Configuration

YAML is primary. Configuration is runtime-validated. Zod is preferred. Machine-specific values remain local and are never hard-coded.

### Target Identity

Persistent identity:

```text
logical target alias
+ Herdr session
+ expected FirstMate home/CWD
+ expected agent kind
```

Runtime pane ID is discovered per operation and never persisted as identity.

### Resolution

```text
0 matches  → TARGET_NOT_FOUND
1 match    → proceed
2+ matches → TARGET_AMBIGUOUS
```

### Herdr Interaction

Use Herdr's supported structured agent automation path. Do not depend on terminal keystroke simulation.

### Output Model

Two explicit modes:

- raw output: required diagnostic capability;
- semantic response: only through validated structured data.

Terminal regex extraction is not a primary reliable mechanism.

### MCP

MCP is part of the first usable product but follows local core/CLI validation. Local MCP uses stdio; remote MCP uses Streamable HTTP over HTTPS.

### Distribution

GitHub source, npm distribution, `firstmate-gateway` executable, `npx` support, Git clone + pnpm for contributors. Standalone binaries are deferred.

### Security

Local/private-first. Remote mode is opt-in, authenticated, and separately authorized. No arbitrary shell, sudo, filesystem, or generic terminal execution.

## Testing Decisions

Primary stable seams:

1. **Gateway Core public API** — configuration, discovery, exact-one-match resolution, status, send, read, semantic-unavailable behavior, errors.
2. **CLI black-box behavior** — `doctor`, `targets`, `status`, `send`, `read`, exit codes/stdout/stderr.
3. **Real Herdr ↔ FirstMate integration** — dynamic target discovery, prompt delivery, output retrieval against a configured test FirstMate.

The real integration test must never depend on a persisted pane ID.

## Definition of Done for First Usable Release

- valid targets configurable without source edits;
- invalid config fails before action;
- targets resolve dynamically without pane IDs;
- zero/multiple matches fail closed;
- status works;
- prompt reaches real FirstMate2;
- raw output can be retrieved;
- semantic output either works via validated provider or explicitly reports unavailable;
- CLI black-box tests exist;
- Gateway Core behavior tests exist;
- MCP delegates to Gateway Core;
- remote auth/authorization boundaries are enforced;
- ChatGPT integration is validated where the connected plan supports the required operation;
- no arbitrary shell/terminal operation is exposed;
- no public listener starts by default.

## Out of Scope

- generic Herdr administration;
- arbitrary shell/terminal/filesystem/sudo APIs;
- database or persistent Gateway state;
- web UI;
- payments/storage;
- agent scheduling/background orchestration;
- replacing FirstMate orchestration;
- automatic target guessing;
- standalone binary packaging;
- Telegram/Discord integrations;
- advanced multi-user permissions;
- generic REST API;
- long-term response history/cache;
- provider-specific OAuth implementation details.

## Further Notes

The repository must remain usable by people who know FirstMate/Herdr but know nothing about the original VPS layout.

The validated development environment currently includes a FirstMate2 instance under Herdr session `firstmate-b`, but that value is test environment data, not a public project default.

The structured Pi semantic-response format remains a tracked technical uncertainty and does not block implementation because raw read is the guaranteed baseline.
