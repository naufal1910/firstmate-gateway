# FirstMate Gateway — Implementation Plan

## Overview

Build `firstmate-gateway` as a public TypeScript/Node.js gateway that safely connects external clients to one or more FirstMate instances running under Herdr.

The implementation progresses from a locally testable Gateway Core and CLI to MCP and secured remote access.

The first real integration target is the developer's current FirstMate2 environment, configured locally as:

```text
logical target: firstmate2
Herdr session:  firstmate-b
FirstMate home: /home/agent/workspace/firstmate2
agent kind:     pi
```

These values are local validation data, not public defaults. The implementation must never depend on a persisted pane ID.

## Planning Context

Source of truth:

- `docs/02-product-engineering-spec.md`
- `docs/01-tech-stack-decisions.md`
- `docs/03-technical-design.md`
- the validated manual Herdr → FirstMate2 prompt/read test

Known constraints:

- TypeScript;
- Node.js 24 LTS;
- ESM;
- pnpm;
- YAML configuration;
- runtime validation;
- reusable Gateway Core;
- local CLI first;
- Herdr structured socket API for programmatic agent operations;
- dynamic target resolution;
- no hard-coded pane IDs;
- no arbitrary shell/terminal API;
- raw read guaranteed;
- semantic response conditional on validated structured source;
- MCP as an adapter;
- local/private-first;
- remote MCP explicit and secured;
- GitHub + npm distribution.

## Dependency Graph

```text
Project foundation
       │
       ├──────────────► Config + target model
       │
       └──────────────► Herdr protocol compatibility
                              │
Config ────────────────────────┤
                              ▼
                    Session + socket integration
                              │
                              ▼
                       Target resolver
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
          status/doctor                 send/raw-read
                │                           │
                └─────────────┬─────────────┘
                              ▼
                    real FirstMate2 E2E
                              │
                 ┌────────────┴───────────┐
                 ▼                        ▼
          semantic-reader             MCP stdio
          capability                  adapter
                                          │
                                          ▼
                                 Remote MCP + auth
                                          │
                                          ▼
                                  ChatGPT E2E
                                          │
                                          ▼
                               packaging/docs/release
```

# Phase 1 — Establish a Testable Foundation

## Task 1: Scaffold the public TypeScript package

**Description:** Establish the minimal greenfield project foundation required to build, test, typecheck, lint, package, and expose the future `firstmate-gateway` executable.

**Acceptance criteria:**

- Project builds as TypeScript targeting Node.js 24 with ESM semantics.
- CLI entry point can display basic help/version information.
- Automated test, typecheck, and lint/static-quality entry points exist.

**Verification:**

- Run repository build/typecheck/test/lint quality gates.
- Execute built CLI and verify help output.
- Confirm package contains no local secrets or VPS-specific configuration.

**Dependencies:** None

**Estimated scope:** S

---

## Task 2: Prove the required Herdr socket protocol

**Description:** Implement the smallest structured Herdr client/probe needed to prove that the installed Herdr runtime supports the operations FirstMate Gateway requires.

Required capabilities:

```text
ping
agent.list
agent.prompt
agent.read
```

**Acceptance criteria:**

- Client exchanges structured request/response messages with a real local Herdr socket.
- Unknown response fields do not break compatible parsing.
- Missing required methods or incompatible behavior produce explicit compatibility failure.

**Verification:**

- Exercise against the running `firstmate-b` Herdr session.
- Verify at least `ping` and `agent.list` against the real runtime.
- Test representative success, protocol-error, malformed-response, and unknown-field fixtures.

**Dependencies:** Task 1

**Estimated scope:** M

**Important stop condition:** If the real Herdr protocol materially contradicts the approved technical design, stop implementation expansion and report evidence/recommended design adjustment instead of guessing.

---

## Task 3: Implement validated local configuration

**Description:** Provide YAML configuration loading and runtime validation for named FirstMate targets, plus initial setup behavior.

**Acceptance criteria:**

- Multiple aliases can declare Herdr session, FirstMate home, and agent kind.
- Invalid, duplicate, missing, or malformed values fail before Herdr operations.
- Local user config is distinct from committed example config.

