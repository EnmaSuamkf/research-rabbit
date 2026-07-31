# site/ — static one-pager

A single `index.html` with the embedded Flowise chat widget (§14.7). It is a preview of the
eventual product page; the real, branded chat page is built once on the deployed instance in
**Stage 3** (§16.6).

## Run it locally

```bash
npx serve site      # opens on http://localhost:3000-ish; the origin must match ALLOWED_ORIGINS
```

## What changes in Stage 3

- `chatflowid` → the published Agentflow id.
- `apiHost` → the deployed Flowise URL (e.g. `https://researchrabbit-flowise.onrender.com`).

The widget renders inside a `<flowise-fullchatbot>` Shadow DOM — to inspect title/colours/
avatars programmatically, query through `document.querySelector('flowise-fullchatbot').shadowRoot`.
Do not put trailing slashes on avatar URLs (GitHub raw 404s on `usericon.png/`).

## Local stack links (when running)

- Gateway health: http://localhost:8821/api/health
- MCP descriptor (22 tools): http://localhost:8822/
- Flowise UI: http://localhost:3000
