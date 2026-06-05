# bitrix-tg Agent Guide

This file is the first project document Codex should read. It describes the current project state, expected stack, key commands, safety rules, and how to use Ruflo without letting generated workflow noise take over the repository.

## Project Purpose

`bitrix-tg` is intended to replace an n8n workflow with a real service. The service receives Bitrix webhook JSON, ignores inactive or non-social news items, normalizes photos, fits text to Telegram limits, publishes or edits Telegram posts, stores Telegram message ids in a database, and supports scheduled publication by Bitrix activity-start time.

The detailed product knowledge lives in:

- `docs/wiki/index.md` - wiki index.
- `docs/wiki/business-rules.md` - publication and edit rules.
- `docs/wiki/data-model.md` - proposed database model.
- `docs/wiki/open-questions.md` - decisions still needing confirmation.
- `POSTER_BITRIX_EXECPLAN.md` - current executable implementation plan.
- `PLANS.md` - rules for writing and maintaining executable plans.

## Current State

The repository contains documentation, Ruflo/Codex setup files, and the first TypeScript service scaffold. `package.json` has been created with Fastify, SQLite, Vitest, and build/dev scripts. The current implementation covers webhook parsing, inactive/social filtering, photo normalization, idempotency hashing, first Telegram publishing/edit orchestration through a Telegram client interface, SQLite migrations, and focused tests. The server still needs real Telegram credentials for active publication against Telegram.

The intended first implementation stack is:

- Node.js with TypeScript.
- Fastify for the webhook HTTP server.
- SQLite for persistent post/message state in the MVP, with a later `direct_postgres` adapter only if deployment requires multiple service instances.
- Telegram Bot API via direct HTTP calls.
- OpenAI or another confirmed AI provider only for fitting text within Telegram limits.

If the user chooses a different stack, update this file and `POSTER_BITRIX_EXECPLAN.md` before coding.

## Codex Defaults

Default operating mode for this project:

- Internet/web search should be available for current documentation, package behavior, and API checks.
- File writes should stay inside the current project folder by default.
- Full filesystem access is allowed only when the user explicitly trusts the operation or asks for it.
- Use medium reasoning for repetitive implementation, config cleanup, and mechanical tasks.
- Use high or xhigh reasoning for architecture, data model decisions, migration design, Telegram edit semantics, scheduling, and security.

## Git Rules

Use git from the beginning of the project. Keep generated runtime data out of commits.

Commit candidates are source code, docs, tests, migrations, stable project config, and examples. Do not commit `.env`, `.codex/`, `.swarm/`, runtime databases, PID files, logs, or local memory stores.

If a remote is not provided, initialize local git only and ask for the remote URL before adding one.

## Planning Rules

Use `PLANS.md` for non-trivial implementation. The active plan is `POSTER_BITRIX_EXECPLAN.md`.

Before building a substantial feature:

1. Read `docs/wiki/index.md`, `docs/wiki/business-rules.md`, and `POSTER_BITRIX_EXECPLAN.md`.
2. Update the plan's `Progress`, `Decision Log`, and `Surprises & Discoveries` as new facts appear.
3. Split work into verifiable milestones.
4. Validate each milestone with tests or a concrete command.

Do not leave a plan stale after implementation. If code behavior changes the design, update the plan.

## Ruflo Usage

Ruflo is installed for this workspace. The useful installed plugins are:

- `ruflo-core@ruflo`
- `ruflo-swarm@ruflo`
- `ruflo-rag-memory@ruflo`
- `ruflo-neural-trader@ruflo`

Codex has a global MCP server named `ruflo` configured as:

    npx.cmd --yes ruflo@latest mcp start

In a fresh Codex thread, prefer MCP tools if they are available. If they are not exposed in the current thread, use CLI checks instead.

Useful Ruflo checks:

    codex.cmd plugin list
    codex.cmd mcp list
    npx.cmd --yes ruflo@latest mcp tools
    npx.cmd --yes ruflo@latest mcp exec --tool mcp_status --params "{}"
    npx.cmd --yes ruflo@latest memory stats
    npx.cmd --yes ruflo@latest daemon status

For large work, create a Ruflo swarm before coding:

    npx.cmd --yes ruflo@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized

Suggested subagent roles for this project:

- `architect` - Telegram edit semantics, database model, scheduling strategy.
- `backend` - webhook server, validation, database access, Telegram client.
- `tester` - parser tests, idempotency tests, fake Telegram integration tests.
- `reviewer` - security, secrets, failure modes, duplicate prevention.

Ruflo coordination is not a substitute for implementation. After starting a swarm or storing memory, continue coding and verifying.

## Project Commands

Current useful commands:

    git status --short
    rg --files
    codex.cmd plugin list
    codex.cmd mcp list
    npx.cmd --yes ruflo@latest memory stats
    npx.cmd --yes ruflo@latest daemon status

Current npm commands:

    npm install
    npm test
    npm run build
    npm run dev

`npm run dev` starts the Fastify server through `tsx watch src/server.ts`. For local health checks without real Telegram, provide dummy `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, but active publish requests will fail until real Telegram credentials are configured.

## Implementation Rules

Keep edits scoped to the Bitrix-to-Telegram service. Avoid unrelated refactors and avoid committing generated runtime state.

Normalize incoming `PHOTOS` to an array before business logic. Treat repeated identical webhooks as idempotent. Store multiple Telegram message ids when a Bitrix element creates an album or when photos are added after a text-only post.

Use AI only to fit text to Telegram limits, not to creatively rewrite content unless the user changes that rule. Telegram text messages are limited to 4096 characters; media captions are limited to 1024 characters.

For unknowns, prefer documenting the assumption in `POSTER_BITRIX_EXECPLAN.md` and `docs/wiki/open-questions.md` instead of hiding it in code.

## Bootstrap For Future Projects

Use `docs/RUFLO_BOOTSTRAP.md` as the reusable checklist for installing Ruflo in another project.
