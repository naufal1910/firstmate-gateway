# FirstMate Gateway — Tech Stack Decisions

## Project Profile

FirstMate Gateway is a developer-facing integration layer that allows external clients such as ChatGPT, CLI tools, and future messaging/integration clients to communicate safely with one or more FirstMate instances running under Herdr.

The project is intentionally client-agnostic and is intended for public GitHub distribution.

## Decisions

| Area | Decision | Status | Rationale |
| --- | --- | --- | --- |
| Product architecture | Generic FirstMate integration gateway | Decided | ChatGPT is the first client, not a core dependency |
| Language | TypeScript | Decided | Strong typing and good CLI/MCP ecosystem |
| Runtime | Node.js 24 LTS | Decided | Stable LTS foundation |
| Module system | ESM | Decided | Modern Node package model |
| Package manager | pnpm | Decided | Efficient development workflow |
| Core boundary | Reusable TypeScript Gateway Core | Decided | Keeps transport/client logic outside the core |
| Initial surface | Local CLI over Gateway Core | Decided | Smallest independently testable interface |
| Persistent service | None initially | Deferred | Avoid premature lifecycle/network complexity |
| Configuration | YAML | Decided | Human-readable multi-target configuration |
| Validation | Runtime schema validation; Zod preferred | Decided | Fail before any FirstMate action |
| Target identity | Herdr session + FirstMate home/CWD + agent kind | Decided | Stable identity without pane persistence |
| Runtime address | Dynamically discovered pane ID | Decided | Pane IDs are transient runtime details |
| Resolution policy | Exactly one match required | Decided | Fail closed on missing/ambiguous targets |
| Output model | Semantic response + raw diagnostics | Decided | Separate client semantics from terminal noise |
| Raw output | Required | Decided | Reliable baseline capability |
| Semantic output | Only via validated structured source | Decided | Avoid brittle terminal parsing |
| MCP | Adapter over Gateway Core | Decided | Protocol does not become architecture |
| MCP timing | Included in first usable release after local validation | Decided | Reaches actual product goal safely |
| Local MCP | stdio | Decided | No listener needed |
| Remote MCP | Streamable HTTP over HTTPS | Decided | Appropriate remote MCP transport |
| Source | GitHub | Decided | Public source, docs, CI, issues |
| Distribution | npm | Decided | Natural Node distribution path |
| CLI command | `firstmate-gateway` | Decided | Stable public executable |
| Contributor workflow | Git clone + pnpm | Decided | Conventional development flow |
| Standalone binaries | Deferred | Deferred | Not required for MVP |
| Release automation | GitHub Actions | Decided | Repeatable release validation |
| npm publishing | Trusted publishing / OIDC preferred | Decided | Avoid long-lived publishing tokens |
| Default deployment | Local/private-first | Decided | Minimize attack surface |
| Default listener | None | Decided | No surprise network exposure |
| Remote MCP | Explicit opt-in | Decided | Higher trust boundary |
| Anonymous public access | Prohibited | Decided | Prompt execution is privileged |
| Production remote auth | OAuth/OIDC-compatible | Decided | Durable standards-based model |
| Gateway authorization | Separate from authentication | Decided | AuthN and target/action AuthZ are distinct |

## Consequential Decision Notes

### TypeScript + Node.js

Python and Go were considered. TypeScript won because the project combines a CLI, reusable library, and MCP adapter in one coherent ecosystem. The trade-off is requiring Node unless standalone packaging is added later.

### Core + CLI before service

Gateway Core is transport-independent. CLI, MCP, HTTP, and future clients delegate to the same core. A persistent service is intentionally deferred.

### Dynamic target identity

Persistent identity is:

```text
target alias
+ Herdr session
+ expected FirstMate home/CWD
+ expected agent kind
```

The runtime pane is discovered per operation. Zero matches and multiple matches both fail closed.

### Output semantics

Raw output is guaranteed. Semantic output is only available through a validated structured provider. Terminal regex scraping is not an acceptable primary semantic mechanism.

### MCP timing

Implementation order is:

```text
Gateway Core
→ CLI
→ real FirstMate validation
→ MCP adapter
→ ChatGPT validation
```

### Security posture

Local/private-first. Remote MCP is explicit opt-in, authenticated, and separately authorized by operation and target.

## Technical Constraints

- Gateway Core must not depend on ChatGPT, MCP, HTTP, Telegram, Discord, or another specific client.
- MCP handlers delegate to Gateway Core.
- Public configuration cannot assume the original developer's machine paths.
- Pane IDs are never persistent identity.
- Zero/multiple target matches fail closed.
- No arbitrary shell/sudo/filesystem/generic terminal operation is exposed.
- Semantic response extraction does not depend primarily on terminal regexes.
- Local operation does not require a public listener.
- Remote networking is opt-in.
- Authentication and authorization remain separate.
- FirstMate remains the orchestrator.

## Deferred / Not Required

Deferred: standalone binaries, persistent HTTP daemon, generic REST API, messaging integrations, advanced multi-user authorization, specific OAuth provider, container packaging, response caching/history, background orchestration.

Not required initially: database, object storage, payments, web UI, generic Herdr administration, arbitrary terminal control, remote filesystem API, infrastructure orchestration, agent scheduling.

## Open Decisions

No foundational platform decision blocks technical design or implementation planning.

## Readiness

**Ready for technical design**
