#!/usr/bin/env node
/**
 * AUN Deep Mind — server companion (build-order #4).
 *
 * A single-file Node.js (>=18) service you run on your own server (e.g. Hetzner).
 * It unlocks the things a browser alone cannot do:
 *   - /relay     CORS relay: proxies requests to APIs that block browsers
 *                (Notion, NewsAPI, Twilio, SendGrid, ...)
 *   - /publish   Real hosting: publish AUN projects to your own domain
 *                (served at /sites/<name>/)
 *   - /run       Docker sandbox: run generated Node code isolated (needs docker)
 *   - /ytdlp     Download media you own the rights to (needs yt-dlp installed)
 *   - /agents    Background agents: run scheduled agents even when the browser
 *                tab is closed; results are stored and synced back
 *
 * Install (on your server):
 *   mkdir -p ~/aun && cd ~/aun
 *   curl -o aun-companion.mjs <RAW_URL_OF_THIS_FILE>
 *   AUN_TOKEN=choose-a-long-secret node aun-companion.mjs
 * Keep it alive with systemd or:  nohup env AUN_TOKEN=... node aun-companion.mjs &
 *
 * Security: every request must carry  Authorization: Bearer $AUN_TOKEN.
 * Put it behind HTTPS (Caddy/nginx) before exposing it to the internet.
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";

const PORT = Number(process.env.AUN_PORT ?? 8787);
const TOKEN = process.env.AUN_TOKEN ?? "";
const DATA_DIR = process.env.AUN_DATA ?? join(process.cwd(), "aun-data");
const SITES_DIR = join(DATA_DIR, "sites");
const AGENTS_FILE = join(DATA_DIR, "agents.json");
const RESULTS_FILE = join(DATA_DIR, "agent-results.json");

if (!TOKEN) {
  console.error("Set AUN_TOKEN=<long random secret> before starting.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Relay-Url, X-Relay-Headers");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 5_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/* ---------------- background agents ---------------- */

let agents = [];
let results = [];
try { agents = JSON.parse(await readFile(AGENTS_FILE, "utf8")); } catch { /* first run */ }
try { results = JSON.parse(await readFile(RESULTS_FILE, "utf8")); } catch { /* first run */ }
const lastRun = new Map();

