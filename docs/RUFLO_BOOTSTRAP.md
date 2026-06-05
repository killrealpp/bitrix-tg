# Ruflo Bootstrap Checklist For Future Projects

Use this checklist when starting a new Codex project that should have Ruflo, planning discipline, internet access, and workspace-scoped safety.

## 1. Initialize Git

Start git immediately so generated setup can be reviewed:

    git init
    git status --short

Add a `.gitignore` before committing. At minimum ignore:

    node_modules/
    dist/
    build/
    coverage/
    .env
    .env.*
    !.env.example
    .codex/
    .swarm/
    ruvector.db
    agentdb.rvf
    agentdb.rvf.lock
    .claude-flow/data/
    .claude-flow/logs/
    .claude-flow/sessions/
    .claude-flow/daemon.pid
    .claude-flow/daemon-state.json
    .claude/memory.db

## 2. Configure Codex Defaults

Use internet, but keep file access scoped to the workspace by default:

    web_search = "live"
    sandbox_mode = "workspace-write"
    approval_policy = "on-request"

Use full access only when the user explicitly trusts the operation:

    sandbox_mode = "danger-full-access"
    approval_policy = "never"

For normal implementation and repetitive tasks, use medium reasoning. For architecture, data models, security, migrations, and large design choices, use high or xhigh reasoning.

## 3. Add Ruflo Marketplace And Plugins

On Windows, prefer `.cmd` commands so PowerShell execution policy does not block `.ps1` shims:

    codex.cmd plugin marketplace add ruvnet/ruflo
    codex.cmd plugin add ruflo-core@ruflo
    codex.cmd plugin add ruflo-swarm@ruflo
    codex.cmd plugin add ruflo-rag-memory@ruflo
    codex.cmd plugin add ruflo-neural-trader@ruflo

Verify:

    codex.cmd plugin list

The four plugins should show `installed, enabled`.

## 4. Initialize Ruflo For Codex

Run the Codex setup:

    npx.cmd --yes ruflo@latest init --codex --full

This creates `AGENTS.md`, `.agents/`, `.codex/`, and project skill config. Review `AGENTS.md` afterwards because generated text is generic and should be rewritten for the real project.

Register MCP manually if `codex.cmd mcp list` does not show `ruflo`:

    codex.cmd mcp add ruflo -- npx.cmd --yes ruflo@latest mcp start

Verify:

    codex.cmd mcp list
    npx.cmd --yes ruflo@latest mcp tools
    npx.cmd --yes ruflo@latest mcp exec --tool mcp_status --params "{}"

## 5. Initialize Runtime, Memory, And Swarm

If Ruflo runtime commands say the project is not initialized, add runtime config:

    npx.cmd --yes ruflo@latest init --skip-claude --full --with-embeddings

Then initialize memory and a starter swarm:

    npx.cmd --yes ruflo@latest memory init --force
    npx.cmd --yes ruflo@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
    npx.cmd --yes ruflo@latest daemon start

Verify:

    npx.cmd --yes ruflo@latest memory stats
    npx.cmd --yes ruflo@latest swarm status
    npx.cmd --yes ruflo@latest daemon status

## 6. Create Project Instructions

Rewrite `AGENTS.md` after setup. It should describe:

- project purpose;
- current implementation state;
- stack;
- key commands;
- git rules;
- safety rules;
- planning rules;
- installed plugins and skills;
- how to use Ruflo subagents;
- open questions and important domain constraints.

Keep `AGENTS.md` concise. Do not leave a generated list of 100+ skills unless it is genuinely useful.

## 7. Use PLANS.md

Create `PLANS.md` in the repo and require an ExecPlan for substantial work. The plan should be self-contained and include progress, decisions, surprises, validation, and recovery steps.

For a new feature, the ideal flow is:

1. Build or update the ТЗ.
2. Create an ExecPlan.
3. Create a Ruflo swarm with roles matching the ТЗ.
4. Implement in milestones.
5. Verify each milestone.
6. Update the plan and memory.

## 8. Restart Codex When Needed

Installed plugins and newly registered MCP servers may not appear inside an already-running Codex thread. After setup, open a new thread or restart Codex so the new tools are loaded.

