# Grok Bot Model Watch

A companion for [Grok Bot](https://docs.x.ai/grok-bot/overview) that shows, live, everything
that can be known about **which model is behind each of your Bots**, with the strength of
each piece of evidence stated next to it. It comes with a plugin that teaches your Bots to
answer "which model are you?" honestly.

## What you will and will not see

- **On a normal plan you will see:** when each Bot is working, what kind of turn it was
  (chat, routine, computer use), token counts per request, Cursor's own per-Bot totals for
  the day, and your weekly allowance. Bot status updates every few seconds; usage rows
  follow within seconds to minutes.
- **You will not see the model.** Cursor records Bot work under the product labels
  `grok-bot-default`, `grok-bot-automation` and `grok-bot-cua`, by design. Its FAQ says:
  *"Grok Bot does not show the underlying model for a request. Your usage and spending views
  record this activity as Grok Bot usage, not by provider or model name."* The dashboard
  shows those rows as **model hidden**.
- **On a Cursor Enterprise team** an admin can point an inference hook at the companion.
  Cursor then sends a signed frame for each model request that names a Cursor model
  identifier. Cursor says to use that field "for reporting, not allowlisting": it is
  Cursor's label and can itself be an alias such as `sand-…`.
- **Experimental:** the plugin also ships a reporting hook. If Grok Bot runs plugin hooks
  (undocumented, and reports conflict), it reports the model slug Cursor's hook payload names
  for the conversation. It may never fire.

Nothing here guesses. A Bot's own statement about its model is shown as a quote, not as
evidence.

| Grade | Source | Who gets it | What it is |
| --- | --- | --- | --- |
| **A** signed | Cursor inference-hook frame | Enterprise teams | Cursor's per-request model identifier, signature verified. May be an alias |
| **H** hook | This plugin's reporting hook | Anyone, if Grok Bot runs plugin hooks | The model slug configured for the conversation, per Cursor's hook payload. Experimental |
| **B** ledger | Your Cursor usage ledger | Every plan | The label and token counts of each request, matched by timing to the Bot that was working. For Bot work the label is a mask |
| **B2** hint | Usage grouped by model intent | Every plan | Account-wide growth while Bots worked. Includes your own Cursor use; never tied to a Bot |
| **C** quote | The Bot's own words | Bots with the tools connected | What the Bot said about itself. Not evidence |

A concrete model id in the ledger (say `claude-…`) that coincides with a Bot's run is almost
certainly your own Cursor IDE or CLI traffic on the same account. It is shown in the feed as
**coincident** and never as the Bot's model.

## Tier 1: the dashboard (nothing exposed)

Requires Node 20.11 or newer on macOS, Linux or Windows. No dependencies.

```bash
git clone https://github.com/burgidigi-art/majordomo
```

```bash
cd majordomo/grokbot-model-watch/companion
```

To look around with synthetic data first:

```bash
node bin/model-watch.mjs demo
```

To use your account, sign in. This opens Cursor's sign-in page (the same flow the Grok Bot
desktop app uses) and stores a session of its own in `~/.grokbot-model-watch/` (mode 0600):

```bash
node bin/model-watch.mjs login
```

```bash
node bin/model-watch.mjs
```

Open <http://127.0.0.1:4319>.

On macOS you can use the desktop app's session instead of signing in
(`node bin/model-watch.mjs import-app-token --yes`). The token is read from the app's own
store each time and never copied to disk; `login` is still the recommended way.

## Tier 2: the plugin and its tools (optional)

### Install the plugin

The plugin gives every Bot the `which-model` and `model-watch-setup` skills. They work with
no server at all: the Bot then answers from the documented facts.

The route Grok Bot's own documentation describes is a custom connector (below). Community
READMEs also describe installing a plugin from a repository link, which may differ by app
version:

1. In Grok Bot or Cursor, open the plugins page (**Settings → Plugins** or **Customize**).
2. Paste `https://github.com/burgidigi-art/majordomo` into the search or paste-link box.
3. Select **grokbot-model-watch** and add it.

Plugin sources are read from a repository's default branch, so this folder has to be on
`main` (or copied into a repository of its own) first.

### Connect the tools

Bots run in the cloud and reach MCP servers from Cursor's servers, so `localhost` does not
work. Put a public HTTPS address in front of the companion. For this purpose a tunnel is
fine (Cloudflare Tunnel, Tailscale Funnel, ngrok), as is a small VPS with a reverse proxy.
Start the companion with that address so it knows which browser origin to trust:

```bash
node bin/model-watch.mjs --public-url https://watch.example.com
```

Then give Grok Bot the address and the token printed by `node bin/model-watch.mjs token`,
in one of these ways:

