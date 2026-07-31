# site/ — Warren / ResearchRabbit Copilot landing + docs page

A single, self-contained `index.html` (no build step, no external CSS file) that does four things:

1. **Embedded chat** — a live Flowise chat bubble (bottom-right) wired to the hosted agentflow.
2. **How to configure the MCP on Claude** — `claude mcp add`, project `.mcp.json`, and Claude Desktop config, plus the 22-tool catalogue. The `.mcp.json` / Desktop configs include the optional `headers` block (Camino B) for per-user ResearchRabbit credentials.
3. **Use your own ResearchRabbit account** — a "Connect account" panel (Camino C, web chat) plus a DevTools how-to for getting `SPRSESSION` + `projectId`; and a recap of Method B (per-user headers in the editor).
4. **Examples** — raw MCP `tools/list` / `tools/call` (curl, with real captured output) and a real Warren chatbot reply, plus a list of sample questions.

Modeled on the firstTable `site/index.html` structure (hero → what → how → FAQ → architecture → MCP & Claude → account → examples → try-it → footer), with a purple palette to match the agentflow's `chatbotConfig`.

## What's wired in (all live, verified)

| Thing | Value |
| --- | --- |
| Agentflow ID | `3167de25-947c-4c94-8546-c98c3cd3fdd2` (`type: AGENTFLOW`, `deployed: true`, `isPublic: true`) |
| Flowise host | `https://researchrabbit-flowise.onrender.com` |
| MCP host | `https://researchrabbit-mcp-server.onrender.com/mcp` (22 tools, stateless Streamable HTTP) |
| Gateway host | `https://researchrabbit-server.onrender.com` |
| Model | Fireworks `accounts/fireworks/models/glm-5p2`, temp 0.2, streaming, `allMessages` memory |
| Embed theme | mirrored from `GET /api/v1/public-chatbotConfig/<agentflow-id>` |

The embedded `theme` block duplicates the server-side `chatbotConfig` on purpose (flowise-embed applies visual theming from the inline object). If the config changes on the server, update the inline `theme` to match.

## Run it

```bash
# any static server works; the origin must be allowed by Flowise CORS for the embed fetch
npx serve site          # or: python3 -m http.server 8088 --directory site
```

Then open the served URL (not `file://` — the embed's fetch to the Flowise API needs a real origin).

## The chat bubble

The widget renders inside a `<flowise-chatbot>` Shadow DOM. To inspect it programmatically:

```js
const fe = document.querySelector('flowise-chatbot');
fe.shadowRoot.querySelector('button').click();   // open the window
```

## Local stack (when running the repo)

- Gateway health: http://localhost:8821/api/health
- MCP descriptor (22 tools): http://localhost:8822/
- Flowise UI: http://localhost:3000

For local use, swap the embed `apiHost` to `http://localhost:3000` and the MCP URL to `http://localhost:8822/mcp`.

## "Use your own ResearchRabbit account" (Camino B / C)

The page documents and wires the two per-user credential paths implemented in the gateway + MCP server:

- **Method B (editor, per-user):** send `X-RR-Cookie` + `X-RR-Project-Id` headers on the MCP server. The `.mcp.json` / `claude_desktop_config.json` snippets in the `#mcp` section show the `headers` block. The MCP server forwards them to the gateway, which upgrades that call to the rr backend with the caller's own session.
- **Method C (web chat, single active account):** the `#account` Connect panel POSTs `{cookie, projectId?}` to `POST /api/rr/connect` on the gateway, which validates via `GET /users/me` and stores the credential in memory (TTL ~1d). `GET /api/rr/status` and `DELETE /api/rr/disconnect` round it out. The panel JS uses a `RR_GATEWAY` const (defaults to the hosted gateway; set to `http://localhost:8831` for local tests).

### Deploy steps to make the panel live on a hosted site

1. Push the new `server/` and `mcp-server/` to GitHub so Render auto-deploys them (the gateway gains `/api/rr/*`; the MCP gains header forwarding).
2. On the `researchrabbit-server` service, set `ALLOWED_ORIGINS` to include the origin that hosts this page (e.g. `https://researchrabbit-site.onrender.com,http://localhost:3000`).
3. Host this `site/` somewhere (a Render static site works) so the panel's origin matches the gateway's CORS allow-list.
4. Until the gateway is redeployed, the panel reports "Connect endpoint not available on this gateway yet" (the JS handles the 404 gracefully).

### Honest caveat

The RR adapter (`server/src/adapters/rr.js`) makes real upstream calls against the documented `api.researchrabbit.ai` endpoints, mapped to the canonical shape. It is implemented against the spec in `researchrabbit-howto-api-en.html` but could not be exercised end-to-end without a real session cookie — **connecting an account is the validation step**. Field access is defensive (optional chaining + fallbacks) so shape drift degrades to nulls rather than crashes. `save_articles`'s batch body and `search_by_author` (no documented author endpoint) are best-effort.
