# FirstMate Gateway operator guide

This guide covers installing the package, creating a local configuration, checking a
Herdr installation, and connecting a remote MCP client. The Gateway is local/private
by default. It never exposes a shell, sudo, filesystem, or generic terminal-control
operation.

## Prerequisites

- Node.js 24 LTS or newer;
- a supported Herdr installation with its local structured socket API available;
- one or more FirstMate instances running under Herdr; and
- for remote MCP, an operational OAuth/OIDC resource-server verifier supplied by the
  embedding host. The package does not ship a test verifier or an identity provider.

The configured Herdr session and FirstMate home are used to resolve a live target on
every operation. A pane ID is never configuration identity.

## Install

For a published package installation:

```sh
npm install --global firstmate-gateway
firstmate-gateway --version
```

For a project-local installation:

```sh
npm install firstmate-gateway
npx firstmate-gateway --version
```

When working from a source checkout, use the pinned package manager and run the full
quality gate:

```sh
corepack pnpm install --frozen-lockfile
pnpm check
```

The release workflow also performs a packed-artifact clean-install check. Do not use
an untrusted or development package when configuring a live FirstMate target.

## Initialize and configure

Create a configuration template without overwriting an existing file:

```sh
firstmate-gateway init
```

By default this creates `config/local.yaml` below the current working directory. Use
an explicit path, or the `FIRSTMATE_GATEWAY_CONFIG` environment variable for all
commands:

```sh
firstmate-gateway init --path "$HOME/.config/firstmate-gateway/local.yaml"
export FIRSTMATE_GATEWAY_CONFIG="$HOME/.config/firstmate-gateway/local.yaml"
```

`init` refuses to replace an existing file. `--force` is an explicit replacement
operation and should only be used after reviewing the path:

```sh
firstmate-gateway init --path "$FIRSTMATE_GATEWAY_CONFIG" --force
```

Edit the generated file with the exact Herdr session name, absolute FirstMate home,
and expected agent kind:

```yaml
version: 1

targets:
  firstmate2:
    herdr_session: firstmate-b
    firstmate_home: /srv/firstmate2
    agent: pi

  firstmate3:
    herdr_session: firstmate-c
    firstmate_home: /srv/firstmate3
    agent: pi

remote:
  enabled: false
```

Target aliases must be unique and use the documented lowercase format. To support
multiple instances, add another named target; do not copy a pane ID into the file.
When remote authorization is enabled, every principal's target list must name only
configured aliases.

## Diagnose before operating

Run the read-only diagnostic command after editing the file:

```sh
firstmate-gateway doctor
firstmate-gateway doctor --json
```

`doctor` validates configuration, finds the named Herdr sessions, checks their
structured sockets and protocol compatibility, and resolves each configured target
using the live session evidence. It does not send prompts or read output. Fix a
failed check before using `send` or `read`.

Useful local commands are:

```sh
firstmate-gateway targets --json
firstmate-gateway status firstmate2
firstmate-gateway send firstmate2 "literal prompt text"
firstmate-gateway send firstmate2 --file ./prompt.txt
printf '%s' 'literal prompt text' | firstmate-gateway send firstmate2
firstmate-gateway read firstmate2 --source recent-unwrapped --count 120
firstmate-gateway read firstmate2 --semantic
firstmate-gateway-mcp
```

`send` reports prompt acceptance/delivery, not completion. Delivery is non-idempotent:
an uncertain result must not be retried automatically. Raw reads are bounded and do
not silently switch to another source. Semantic output is a separate optional
capability and reports `SEMANTIC_OUTPUT_UNAVAILABLE` when no validated provider is
available.

## Local MCP

`firstmate-gateway-mcp` uses stdio and exposes exactly these client-neutral tools:

- `firstmate_list`;
- `firstmate_status`;
- `firstmate_send`; and
- `firstmate_read`.

Keep stdout reserved for MCP traffic. The stdio adapter does not open a network
listener and does not manage Herdr or FirstMate lifecycle state.

## Secured remote MCP

Remote Streamable HTTP is disabled unless the validated configuration says otherwise.
A remote host must supply an operational OAuth/OIDC verifier to the library API:

```ts
import { startRemoteMcp } from 'firstmate-gateway';

await startRemoteMcp({ tokenVerifier: verifier });
```

The embedding host is responsible for TLS termination and for supplying the verifier
and, when needed, an OIDC-aware principal resolver. Configuration alone is not an
authentication implementation. The remote listener publishes protected-resource
metadata at the path-aware `/.well-known/oauth-protected-resource/mcp` endpoint and
keeps the private Gateway resource at `/mcp`.

A minimal enabled configuration must include all of the following:

```yaml
remote:
  enabled: true
  bind_host: 127.0.0.1
  port: 3100
  resource: https://gateway.example.com/mcp
  authorization_servers:
    - https://identity.example.com/tenant
  allowed_hosts: [gateway.example.com]
  allowed_origins: []
  authorization:
    principals:
      chatgpt-workspace-client:
        targets: [firstmate2]
```

