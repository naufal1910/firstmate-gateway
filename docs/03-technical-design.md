# FirstMate Gateway — Technical Design

## Executive Summary

FirstMate Gateway is a small, client-neutral control boundary between external clients and FirstMate instances running under Herdr.

Major components:

- Gateway Core;
- configuration loader;
- Herdr session locator;
- Herdr structured socket client;
- target resolver;
- raw/semantic output readers;
- CLI adapter;
- MCP adapter;
- remote authorization boundary.

The most important design choice is that programmatic Herdr agent operations use Herdr's structured local socket API rather than turning user prompts into shell commands. Herdr CLI may still be used for session discovery and diagnostics where needed.

```text
CLI / MCP / future clients
          ↓
     Gateway Core
          ↓
 authorization/policy
          ↓
   Target Resolver
          ↓
    Herdr Adapter
          ↓
 local Herdr socket
          ↓
      FirstMate
```

## Goals

- Multiple named targets.
- Deterministic safe target resolution.
- Status inspection.
- Prompt delivery.
- Raw output retrieval.
- Optional semantic output retrieval.
- Local CLI.
- Local MCP stdio.
- Secured remote MCP.
- Public npm distribution.
- Explicit failure semantics.

## Non-Goals

- arbitrary shell/terminal/filesystem/sudo control;
- generic Herdr administration;
- FirstMate worker orchestration;
- database/queue/cache;
- prompt history storage;
- web dashboard;
- messaging integrations;
- automatic target selection.

## Core Invariants

1. Every mutating interaction names a configured target.
2. Target identity is `Herdr session + expected FirstMate CWD + expected agent kind`.
3. Runtime pane IDs are discovered per operation and never persisted.
4. Exactly one matching candidate is required.
5. Prompts and untrusted values are never interpolated into shell command strings.
6. Prompt delivery is non-idempotent and not automatically retried after uncertain delivery.
7. No public listener starts by default.
8. Herdr remains authoritative for runtime state.
9. Gateway persists configuration only, not transcripts or runtime target state.

## Components

### Configuration Loader

Responsibilities:

- locate local configuration;
- parse YAML;
- canonicalize paths;
- validate configuration at runtime;
- return immutable typed configuration.

Preferred validation: Zod.

### Gateway Core

Conceptual stable interface:

```ts
interface FirstMateGateway {
  listTargets(): Promise<TargetSummary[]>;
  getStatus(target: TargetName): Promise<TargetStatus>;
  sendPrompt(input: SendPromptInput): Promise<SendPromptResult>;
  read(input: ReadInput): Promise<ReadResult>;
  doctor(input?: DoctorInput): Promise<DoctorReport>;
}
```

No CLI, MCP, HTTP, or ChatGPT types belong here.

### Session Locator

Maps configured Herdr session name to the currently running local socket endpoint.

Initial strategy:

1. query Herdr session list in structured JSON;
2. find the named session;
3. require it to be running;
4. obtain its socket path.

### Herdr Socket Client

Owns structured communication with a single Herdr session.

Required capabilities:

```text
ping
agent.list
agent.prompt
agent.read
```

No long-lived connection is required initially.

### Target Resolver

Input:

```text
TargetConfig + Herdr agent list
```

Output:

```text
ResolvedTarget
```

Resolution requires:

```text
expected agent kind
AND
canonical runtime foreground CWD (preferred) / CWD fallback
AND
exactly one matching candidate
```

Terminal title/workspace labels are diagnostic only.

### Output Reader

Two distinct capabilities:

```text
raw output
semantic output
```

Raw uses Herdr `agent.read`.

Semantic uses harness-specific structured providers such as a future Pi session reader. No provider may claim support until its data format is validated.

### CLI Adapter

Thin adapter over Gateway Core. Owns argument parsing, formatting, and exit-code mapping only.

Preferred CLI library: Commander.

### MCP Adapter

Maps Gateway Core into four initial tools:

```text
firstmate_list
firstmate_status
firstmate_send
firstmate_read
```

MCP code must not call Herdr directly.

### Remote Authorization Layer

Only exists in remote Streamable HTTP mode.

Controls:

```text
authenticated principal
+ operation scope
+ target allowlist
→ authorized Gateway operation
```

