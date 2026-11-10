# Majordomo

A personal project manager that runs a crew of AI agents for you.

You talk to **one** agent. Tell it about anything you are working on — a feature, a trip, a report, a bug — and it
records the project, breaks it into tasks, hands each task to a worker agent, tracks them, checks the results, and
reports back. You never juggle threads. A dashboard shows every project, task and agent live.

![The desk: chat with the manager on the left, the live crew on the right](docs/desk.png)

It runs on your own machine and uses the AI accounts you already have: **Claude, OpenAI/ChatGPT, Gemini, Meta Muse
and OpenRouter**, in any mix.

## Quick start

Requires Node 20.11+ on macOS, Linux or WSL (agents use `bash`).

```bash
npm install
```

```bash
npm start
```

Open <http://localhost:4317>. With no account connected you land on the **demo crew** — simulated agents driving the
real harness — so you can look around first. Then go to **Settings → Accounts**, connect one, and press
**Use for manager & crew**.

To run the demo crew on purpose, even with keys in your environment:

```bash
npm run demo
```

## Connecting your accounts

There are two ways an account can be used, and they are billed differently.

| Account | Subscription (flat plan) | API key (per token) |
| --- | --- | --- |
| **Claude** | Claude Code CLI — sign in once with `claude` | `ANTHROPIC_API_KEY` or paste in Settings |
| **OpenAI** | Codex CLI — `npm i -g @openai/codex`, then `codex login` | `OPENAI_API_KEY` |
| **Gemini** | Gemini CLI — `npm i -g @google/gemini-cli`, then `gemini` | `GEMINI_API_KEY` |
| **Meta Muse** | — (Meta offers Muse to developers by API key only) | `MODEL_API_KEY` |
| **OpenRouter** | — (prepaid credits) | `OPENROUTER_API_KEY` |

**Subscriptions** work through each vendor's own command-line agent. The CLI holds your login; Majordomo starts it
headless with a task and turns its event stream into dashboard activity. Majordomo never sees or stores your
subscription credentials. Usage counts against your plan's limits, and each vendor's terms decide what automated use
your plan allows — check them if you intend to run this heavily.

**API keys** are saved to `~/.majordomo/secrets.json` (mode 0600) and only ever sent to that provider. Model lists are
fetched live from each account, so nothing is hard-coded to this month's model names.

Press **Test** / **Check sign-in** on an account card to confirm it works before relying on it.

## How it works

```
 you ──▶ Project manager ──▶ create_project / create_tasks ──▶ scheduler
              ▲                                                    │
              │  <event> task finished / failed / question         ▼
              └──────────────────────────────────────────  worker agents (the crew)
                                                           each in the project's workspace folder
```

- **The manager** has tools for managing only: projects, tasks, the crew, memory, reminders, and read access to
  what agents produced so it can verify before reporting. It does not do the work itself.
- **Tasks** start automatically, in parallel up to a limit you set. `depends_on` sequences them, and a dependent task
  is handed the reports of the tasks before it.
- **Workers** get a shell, file tools, search, web fetch (plus Claude's web search on Claude models), and three ways to
  talk upward: `report_progress`, `ask_manager` (blocks until answered), and `delegate` (parallel helper agents).
- **Events** flow back to the manager, batched: a finished task wakes it, it decides what happens next, and it only
  speaks to you when there is something worth your attention.
- **The crew** is a set of named profiles (Settings → Crew). Give each a model and a line about what it is good at;
  the manager reads those to route work — a strong model for hard problems, a cheap one for legwork.
- **Memory**: the manager saves lasting facts about you (`remember`), keeps a running brief per project, and can set
  reminders to wake itself up later. Long conversations are summarised automatically before they overflow.

Everything lives in `~/.majordomo` (override with `MAJORDOMO_HOME`): a SQLite database, your keys, and one workspace
folder per project. A project can instead point at an existing folder, such as a repo.

## What you can see and do

- **Desk** — chat with the manager; the crew panel shows who is working, on what, for how long, and anything waiting
  on you.
- **Any agent** — click it for the full transcript, streaming live: its brief, every command, file and result. Type
  to steer it mid-task, answer its question, or ask a finished agent for a follow-up. Stop or retry from there.
- **Projects** — a board of each project's tasks, a browser for the files agents produced, and the goal and notes.
- **Activity** — a timeline of every agent across all projects, with tokens and cost per account.

## Safety

Agents run commands on your computer. Know what the guard rails are and are not:

- Worker file edits are confined to the project workspace. **Shell commands are not sandboxed** — a command can reach
  whatever your user account can. Set **Settings → Shell commands → Ask me before each command** to approve each one.
- That approval prompt covers agents on API keys. CLI agents cannot ask through the dashboard, so in "ask" mode they
  are limited to reading and editing files. Codex additionally runs in its own workspace sandbox by default.
- The server listens on `127.0.0.1` only and refuses requests from other sites or hostnames. To reach it from another
  device, set `MAJORDOMO_HOST` **and** `MAJORDOMO_TOKEN`; it will not start on a network address without a token.
- Agents are told to stop and ask before spending money, sending messages, publishing, or deleting outside the
  workspace. That is an instruction to a model, not an enforcement mechanism.

## Development

```bash
npm run dev
```

Runs the server with reload on :4317 and the dashboard with hot reload on :5173.

```bash
npm test
```

```bash
npm run typecheck
```

```
server/
  orchestrator.ts     scheduling, dependencies, PM wake-ups, approvals, reminders
  agents/runner.ts    the agent loop: inbox, tool rounds, compaction (API runtimes)
  agents/cli.ts       headless drivers for Claude Code, Codex CLI, Gemini CLI
  agents/prompts.ts   the manager's and workers' instructions
  llm/                provider adapters: anthropic.ts, openai.ts (OpenAI, Gemini, Muse, OpenRouter), demo.ts
  tools/              pm.ts (manager tools), worker.ts (worker tools)
  mcp.ts              serves the manager's tools to a CLI-hosted manager over MCP
  http.ts             REST + server-sent events + the built dashboard
web/src/              React dashboard
shared/types.ts       types shared by both
```

Environment variables: `MAJORDOMO_PORT` (4317), `MAJORDOMO_HOME`, `MAJORDOMO_HOST`, `MAJORDOMO_TOKEN`,
`MAJORDOMO_DEMO=1`, and `MAJORDOMO_CLAUDE_BIN` / `MAJORDOMO_CODEX_BIN` / `MAJORDOMO_GEMINI_BIN` to point at a CLI
that is not on your `PATH`.

## Status

What has been exercised, and how:

| Path | Verified by |
| --- | --- |
| Scheduler, dependencies, questions, follow-ups, cancel, approvals | Automated tests and browser runs on the demo crew |
| Claude subscription (Claude Code) as manager **and** worker | Real end-to-end run |
| Claude API adapter | Tests against a mock of the Messages API — not yet against the live API |
| OpenAI-compatible adapter (OpenAI, Gemini, Muse, OpenRouter) | Tests against a mock Chat Completions server — not yet against the live APIs |
| Codex CLI and Gemini CLI drivers | Written against each CLI's documented flags and event format — not yet run signed-in |

Known limits: nothing survives a restart mid-run (running agents are marked *interrupted* and can be retried);
switching the manager between a CLI and an API account starts a new conversation; there is no messaging gateway
(Telegram, Slack, …) yet — the dashboard is the only way in.
