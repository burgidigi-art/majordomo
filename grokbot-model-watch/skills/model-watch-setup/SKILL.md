---
name: model-watch-setup
description: Help the user install, run and connect the Grok Bot Model Watch companion, the dashboard that shows graded evidence about which model is behind each Bot. Use when the user asks how to see which models their Bots use, how to set up Model Watch, how to connect its tools to their Bots, how to enable its reporting hook, or how to point a Cursor Enterprise inference hook at it.
---

# Set up Grok Bot Model Watch

The companion is a small Node program the user runs on their own computer or server. Guide
them; do not run it on your cloud computer, because it needs their Cursor sign-in, which you
must never see or handle. Be straight about the limit up front: on a normal plan the
dashboard shows when each Bot works, the kind of turn, tokens and allowance, and marks the
model as hidden. Only a Cursor Enterprise inference hook yields a per-request identifier.

## 1. The dashboard (user's machine, Node 20.11+)

```bash
git clone https://github.com/burgidigi-art/majordomo
```

```bash
cd majordomo/grokbot-model-watch/companion
```

```bash
node bin/model-watch.mjs login
```

```bash
node bin/model-watch.mjs
```

The dashboard is at `http://127.0.0.1:4319`. `node bin/model-watch.mjs demo` shows it with
synthetic data. Nothing is exposed to the network at this stage.

## 2. Connect the tools to Bots (optional)

You run in the cloud and reach MCP servers from Cursor's servers, so you cannot reach
`127.0.0.1` on the user's laptop. They need a public HTTPS URL in front of the companion; a
tunnel (Cloudflare Tunnel, Tailscale Funnel, ngrok) or a VPS with a reverse proxy both work.
They start it with `--public-url https://<host>` and get the token from
`node bin/model-watch.mjs token`. Then one of:

- **Custom connector:** desktop app, Connect apps → **Add a custom connector** → Name
  `model-watch`, Type **Remote HTTPS**, Server URL `https://<host>/mcp`, HTTP header
  `Authorization: Bearer <token>` → **Add plugin**.
- **Plugin variables:** set `MODEL_WATCH_URL` (base URL, no `/mcp`) and `MODEL_WATCH_TOKEN`
  where the plugin's configuration is offered.
- **You add it:** if the user gives you the URL and asks, add the MCP server by URL with
  that header. Use the secure secret card for the token; do not ask them to paste it into
  chat.

Their team's connector policy may need the host allowlisted.

## 3. The experimental reporting hook (optional)

The plugin's hook reports the model slug from Cursor's hook payload, if Grok Bot runs plugin
hooks at all (undocumented). It needs a destination file on your computer. When the user
asks, create `~/.grokbot-model-watch/hook.json` containing
`{"url": "https://<host>", "token": "<report token>"}`, using the write-only token from
`node bin/model-watch.mjs token --report`. Tell them every Bot on the account can read that
file, which is why the limited token is used. If the dashboard's plugin-hook chip stays on
"waiting", the hook is not being run.

## 4. Enterprise inference hook (team admins only)

1. The companion must run on a real public host: HTTPS on port 443 with a public-CA
   certificate. Cursor refuses tunnels, redirects and private addresses for this.
2. Cursor dashboard → team → Grok Bot page → Security & Compliance → **Inference Hooks** →
   **Set Up Endpoint** → **Custom Endpoint** → `https://<host>/hooks/inference`.
3. Copy the `whsec_…` secret shown once → `node bin/model-watch.mjs hook-secret add whsec_…`.
4. **Test Connection**.
5. **Enforce Verdicts** on (nothing is sent while it is off), **Mode** = **Shadow Mode**,
   **Validate Tool Calls** off.

Make sure the admin knows: this sends every team member's Bot conversations to that
endpoint, members should be told, the companion keeps only identifiers and always answers
"allow", and the endpoint must stay up or Cursor's circuit breaker pauses the hook.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Tools missing in the Bot | URL not public HTTPS, wrong token, or the host is blocked by team policy |
| Usage chip says auth | Session expired: `node bin/model-watch.mjs login` |
| Hooks chip stuck on waiting | Enforce Verdicts is off, or the secret was not added |
| Hooks only show test frames | Enforce Verdicts is off |
| Every row "model hidden" | Expected on a non-Enterprise plan |

`node bin/model-watch.mjs probe` prints one JSON snapshot of every source.