- **Custom connector (documented):** in the desktop app, **Connect apps → Add a custom
  connector**. Name `model-watch`, Type **Remote HTTPS**, Server URL
  `https://watch.example.com/mcp`, HTTP header `Authorization: Bearer <token>`, then
  **Add plugin**.
- **Plugin variables:** where the plugin's settings are offered (Cursor dashboard,
  **Plugins → Configure**), set `MODEL_WATCH_URL` to the base URL without `/mcp` and
  `MODEL_WATCH_TOKEN` to the token.
- **Ask a Bot:** "Add the MCP server at `https://watch.example.com/mcp` with the header
  `Authorization: Bearer <token>`."

Off localhost, the dashboard, the JSON API and the event stream need the same token; open
the dashboard as `https://watch.example.com/?token=<token>` (the page drops the token from
the address bar after loading).

| Tool | What it does |
| --- | --- |
| `model_watch_status` | Evidence per grade for every Bot, or for `bot` |
| `model_watch_recent` | Recent evidence items, optionally for one Bot and `minutes` |
| `model_watch_report_self_identification` | Records the Bot's own belief about its model as a quote |
| `model_watch_explain` | The statement of what can and cannot be known |

### The experimental reporting hook

The plugin's `hooks/hooks.json` runs `hooks/report-model.mjs` after each agent response. It
sends only identifiers (model slug, model id, model parameters, conversation and generation
ids), never prompt or reply text, and does nothing until a destination exists. To give it
one, ask a Bot to create `~/.grokbot-model-watch/hook.json` on its computer:

```json
{ "url": "https://watch.example.com", "token": "<report token>" }
```

Use the write-only report token for this (`node bin/model-watch.mjs token --report`). Every
Bot on the account can read files on the shared computer, and this token can post reports
and nothing else. If the **plugin hook** chip on the dashboard never leaves "waiting", Grok
Bot is not running the hook.

## Tier 3: inference hooks (Cursor Enterprise admins)

This is the only source of a per-request identifier. It is a team-level change, so read
"What turning on hooks does" first.

1. Run the companion on a real public host. Cursor requires `https://` on port 443 with a
   certificate from a public CA and refuses private addresses, redirects and reverse
   tunnels, so ngrok and the like do not work here.
2. Cursor dashboard → your team → Grok Bot page → **Security & Compliance → Inference
   Hooks → Set Up Endpoint → Custom Endpoint**. Endpoint URL
   `https://watch.example.com/hooks/inference`. Save.
3. Copy the `whsec_…` signing secret (shown once) and store it:

   ```bash
   node bin/model-watch.mjs hook-secret add whsec_...
   ```

4. Click **Test Connection**. The dashboard's hooks chip turns green on the test frame.
5. Turn **Enforce Verdicts** on (nothing is sent while it is off), leave **Mode** on
   **Shadow Mode**, and turn **Validate Tool Calls** off.

After rotating the secret in Cursor, add the new one first and remove the old one a minute
later (`hook-secret list`, `hook-secret remove <n>`).

**What turning on hooks does.** Every team member's Bot conversations are sent to your
endpoint, in full, for every model request; Cursor's documentation tells admins to inform
members. The companion answers `{"action":"allow"}` to every frame, verifies the signature
as the body streams past, keeps the request id, frame type, the Bot's opaque session id, the
model identifier and the time, and discards the rest without writing it anywhere. Cursor
notes that Bots can start replies slightly more slowly while hooks are enabled, and that
Shadow checks can be skipped under load, so frame counts are a floor. Keep the endpoint up:
repeated errors trip Cursor's circuit breaker and frames stop for ten minutes or more. Never
switch the hook to Block mode with this receiver behind it.

Frames carry an opaque session id per Bot. The companion matches it against the ids the Bot
API reports; failing that, it infers the Bot from which one was working, marks the binding
tentative, and only calls it learned after several consistent frames.

## How rows are matched to Bots

The companion polls each Bot's live state and remembers when each was working, with 20
seconds of grace because the ledger lags. A ledger row inside exactly one Bot's window is
attributed to it. When several Bots were working, the tighter transcript turn windows and
the kind of turn the label names break the tie; otherwise the row is shown as ambiguous with
the candidates named. Rows from a time the companion was not running, or the laptop was
asleep, are shown as **not monitored** rather than as "no Bot".

## What you are trusting

- **The session is full-account.** Cursor issues no read-only scope, so the stored session
  can do what the Grok Bot app can. It lives in `~/.grokbot-model-watch/auth.json` (0600),
  is sent only to `api2.cursor.sh` and `cursor.com`, and is redacted from logs. `logout`
  deletes it; Cursor has no known revocation endpoint, so also sign out in Cursor if it may
  have leaked.
