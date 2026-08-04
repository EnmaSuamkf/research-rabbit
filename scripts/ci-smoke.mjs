// Offline smoke test for the chat-gate path (run by .github/workflows/ci.yml).
//
// Everything here is asserted against a locally booted gateway with no
// credential, so nothing touches the network: `/api/rr/status` answers from the
// in-memory web-credential store and `/api/rr/connect` rejects a missing token
// before it ever calls upstream.
//
// What it guards:
//   1. The CORS allow-list — an origin the gateway does not allow gets no
//      `access-control-allow-origin`, the browser then discards the response,
//      and the chat gate can never log in even with a valid sessionToken. The
//      default list must keep covering the local dev servers.
//   2. The gate's token fields are `type="text"`. A masked field hides a
//      truncated paste of a very long JWT.
//
// Usage: node scripts/ci-smoke.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

const server = spawn(process.execPath, ["src/index.js"], {
  cwd: join(ROOT, "server"),
  // No ALLOWED_ORIGINS on purpose: this asserts the built-in default.
  env: { ...process.env, PORT: String(PORT), RR_BACKEND: "openalex" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[gateway] ${d}`));

async function waitForBoot() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/rr/status`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  if (!(await waitForBoot())) {
    console.error("FAIL gateway did not start");
    process.exit(1);
  }

  // --- 1. CORS allow-list ---------------------------------------------------
  for (const origin of [
    "http://localhost:3000",
    "http://localhost:8088",
    "http://localhost:5173",
    "http://localhost:4173",
  ]) {
    const r = await fetch(`${BASE}/api/rr/status`, { headers: { Origin: origin } });
    check(
      `allowed origin ${origin} may read /api/rr/status`,
      r.headers.get("access-control-allow-origin") === origin,
      `got ${r.headers.get("access-control-allow-origin")}`,
    );
  }

  for (const origin of ["http://evil.example", "null"]) {
    const r = await fetch(`${BASE}/api/rr/status`, { headers: { Origin: origin } });
    check(
      `unlisted origin ${origin} is refused`,
      r.headers.get("access-control-allow-origin") === null,
    );
  }

  // The preflight the browser sends before POST /api/rr/connect.
  const preflight = await fetch(`${BASE}/api/rr/connect`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:8088",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  check(
    "preflight for the login POST passes",
    preflight.status === 204 &&
      preflight.headers.get("access-control-allow-origin") === "http://localhost:8088",
    `status ${preflight.status}`,
  );

  // --- 2. gate endpoints answer without a credential -------------------------
  const status = await (await fetch(`${BASE}/api/rr/status`)).json();
  check("status reports a disconnected account", status.connected === false);

  const noToken = await fetch(`${BASE}/api/rr/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  check("login without a token is rejected", noToken.status === 400);

  // --- 3. the gate's token field stays readable ------------------------------
  for (const page of ["site/index.html", "site/index.es.html"]) {
    const html = readFileSync(join(ROOT, page), "utf8");
    const field = html.match(/<input id="chat-gate-token"[^>]*>/);
    check(`${page} has the gate token field`, Boolean(field));
    if (field) {
      check(`${page} token field is type="text"`, /type="text"/.test(field[0]), field[0]);
    }
  }
} finally {
  server.kill();
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