Use a private loopback bind behind a trusted TLS reverse proxy or private tunnel.
Non-loopback binding requires the separate `allow_public_bind: true` opt-in; it is
never inferred from a resource URL. Bearer authentication, exact token-resource
matching, expiration, scopes, principal policy, target allowlists, Host/Origin
allowlists, request bounds, and timeouts are enforced before Gateway invocation.

The relevant permissions are independent:

- `firstmate-gateway:read` for list/status and semantic read;
- `firstmate-gateway:send` for prompt delivery; and
- `firstmate-gateway:diagnostics` for raw output.

Grant only the scopes and target aliases required by each principal. Do not put
bearer tokens in YAML, source, shell history, or documentation.

## ChatGPT through Secure MCP Tunnel

Secure MCP Tunnel is a private outbound transport, not public plugin hosting. Keep
the Gateway bound privately and use the installed tunnel client's documented
existing-tunnel attachment flow. For tunnel-client v0.0.14 the connector-facing
resource has the exact form:

```text
https://<tunnel-origin>/v1/mcp/tunnel_<32-lowercase-letters-or-digits>
```

Set that exact HTTPS URL as `remote.external_resource`; keep `remote.resource` as the
Gateway's private `/mcp` identity. The tunnel service rewrites protected-resource
metadata and bearer challenges for the connector, while the Gateway still validates
tokens against exactly the configured external resource rather than accepting either
identity.

With a tunnel ID supplied through the documented tunnel-client profile/attachment
workflow, point the connector at the private Gateway MCP URL, for example:

```sh
tunnel-client runtimes connect \
  --tunnel-id tunnel_<32-lowercase-letters-or-digits> \
  --mcp-server-url http://127.0.0.1:3100/mcp
```

Use the exact command and endpoint form supported by the installed tunnel-client
release. Do not expose a raw public Gateway listener, do not substitute a different
path, and do not use a tunnel ID as a FirstMate target identity.

In the ChatGPT workspace's supported MCP/connector settings, add the MCP endpoint
published by the connected tunnel and complete the configured authorization flow.
Product UI labels, workspace policy, and write-capable custom-MCP availability vary
by plan. Verify in this order:

1. the connector discovers the four Gateway tools;
2. `firstmate_list` and `firstmate_status` return only the principal's allowed target;
3. an explicit `firstmate_send` prompt is accepted when the plan and scope allow writes;
4. `firstmate_read` observes the result only when the principal has diagnostics scope.

A read/status-only result is not evidence that write access is available. Do not
retry a prompt after an uncertain response; inspect the target separately.

## Troubleshooting

| Symptom | Safe next step |
| --- | --- |
| `init` says the file exists | Review the path; use `--force` only for an intentional replacement. |
| Configuration check fails | Run `doctor --json`, then fix the reported YAML field or path. |
| Session not found or stopped | Start the named Herdr session and confirm the configured session name. |
| Target not found or ambiguous | Confirm the FirstMate home and agent kind; the resolver requires exactly one live match. |
| Protocol/socket check fails | Upgrade or repair Herdr only after reviewing the compatibility diagnostic; no terminal fallback is used. |
| Remote startup refuses to listen | Keep remote disabled until bind, HTTPS resource, issuer, host/origin policy, authorization policy, and an operational verifier are present. |
| Remote request is `401` | Check the issuer flow and the exact token resource/audience; for Secure MCP Tunnel check `external_resource`. |
| Remote request is `403` | Check the verified principal's scope and configured target allowlist. |
| Semantic read is unavailable | Use bounded raw read, or install/inject a separately validated semantic provider. |

## Release automation

Every push and pull request runs on Node.js 24 with a frozen pnpm install, typecheck,
lint, build, tests, and the packed clean-install check. The release workflow repeats
those checks for `v*.*.*` tags and verifies that the tag version equals
`package.json`.

The publish job uses npm trusted publishing through GitHub Actions OIDC. Configure
the npm package's trusted publisher for this repository and the exact
`.github/workflows/release.yml` filename; this repository URL is declared in
`package.json`. The workflow grants `id-token: write` only to the publish job and
passes no npm token. The configured GitHub environment name is `npm`; add approval
rules there if the release process requires a human approval. A manual workflow run
on a non-tag ref performs validation only.

Do not publish from a local shell, add a long-lived npm token to Actions, or create a
release tag until the package name, version, changelog/release decision, and live
operator evidence have been reviewed.

## Security and operations

- Keep `config/local.yaml` and any alternate local configuration outside version
  control; the template contains no credentials.
- Review `git diff` and `git status` before committing configuration or release work.
- Never log prompt bodies, raw output, semantic response content, bearer tokens, or
  runtime keys.
- Do not add arbitrary shell or terminal-control commands to the Gateway surface.
- Keep remote mode off when it is not needed, and prefer loopback plus a private
  outbound tunnel.
- Treat `send` as a non-idempotent operation and resolve target state again before
  every operation.
- Rotate or revoke credentials through the identity/tunnel providers, not through
  Gateway configuration.