## Data Model

No database.

Conceptual YAML:

```yaml
version: 1

targets:
  firstmate2:
    herdr_session: firstmate-b
    firstmate_home: /home/agent/workspace/firstmate2
    agent: pi

remote:
  enabled: false
```

### TargetConfig

- name
- herdrSession
- firstmateHome
- agentKind

### ResolvedTarget

Runtime-only:

- targetName
- herdrSession
- paneId
- agentKind
- canonicalCwd
- agentStatus
- optional agentSession
- resolutionEvidence

Never persisted.

### Normalized Agent Status

```text
idle
working
blocked
done
unknown
```

Unknown future Herdr values map to `unknown` while retaining safe diagnostic detail.

## Runtime Flows

### Target Resolution

```text
Client
  ↓
Gateway Core
  ↓
Session Locator
  ↓
Herdr socket
  ↓
agent.list
  ↓
Target Resolver
  ↓
exactly one ResolvedTarget or typed failure
```

### Prompt Delivery

```text
send(target, message)
  ↓
resolve target now
  ↓
agent.prompt(current pane, message)
  ↓
accepted / typed error
```

`send` does not wait for FirstMate completion.

### Raw Read

Default raw source: `recent-unwrapped`.

Default line count: 120.

Supported source selection may include:

- visible;
- recent;
- recent-unwrapped;
- detection.

The Gateway does not silently substitute a different source when a requested source fails.

## Core Contracts

### listTargets

Returns configured safe metadata. No Herdr call required.

### getStatus

Input:

```json
{"target":"firstmate2"}
```

Output concept:

```json
{"target":"firstmate2","resolved":true,"state":"idle"}
```

Remote results do not expose local absolute paths/pane IDs by default.

### sendPrompt

Input:

```json
{"target":"firstmate2","message":"Implement the approved plan."}
```

Validation:

- target exists;
- message non-empty;
- message within configured maximum;
- exactly one runtime target resolves.

Output concept:

```json
{"target":"firstmate2","accepted":true,"requestId":"...","observedState":"idle"}
```

The request ID identifies the Gateway invocation, not a FirstMate conversational turn.

No automatic retry after uncertain delivery.

### read

Raw:

```json
{"target":"firstmate2","mode":"raw","lines":120,"source":"recent-unwrapped"}
```

Semantic:

```json
{"target":"firstmate2","mode":"semantic"}
```

If no validated provider exists, return `SEMANTIC_OUTPUT_UNAVAILABLE`. Never silently return raw text as semantic output.

## CLI Contract

Expected commands:

```text
firstmate-gateway init
firstmate-gateway doctor
firstmate-gateway targets
firstmate-gateway status <target>
firstmate-gateway send <target> <message>
firstmate-gateway read <target>
```

Support `--json` for machine-readable output.

`send` should accept exactly one message source: positional argument, `--file`, or stdin.

## Error Model

Stable machine codes:

```text
CONFIG_NOT_FOUND
CONFIG_INVALID
HERDR_NOT_FOUND
HERDR_SESSION_NOT_FOUND
HERDR_SESSION_NOT_RUNNING
HERDR_UNAVAILABLE
HERDR_INCOMPATIBLE
TARGET_NOT_CONFIGURED
TARGET_NOT_FOUND
TARGET_AMBIGUOUS
TARGET_BLOCKED
INVALID_ARGUMENT
PROMPT_TOO_LARGE
PROMPT_DELIVERY_FAILED
PROMPT_DELIVERY_UNCERTAIN
READ_FAILED
SEMANTIC_OUTPUT_UNAVAILABLE
UNAUTHENTICATED
FORBIDDEN
INTERNAL_ERROR
```

Every error includes:

- code;
- message;
- requestId;
- optional safe details.

## MCP Contract

Initial tools:

```text
firstmate_list
firstmate_status
firstmate_send
firstmate_read
```

Local transport: stdio.

Remote transport: stateless Streamable HTTP where practical.

MCP adapters provide structured schemas and delegate to Gateway Core.

## Authentication and Authorization

Remote trust boundary:

```text
Remote client
  ↓
OAuth access token
  ↓
resource-server validation
  ↓
Gateway operation authorization
  ↓
target allowlist
  ↓
Gateway Core
  ↓
Herdr
```