**Verification:**

- Test valid single- and multi-target config.
- Test malformed YAML and invalid target definitions.
- Confirm the real `firstmate2` configuration loads without source changes.

**Dependencies:** Task 1

**Estimated scope:** M

### Checkpoint A — Foundation

Before proceeding beyond Task 3:

- build/typecheck/test/lint pass;
- Herdr structured communication is proven against the installed runtime;
- actual `firstmate2` configuration validates;
- no pane ID is persisted in configuration or code as identity;
- no public network listener exists.

**Current authorization:** Implement only Tasks 1–3 plus Checkpoint A until the user explicitly approves the next milestone.

# Phase 2 — First Read-Only Vertical Slice

## Task 4: Locate named Herdr sessions

Resolve a configured Herdr session name to its running local socket endpoint without requiring users to configure socket paths manually.

Acceptance: running session resolves; missing/stopped sessions are distinct errors; shell interpretation is not used for untrusted config.

Depends on: Tasks 2–3.

Scope: S.

---

## Task 5: Resolve FirstMate targets safely

Implement the central identity rule:

```text
configured Herdr session
+ expected agent kind
+ canonical expected FirstMate home/CWD
= exactly one current candidate
```

Acceptance:

- one match succeeds;
- zero matches → `TARGET_NOT_FOUND`;
- multiple matches → `TARGET_AMBIGUOUS`;
- no candidate is guessed.

Verify against real `firstmate2` without specifying a pane ID.

Depends on: Task 4.

Scope: M.

---

## Task 6: Deliver targets, status, and doctor through the CLI

Expected surface:

```text
firstmate-gateway targets
firstmate-gateway status <target>
firstmate-gateway doctor
```

Acceptance: logical aliases exposed; status dynamically resolved; doctor distinguishes config/Herdr/session/compatibility/target-resolution failures; machine-readable output supported.

Depends on: Task 5.

Scope: M.

### Checkpoint B — Safe Discovery

Prove config → session discovery → Herdr socket → agent list → safe target resolution → status/diagnostics with no hard-coded pane IDs.

# Phase 3 — Local Prompt/Read Control

## Task 7: Add safe prompt delivery

Add non-idempotent `sendPrompt` to Gateway Core and CLI. Support positional message, file, or stdin without shell interpolation.

Acceptance: non-empty prompt reaches exactly one resolved target; blocked/target/transport failures map to stable errors; uncertain delivery is never automatically retried.

Verify quotes, shell metacharacters, Unicode, and multiline input as data. Send a harmless exact-response prompt to real FirstMate2.

Depends on: Tasks 5–6.

Scope: M.

---

## Task 8: Add raw output reading

Provide raw Herdr reading with explicit source selection and bounded line counts.

Acceptance: raw read works; invalid counts fail; source failures are surfaced rather than silently changed.

Depends on: Task 5.

Scope: S.

---

## Task 9: Establish semantic-output capability boundary

Introduce harness-specific semantic-reader abstraction without claiming Pi support until validated.

Acceptance: semantic mode uses a separate provider interface; unsupported target returns `SEMANTIC_OUTPUT_UNAVAILABLE`; no terminal regex heuristic acts as semantic output.

Depends on: Task 8.

Scope: S.

### Checkpoint C — Local Gateway Round Trip

Prove:

```text
Gateway CLI
→ dynamic target discovery
→ Herdr
→ FirstMate2
→ exact response
→ Gateway raw read
```

No user-supplied pane ID. Gateway `send` does not wait for job completion.

# Phase 4 — MCP

## Task 10: Implement client-neutral MCP tool adapter

Tools:

```text
firstmate_list
firstmate_status
firstmate_send
firstmate_read
```

Acceptance: all tools delegate to Gateway Core; input/output schemas are explicit; `firstmate_send` is modeled as side-effecting/non-idempotent.

Depends on: Tasks 7–9.

Scope: M.

---

## Task 11: Add local MCP stdio transport

Acceptance: MCP server runs over stdio; stdout is protocol-only; diagnostics cannot corrupt protocol output; a test client can list/status/send/read.

Depends on: Task 10.

Scope: S.

