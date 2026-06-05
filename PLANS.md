# Codex Execution Plans

This file defines how to write and maintain an executable plan, or `ExecPlan`, for this repository. An ExecPlan is a living implementation guide that a new Codex thread or a human developer can follow without knowing the earlier conversation.

## Non-Negotiable Rules

Every ExecPlan must be self-contained. It must explain the purpose, context, assumptions, exact files to edit, exact commands to run, and how to prove the result works.

Every ExecPlan must stay current. When implementation changes, update `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective`.

Every ExecPlan must produce observable behavior, not just code that compiles. Use tests, HTTP calls, CLI output, database rows, or Telegram fake-client assertions to show success.

Write in plain language. Define terms such as webhook, idempotency, worker, migration, and MCP the first time they matter.

## Required Sections

Each ExecPlan must contain these sections:

- `Purpose / Big Picture`
- `Progress`
- `Surprises & Discoveries`
- `Decision Log`
- `Outcomes & Retrospective`
- `Context and Orientation`
- `Plan of Work`
- `Concrete Steps`
- `Validation and Acceptance`
- `Idempotence and Recovery`
- `Artifacts and Notes`
- `Interfaces and Dependencies`

The `Progress` section must use checkbox items with timestamps.

The `Decision Log` section must record decisions in this format:

    - Decision: ...
      Rationale: ...
      Date/Author: ...

## How To Use Plans

Before starting non-trivial work, read the active ExecPlan and relevant wiki pages. For this project the active plan is `POSTER_BITRIX_EXECPLAN.md`.

During work, update the plan at every meaningful stopping point. If tests reveal a surprise, record it. If you choose one implementation path over another, record why.

After completing a milestone, add an outcome entry describing what changed, how it was verified, and what remains.

## Validation Expectations

Validation is mandatory. For this project, useful validation will include:

- parser tests for Bitrix webhook shapes;
- photo normalization tests for `null`, one object, and arrays;
- idempotency tests for repeated payloads;
- fake Telegram client tests for `sendMessage`, `sendPhoto`, `sendMediaGroup`, and edit flows;
- scheduled publishing tests using a controlled clock;
- health-check HTTP test once the server exists.

## Safety

Plans should be idempotent and safe to rerun. Avoid destructive migrations in early implementation. If a destructive step becomes necessary, document backup and rollback instructions before the step.

Never put secrets in plans. Refer to environment variable names such as `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DATABASE_URL`, and `OPENAI_API_KEY`.

