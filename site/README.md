# site/ — Warren / ResearchRabbit Copilot landing + docs page

A single, self-contained `index.html` (no build step, no external CSS file) that does four things:

1. **Embedded chat** — a live Flowise chat bubble (bottom-right) wired to the hosted agentflow.
2. **How to configure the MCP on Claude** — `claude mcp add`, project `.mcp.json`, and Claude Desktop config, plus the 22-tool catalogue. The `.mcp.json` / Desktop configs include the optional `headers` block (Camino B) for per-user ResearchRabbit credentials.
3. **Use your own ResearchRabbit account** — a "Connect account" panel (Camino C, web chat) plus a DevTools how-to for getting your `sessionToken` JWT from `localStorage`; and a recap of Method B (per-user `X-RR-Token` header in the editor).
4. **Try it** — the nine example prompts to paste into the chat (`#try`, a stacked `.prompts` list), with a one-line note on where the chat bubble is and the cold-start delay. No pitch, no architecture: just what to type.

Modeled on the firstTable `site/index.html` structure (hero → what → how → FAQ → architecture → agent-as-a-client → try-it → footer), with a purple palette to match the agentflow's `chatbotConfig`.

### Progressive disclosure

The page used to carry the MCP setup docs, the 22-tool grid and the account panel as three always-open sections; that made it very long. They now live in collapsed `.disclosure` panels that open **behind** the card that asks for them:

| Card | CTA hint | Panel |
| --- | --- | --- |
| `#tech` → “MCP server (22 tools)” | *Check tools* | `#tools-panel` — the 22-tool grid |
| `#agent-client` → “In your favourite harness agent” | *More info* | `#panel-mcp` — endpoint + Option A/B/C configs |
| `#agent-client` → “Warren chatbot” | *More info* | `#panel-chat` — the Connect-account form |

There is no pill button: **the whole card is the click target** (`.is-clickable` + `onclick="cardActivate(event, this)"`), and the CTA is a dotted-underline text link (`.card-link`) with a `▾` chevron that rotates 180° — and turns solid — when the panel is open. It sits at the **bottom-right** of the card: `.card-cta` is pushed down by `margin: auto 0 0` in the flex column and right-aligned with `text-align: right`, so the underline still hugs the label instead of stretching across the card. `cardActivate` forwards the click to the card's `.card-link` button — which is a real `<button>`, so Tab/Enter/Space and screen readers still work — and bails out when the click landed on a link, a form control, or a text selection, so the URLs inside a card stay copyable. The touch fallback lives in `@media (hover: none)`, where the hover lift is dropped so a tap doesn't leave the card stuck in a hover state.

`#how-to-token` (“How to get your sessionToken”) stays **always visible** at the top of `#agent-client`, since you need a token whichever client you pick. `toggleDisclosure(btn, id)` / `closeDisclosure(id)` / `openDisclosure(id)` drive it; one panel is open at a time per section, `aria-expanded`/`aria-controls` are kept in sync, opening a panel scrolls it clear of the sticky header (`revealPanel`), and the old `#mcp` / `#account` deep links still work — a hash handler maps them onto the matching panel.

## Spanish version

`index.es.html` is a full Spanish translation of `index.html` (`<html lang="es">`). Same structure, section IDs, anchors, code blocks, URLs, and embedded Flowise chat — only the visible prose, button/label text, chat-bubble `welcomeMessage`/`errorMessage`, and the Camino C panel status strings are translated. The technical identifiers (tool names, env vars, headers, JSON, curl commands) stay verbatim. It is a standalone sibling file, so the deploy/publish path serves whichever page you point at.

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

- **Method B (editor, per-user):** send an `X-RR-Token` header (the `sessionToken` JWT from `app.researchrabbit.ai` localStorage) on the MCP server. The `.mcp.json` / `claude_desktop_config.json` snippets in the `#panel-mcp` disclosure (the “harness agent” card of `#agent-client`) show the `headers` block. The MCP server forwards it to the gateway, which upgrades that call to the rr backend with the caller's own session (Bearer). `projectId` is auto-discovered via `GET /projects`.
- **Method C (web chat, single active account):** the `#panel-chat` Connect panel (the “Warren chatbot” card of `#agent-client`) POSTs `{token}` (the `sessionToken` JWT) to `POST /api/rr/connect` on the gateway, which validates via `GET /users/me`, auto-discovers `projectId` via `GET /projects`, and stores the credential in memory (TTL ~1d). `GET /api/rr/status` and `DELETE /api/rr/disconnect` round it out. The panel JS uses a `RR_GATEWAY` const (defaults to the hosted gateway; set to `http://localhost:8831` for local tests).

### Deploy steps to make the panel live on a hosted site

1. Push the new `server/` and `mcp-server/` to GitHub so Render auto-deploys them (the gateway gains `/api/rr/*`; the MCP gains header forwarding).
2. On the `researchrabbit-server` service, set `ALLOWED_ORIGINS` to include the origin that hosts this page (e.g. `https://researchrabbit-site.onrender.com,http://localhost:3000`).
3. Host this `site/` somewhere (a Render static site works) so the panel's origin matches the gateway's CORS allow-list.
4. Until the gateway is redeployed, the panel reports "Connect endpoint not available on this gateway yet" (the JS handles the 404 gracefully).

### Honest caveat

The RR adapter (`server/src/adapters/rr.js`) makes real upstream calls against `api.researchrabbit.ai`, authenticated with `Authorization: Bearer <sessionToken>` (the JWT from the SPA's `localStorage`), and mapped to the canonical shape. The auth model, the two-step search (`POST /searches` then `GET /searches/{id}`, with a stringified `results` field), the edge-count semantics (`backwardEdgeCount`=citedBy, `forwardEdgeCount`=references), and `/projects` projectId discovery are all **verified live** against the real API (the search returns real DOIs). `save_articles`'s batch body and `search_by_author` (no documented author endpoint) remain best-effort until exercised with a connected account doing those specific writes.