- **Undocumented interfaces.** The Bot list, live status, transcripts and usage ledger come
  from the desktop app's private API and the dashboard's endpoints, reconstructed by
  community projects. They can change or break without notice, and using them may be
  against Cursor's terms. When one breaks, its chip on the dashboard says so and the rest
  keeps working.
- **What is read.** Transcript entries are fetched to find turn boundaries; only ids,
  timestamps and an 80-character preview of the Bot's own latest reply are kept, in memory.
  `--no-transcripts` turns that off. Only your own Bots and your own ledger rows are used;
  `--team-bots` includes Bots teammates own.
- **Nothing is persisted** except settings, the session and tokens. Evidence lives in
  memory and is gone on restart.
- **Access.** The server binds to `127.0.0.1`. A request counts as local only if it comes
  from the loopback address and names a local host, which blocks DNS rebinding; browser
  origins other than local or the public URL are refused. Every write needs the bearer
  token. The hook receiver accepts anything, answers "allow", and records only frames whose
  signature verifies.
- **Tokens.** The MCP token is stored by Cursor and presented from its servers; a Bot never
  sees it. Rotate it with `token --rotate` when a plugin is removed or a Bot is shared.
- **Self-reports are an untrusted channel.** A Bot that read a hostile page could be steered
  into reporting nonsense. Reports are sanitized, limited to one per Bot per minute, checked
  against which Bot was working, shown only as quotes, and their free text is never passed
  back to other Bots.
- The companion is an observer. It is not a security control and blocks nothing.

## Commands

```text
node bin/model-watch.mjs                     serve (dashboard, API, MCP, hook receiver)
    --host H --port P --public-url URL --open --no-transcripts --team-bots
node bin/model-watch.mjs demo                the same with synthetic data
node bin/model-watch.mjs login               browser sign-in to Cursor
node bin/model-watch.mjs import-app-token --yes   use the Grok Bot app's session (macOS)
node bin/model-watch.mjs logout
node bin/model-watch.mjs token [--rotate]    the bearer token for MCP and remote access
node bin/model-watch.mjs token --report [--rotate]   the write-only token for the reporting hook
node bin/model-watch.mjs hook-secret add <whsec_...> | list | remove <n>
node bin/model-watch.mjs probe               one JSON snapshot of every source
```

Settings are in `~/.grokbot-model-watch/settings.json`. Environment: `MODEL_WATCH_HOME`
(folder), `MODEL_WATCH_CURSOR_TOKEN` (a raw access token, never refreshed),
`MODEL_WATCH_CLIENT_VERSION` (the app version reported to Cursor, default 0.75.0),
`MODEL_WATCH_GROKBOT_DIR` (the desktop app's data folder).

## Limitations

- No model name on non-Enterprise plans. That is Cursor's choice and this tool cannot undo
  it.
- None of this has been run against a live Cursor account yet. The API client, sign-in flow
  and hook receiver are tested against fixtures and local servers built from the published
  documentation and the community clients; expect to adjust field names on first contact.
- Attribution is by timing. Two Bots busy at once can leave rows ambiguous.
- Accounts billed through the X Subscription may keep their ledger at grok.com, in which
  case grade B stays empty.
- The plugin install path by repository link and the plugin-variables screen are described
  by community sources, not by Grok Bot's documentation. The custom connector is documented.

## Development

```bash
cd grokbot-model-watch/companion
```

```bash
node --test
```

`bin/model-watch.mjs` is the CLI. In `lib/`: `cursor-auth.mjs` (sign-in, headers),
`cursor-api.mjs` (Cursor calls), `grokbot-api.mjs` (Bots, status, transcripts),
`local-app.mjs` (desktop app files), `evidence.mjs` (grades, windows, bindings, store),
`inference-hooks.mjs` (signature verification, streaming receiver), `mcp.mjs` (MCP server),
`watch.mjs` (the orchestrator), `server.mjs` (HTTP and access rules), `poller.mjs`,
`demo.mjs`. The dashboard is the single file `ui/index.html`.

## Sources

Checked against the official Grok Bot documentation (`docs.x.ai/grok-bot/`: FAQ, Security,
Inference hooks, Use the computer and apps, Skills and routines), Cursor's hooks and plugin
references (`cursor.com/docs/hooks`, `cursor.com/docs/reference/plugins`), the Agent Plugins
specification, and the community projects that reconstructed the desktop app's API:
BugenZhao/grokbot-cli, Kargatharaakash/grok-bot-usage, CDVolvik/grok-bot-cli,
getagentseal/codeburn, and the Cursor usage trackers by dmwyatt, CursorToys and
MooseGooseBot. Not affiliated with or endorsed by xAI or Cursor.
