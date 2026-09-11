# AGENTS.md

## Project

FirstMate Gateway is a client-neutral, safety-constrained integration layer for connecting external clients such as ChatGPT to one or more FirstMate instances running under Herdr.

## Source of Truth

Read the project documentation in this order before implementation work:

1. `docs/02-product-engineering-spec.md` — product behavior and scope (WHAT)
2. `docs/01-tech-stack-decisions.md` — accepted technical foundation (FOUNDATION)
3. `docs/03-technical-design.md` — architecture and technical contracts (HOW)
4. `docs/04-implementation-plan.md` — dependency-ordered implementation work (IN WHAT ORDER)
5. `docs/00-concept.md` — concise product concept and original scope rationale

If these documents conflict, stop and surface the conflict rather than guessing.

## Current Implementation Authorization

Implement only the milestone explicitly authorized by the user. At repository bootstrap, the authorized milestone is **Tasks 1-3 plus Checkpoint A** from `docs/04-implementation-plan.md`.

Do not continue into later tasks without explicit user authorization.

## Engineering Constraints

- Use TypeScript on Node.js 24 LTS with ESM and pnpm.
- Keep Gateway Core independent of ChatGPT, MCP, HTTP, Telegram, Discord, or other client-specific protocols.
- Use Herdr's structured local socket API for programmatic agent operations.
- Herdr CLI may be used for session discovery, compatibility diagnostics, and operator troubleshooting where the technical design allows it.
- Never persist or hard-code Herdr pane IDs as target identity.
- Resolve targets from configured Herdr session + expected FirstMate home/CWD + expected agent kind, and require exactly one match.
- Fail closed on zero or multiple matches.
- Never expose arbitrary shell, sudo, filesystem, or generic terminal-control operations through the Gateway public surface.
- Never interpolate prompts, target aliases, paths, or other untrusted input into shell command strings.
- Do not add a database, queue, cache, or persistent Gateway transcript store unless the approved design changes.
- Raw output and semantic output are separate capabilities. Do not use brittle terminal regex parsing as the primary semantic-response mechanism.
- `send` means prompt accepted/delivered; it does not mean FirstMate completed the job.
- Prompt delivery is non-idempotent. Do not automatically retry an uncertain delivery.
- Local/private operation is the default. Do not start a public listener by default.
- Do not log prompt bodies, raw terminal output, semantic response content, or bearer tokens.

## Development Workflow

- Prefer small, reviewable changes aligned to one implementation task or checkpoint.
- Use workers when appropriate, but keep all work within the currently authorized milestone.
- Add tests for externally observable behavior rather than implementation details.
- Run the project quality gates relevant to each task.
- For Herdr integration, verify against the real configured test instance when the plan calls for it.
- Do not merge pull requests without explicit user approval.

## First Milestone Exit Criteria

Checkpoint A is complete only when:

- the project builds, typechecks, tests, and passes lint/static-quality checks;
- structured Herdr communication is proven against the installed runtime;
- a real FirstMate target configuration can be validated without source changes;
- no pane ID is persisted in configuration or code as identity;
- no public network listener exists.

If Herdr's real structured protocol materially contradicts the approved technical design, stop implementation expansion and report the evidence and recommended design adjustment.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