### Checkpoint D — Local MCP

Prove MCP client → stdio → MCP adapter → Gateway Core → Herdr → FirstMate2.

# Phase 5 — Secure Remote MCP

## Task 12: Add Streamable HTTP transport

Acceptance: remote mode disabled by default; explicit enablement required; bounded request sizes; malformed protocol requests rejected safely.

Depends on: Task 10.

Scope: M.

---

## Task 13: Add authentication and Gateway authorization

Acceptance: unauthenticated requests rejected; read/send/diagnostics permissions enforced independently; target allowlist enforced.

Depends on: Task 12.

Scope: M.

### Checkpoint E — Remote Security Boundary

Verify:

```text
unauthenticated       → rejected
read-only             → cannot send
no diagnostics scope  → cannot raw-read
disallowed target     → rejected
allowed send          → succeeds
```

# Phase 6 — Product Validation and Publication

## Task 14: Validate ChatGPT → Gateway → FirstMate

Acceptance: ChatGPT discovers Gateway tools; read/status work remotely; where the connected plan supports write-capable custom MCP, an explicit prompt reaches FirstMate2 and output can be retrieved.

Depends on: Task 13.

Scope: M.

---

## Task 15: Complete public installation and operator documentation

Documentation must cover prerequisites, npm installation, init/configuration, `doctor`, multiple FirstMate instances, security, troubleshooting, local/remote MCP, and ChatGPT setup.

Depends on: Tasks 11 and 13; ChatGPT section depends on Task 14.

Scope: M.

---

## Task 16: Add release and npm publication automation

Acceptance: CI gates publication on build/test/typecheck/lint; package contains intended artifacts; trusted publishing/OIDC is preferred; clean-install package test succeeds.

Depends on: Tasks 1 and 15.

Scope: S.

### Checkpoint F — Release Candidate

Release candidate requires clean installation, init, doctor, multiple targets, dynamic resolution, status/send/raw read, explicit semantic-unavailable behavior where needed, local MCP, secured remote MCP, target authorization, documented ChatGPT integration, no arbitrary shell/terminal API, no committed secrets, and installability outside source checkout.

## Parallelization

Safe after contracts stabilize:

- Task 2 and Task 3 can proceed in parallel after Task 1.
- Task 7 and Task 8 can proceed in parallel after target resolution is stable.
- Task 11 and Task 12 can proceed in parallel after Task 10.
- Documentation can begin once relevant interfaces stabilize.

Must remain sequential:

```text
Herdr compatibility
→ session resolution
→ target resolution
→ write operations
```

and:

```text
remote HTTP
→ remote auth/authorization
→ ChatGPT write E2E
```

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Herdr socket API differs from expected design | High | Validate in Task 2 before higher layers |
| Wrong FirstMate receives prompt | High | Exact-one-match resolver; fail closed |
| Prompt delivery result is uncertain | High | Non-idempotent contract; no auto-retry |
| Remote MCP too permissive | High | Disabled by default; auth + scopes + target allowlist |
| Raw output leaks sensitive content | High | Separate diagnostics permission; no content logging/storage |
| Pi semantic format unstable | Medium | Semantic provider optional; raw guaranteed |
| MCP logic leaks into core | Medium | Adapter boundary and contract tests |
| Docs tied to one VPS | Medium | Generic examples and clean-install verification |
| npm name unavailable | Low | Verify before publication; use scoped package if needed |

## Open Questions

Non-blocking:

1. Is Pi session JSONL stable/supported enough for a semantic response provider?
2. Which OAuth deployment should become the recommended public guide?
3. Is the unscoped npm name available at publication time?
4. When should cross-platform support beyond initial Linux validation be added?

## Ready-to-Start Check

- [x] Tasks have acceptance criteria and verification.
- [x] Dependencies are explicit.
- [x] No XL tasks remain.
- [x] High-risk Herdr integration is tested early.
- [x] Wrong-target risk is tested before write operations.
- [x] Checkpoints cover the major phases.
- [x] Real FirstMate integration is continuous rather than postponed to the end.

**Status:** This document records the dependency-ordered scope; current implementation status is tracked in the [root README](../README.md).