async function runAgent(agent) {
  try {
    const res = await fetch(agent.endpoint.url, {
      method: "POST",
      headers: agent.endpoint.headers,
      body: JSON.stringify({
        model: agent.endpoint.model,
        messages: [
          { role: "system", content: agent.systemPrompt ?? "You are a helpful autonomous agent. Reply with a concise report." },
          { role: "user", content: agent.prompt },
        ],
        max_tokens: 2048,
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? `provider error ${res.status}`;
    results.push({ agentId: agent.id, name: agent.name, ts: Date.now(), ok: res.ok, output: String(text).slice(0, 8000) });
    results = results.slice(-200);
    await writeFile(RESULTS_FILE, JSON.stringify(results));
    if (agent.telegram?.token && agent.telegram?.chatId) {
      await fetch(`https://api.telegram.org/bot${agent.telegram.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: agent.telegram.chatId, text: `🤖 ${agent.name}:\n${String(text).slice(0, 3800)}` }),
      }).catch(() => undefined);
    }
  } catch (err) {
    results.push({ agentId: agent.id, name: agent.name, ts: Date.now(), ok: false, output: String(err) });
    await writeFile(RESULTS_FILE, JSON.stringify(results)).catch(() => undefined);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const agent of agents) {
    const every = Math.max(5, Number(agent.intervalMinutes ?? 60)) * 60_000;
    const last = lastRun.get(agent.id) ?? 0;
    if (agent.enabled !== false && now - last >= every) {
      lastRun.set(agent.id, now);
      void runAgent(agent);
    }
  }
}, 30_000);

/* ---------------- http server ---------------- */

await mkdir(SITES_DIR, { recursive: true });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  // Published sites are public (that's the point of hosting).
  if (url.pathname.startsWith("/sites/")) {
    try {
      const rel = normalize(url.pathname.slice(7)).replace(/^([./\\])+/, "");
      const path = join(SITES_DIR, rel.endsWith("/") || !rel.includes(".") ? join(rel, "index.html") : rel);
      const content = await readFile(path);
      const ext = path.slice(path.lastIndexOf("."));
      cors(res);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      return res.end(content);
    } catch {
      return json(res, 404, { error: "not found" });
    }
  }

  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });

  try {
    if (url.pathname === "/health") {
      const docker = await new Promise((r) => execFile("docker", ["--version"], (e) => r(!e)));
      const ytdlp = await new Promise((r) => execFile("yt-dlp", ["--version"], (e) => r(!e)));
      return json(res, 200, { ok: true, version: 1, docker, ytdlp, agents: agents.length });
    }

    if (url.pathname === "/relay" && req.method === "POST") {
      const target = String(req.headers["x-relay-url"] ?? "");
      if (!/^https:\/\//.test(target)) return json(res, 400, { error: "X-Relay-Url must be an https URL" });
      const headers = JSON.parse(String(req.headers["x-relay-headers"] ?? "{}"));
      const body = await readBody(req);
      const method = url.searchParams.get("method") ?? "POST";
      const upstream = await fetch(target, { method, headers, body: method === "GET" ? undefined : body });
      const text = await upstream.text();
      cors(res);
      const outHeaders = { "Content-Type": upstream.headers.get("content-type") ?? "text/plain" };
      // MCP servers hand out a session id header — pass it through so browser clients can keep the session.
      const mcpSession = upstream.headers.get("mcp-session-id");
      if (mcpSession) outHeaders["mcp-session-id"] = mcpSession;
      res.writeHead(upstream.status, outHeaders);
      return res.end(text);
    }

    if (url.pathname === "/publish" && req.method === "POST") {
      const { name, files } = JSON.parse((await readBody(req)).toString());
      const site = String(name ?? "app").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60) || "app";
      for (const f of files ?? []) {
        const rel = normalize(String(f.path)).replace(/^([./\\])+/, "");
        const full = join(SITES_DIR, site, rel);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, String(f.content));
      }
      return json(res, 200, { ok: true, url: `/sites/${site}/` });
    }

    if (url.pathname === "/run" && req.method === "POST") {
      const { code, timeoutSec } = JSON.parse((await readBody(req)).toString());
      const out = await new Promise((resolve) => {
        execFile(
          "docker",
          ["run", "--rm", "--network", "none", "--memory", "256m", "--cpus", "0.5", "-i", "node:20-alpine", "node", "-e", String(code).slice(0, 100_000)],
          { timeout: Math.min(Number(timeoutSec ?? 20), 60) * 1000 },
          (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout).slice(0, 20_000), stderr: String(stderr).slice(0, 20_000) }),
        );
      });
      return json(res, 200, out);
    }

    if (url.pathname === "/ytdlp" && req.method === "POST") {
      const { mediaUrl, audioOnly } = JSON.parse((await readBody(req)).toString());
      const args = [String(mediaUrl), "-o", join(DATA_DIR, "downloads", "%(title)s.%(ext)s"), "--no-playlist"];
      if (audioOnly) args.push("-x");
      const out = await new Promise((resolve) => {
        execFile("yt-dlp", args, { timeout: 300_000 }, (err, stdout, stderr) =>
          resolve({ ok: !err, log: (String(stdout) + String(stderr)).slice(-4000) }),
        );
      });
      return json(res, 200, out);
    }

    if (url.pathname === "/agents" && req.method === "POST") {
      agents = JSON.parse((await readBody(req)).toString());
      await writeFile(AGENTS_FILE, JSON.stringify(agents));
      return json(res, 200, { ok: true, count: agents.length });
    }
    if (url.pathname === "/agents/results") {
      return json(res, 200, { results: results.slice(-50).reverse() });
    }

    return json(res, 404, { error: "unknown endpoint" });
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => console.log(`AUN companion listening on :${PORT} (data: ${DATA_DIR})`));
