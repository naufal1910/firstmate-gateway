# FirstMate Gateway — Concept

## Problem Statement

How might we let people safely control one or more FirstMate instances from ChatGPT and other clients, through Herdr, without exposing arbitrary shell access or requiring client-specific integration logic?

## Recommended Direction

Build **FirstMate Gateway** (`firstmate-gateway`) as a small, generic integration layer between external clients and FirstMate instances running under Herdr.

ChatGPT is the first supported client, but the Gateway Core remains client-agnostic so future integrations can reuse the same core.

Core principle:

```text
Client
  ↓
FirstMate Gateway
  ↓
validated, constrained operations
  ↓
Herdr
  ↓
FirstMate / Pi
```

Not:

```text
Client
  ↓
arbitrary shell / terminal access
```

## Key Assumptions to Validate

- FirstMate instances can be discovered reliably without hard-coding Herdr pane IDs.
- Herdr provides enough capability for `discover → status → prompt → read`.
- A client-neutral Gateway Core can support ChatGPT without embedding ChatGPT-specific behavior.

## MVP Scope

Initial capabilities:

- list configured targets;
- get target status;
- send a prompt;
- read recent output;
- diagnose installation/configuration.

Targets are declared with machine-local configuration such as:

```yaml
targets:
  firstmate:
    herdr_session: default
    firstmate_home: /home/agent/workspace/firstmate
    agent: pi

  firstmate2:
    herdr_session: firstmate-b
    firstmate_home: /home/agent/workspace/firstmate2
    agent: pi
```

Pane IDs are runtime addresses only and must never be persisted as target identity.

## Not Doing

- Arbitrary shell or command execution.
- Generic Herdr administration.
- ChatGPT-specific logic in Gateway Core.
- Long-running orchestration inside Gateway.
- Hard-coded pane IDs.
- Automatic guessing between multiple configured targets.
- Public internet exposure before authentication/security is designed.

## Open Questions Carried Into Design

These were resolved or intentionally deferred by the approved technical decisions/design:

- runtime/language;
- core boundary;
- configuration model;
- target discovery and identity;
- output semantics;
- MCP timing;
- public distribution;
- remote security posture.