The private Streamable HTTP listener resource is `/mcp`. A transport such as
OpenAI Secure MCP Tunnel may rewrite the connector-facing protected-resource
identity to an external `/v1/mcp/tunnel_<id>` URL. The configuration may carry
that external identity separately; the Gateway keeps publishing metadata for the
private `/mcp` resource and validates token resource claims against exactly the
configured external identity. It must never accept either identity as a fallback.
The external identity is restricted to an HTTPS tunnel URL with the exact
`tunnel_<32 lowercase letters or digits>` path form.

Suggested scopes:

```text
firstmate-gateway:read
firstmate-gateway:send
firstmate-gateway:diagnostics
```

Raw terminal output requires diagnostics permission because it may contain sensitive development data.

## Security and Privacy

- No shell interpolation for prompt delivery.
- No arbitrary shell/sudo/filesystem/generic terminal API.
- Local config excluded from Git.
- `init` must not overwrite existing config without explicit intent.
- Logs may include request ID, operation, target alias, duration, result/error code, and Herdr session.
- Logs must not include prompt bodies, raw output, semantic response text, or bearer tokens.
- Gateway stores no transcript history.

## Concurrency and Consistency

Herdr is the source of truth for live state.

Every operation re-resolves its target immediately before use. Pane IDs are not cached as long-lived identity.

Gateway does not provide a send queue or strict ordering between independent clients.

## Compatibility Strategy

`doctor` should verify:

1. Herdr executable present;
2. configured session exists/runs;
3. session socket responds;
4. required API methods exist;
5. configured target resolves.

Protocol parsing should tolerate unknown fields while validating required ones.

## Failure Behavior

| Failure | Behavior |
| --- | --- |
| Herdr missing | diagnostic failure; no fallback |
| session stopped | target unavailable |
| zero matches | refuse |
| multiple matches | refuse as ambiguous |
| target blocked | surface blocked error; no terminal-control bypass |
| prompt timeout/uncertain result | do not auto-retry |
| raw read failure | surface exact failure |
| semantic provider unavailable | explicit semantic-unavailable error |
| invalid/unauthorized remote request | reject before Gateway action |

Gateway failure must not restart/terminate FirstMate or Herdr.

## Testing Strategy

### Gateway Core

Use controlled Herdr test doubles for deterministic behavior. Cover config validation, target resolution, status normalization, send, read, blocked/uncertain delivery, and semantic-unavailable behavior.

### Herdr Protocol Contracts

Use structured fixtures captured from real Herdr responses. Unknown fields must not break parsing. Required fields and error mappings remain validated.

### CLI Black-Box

Exercise the built executable, including multiline prompts, quotes, shell metacharacters, Unicode, stdin/file input, exit codes, and `--json`.

### Real Herdr Integration

Opt-in test against a dedicated configured FirstMate instance. The test must discover the runtime pane dynamically.

### MCP

Test tools through an MCP client surface rather than directly invoking handlers.

### Security

Verify missing/invalid credentials, read-only cannot send, no diagnostics scope cannot raw-read, and disallowed targets are rejected.

## Risks / Tracked Assumptions

### Pi semantic response provider

The native Pi session format has not yet been validated as a stable dependency. Raw output remains the guaranteed baseline.

### Herdr protocol evolution

Mitigate with defensive parsing, required-method checks, protocol fixtures, and clear compatibility diagnostics.

### Raw output leakage

Mitigate through diagnostics permission, no content logging, no transcript storage, and remote opt-in.

### ChatGPT write capability

Whether a specific ChatGPT plan can invoke write-capable custom MCP tools is an external product constraint, not a Gateway architecture constraint.

## Implementation Seams

- package/build foundation;
- configuration loader;
- Gateway domain types/errors;
- Herdr session locator;
- Herdr socket protocol client;
- target resolver;
- Gateway Core operations;
- raw reader;
- semantic capability boundary;
- CLI adapter;
- MCP adapter;
- stdio transport;
- remote transport;
- remote auth/authorization;
- diagnostics/observability;
- real Herdr integration verification;
- packaging/docs/release.

## Planning Readiness

**Ready for planning with tracked assumptions.**
