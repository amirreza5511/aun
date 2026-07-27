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
 *   - /jobs      Persistent BUILD jobs: the AI generation for a build runs on
 *                this server as a background job — closing the browser does
 *                NOT stop it. Jobs survive server restarts (resumed on boot),
 *                are deduplicated by id, support cancel/retry, and mirror
 *                their state to Supabase (aun_jobs) when credentials are sent.
 *   - /state     (v3, extended in v4) Per-project state persistence: the
 *                browser mirrors its prompt queue, project memory, checkpoints,
 *                agent tasks and self-improvement state here so they survive
 *                browser close AND server restart. Newer-wins: a push older
 *                than the stored copy is rejected with 409.
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
/** Reported by /health — lets clients prove a restart happened (verification harness step 10). */
const SERVER_STARTED_AT = Date.now();
const TOKEN = process.env.AUN_TOKEN ?? "";
const DATA_DIR = process.env.AUN_DATA ?? join(process.cwd(), "aun-data");
const SITES_DIR = join(DATA_DIR, "sites");
const AGENTS_FILE = join(DATA_DIR, "agents.json");
const RESULTS_FILE = join(DATA_DIR, "agent-results.json");
const JOBS_FILE = join(DATA_DIR, "jobs.json");
const STATE_FILE = join(DATA_DIR, "state.json");

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

/* ---------------- persistent build jobs ---------------- */

let jobs = {};
try { jobs = JSON.parse(await readFile(JOBS_FILE, "utf8")); } catch { /* first run */ }

/* ---------------- per-project state sync (v3) ---------------- */

/** { [projectId]: { [kind]: { data, updatedAt } } } — kinds: queue | memory | checkpoints | tasks | evolution (v4) */
let projState = {};
try { projState = JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { /* first run */ }

async function persistProjState() {
  await writeFile(STATE_FILE, JSON.stringify(projState)).catch(() => undefined);
}
/** In-flight abort controllers per job id (memory only — a restarted server has none). */
const jobAborts = new Map();
const lastJobMirror = new Map();

/** Same file-fence contract as the browser parser: only CLOSED ```file:path fences count. */
function parseJobFileBlocks(raw) {
  const files = [];
  const re = /```file:([^\n`]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    files.push({ path: m[1].trim(), content: m[2].replace(/\n$/, "") });
  }
  return files;
}

async function persistJobs() {
  const keep = Object.values(jobs).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  jobs = Object.fromEntries(keep.map((j) => [j.id, j]));
  await writeFile(JOBS_FILE, JSON.stringify(jobs)).catch(() => undefined);
}

function touchJob(job, patch) {
  Object.assign(job, patch);
  job.updatedAt = Date.now();
}

/** Fire-and-forget mirror to the Supabase aun_jobs table (same schema as the browser mirror). */
async function mirrorJobRow(job, force = false) {
  const sb = job.supabase;
  if (!sb?.url || !sb?.anonKey) return;
  const last = lastJobMirror.get(job.id) ?? 0;
  if (!force && Date.now() - last < 5000) return;
  lastJobMirror.set(job.id, Date.now());
  await fetch(`${String(sb.url).replace(/\/+$/, "")}/rest/v1/aun_jobs?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: sb.anonKey,
      Authorization: `Bearer ${sb.anonKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{
      id: job.id,
      project_id: job.projectId,
      status: job.status,
      step: job.step,
      provider: job.provider,
      prompt: String(job.prompt ?? "").slice(0, 2000),
      fix_round: 0,
      retries: job.retries,
      stream_chars: (job.output ?? "").length,
      file_count: (job.files ?? []).length,
      committed_files: 0,
      logs: job.logs.slice(-30),
      started_at: new Date(job.createdAt).toISOString(),
      updated_at: new Date(job.updatedAt).toISOString(),
    }]),
  }).catch(() => undefined);
}

/** Streams one OpenAI-compatible completion, accumulating text via onDelta. */
async function streamJobCompletion(ep, messages, signal, onDelta) {
  const res = await fetch(ep.url, {
    method: "POST",
    headers: ep.headers,
    body: JSON.stringify({ model: ep.model, messages, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 180)}`);
  let text = "";
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) { text += delta; onDelta(text); }
      } catch { /* partial SSE line */ }
    }
  }
  return text;
}

/**
 * Executes a build job with real provider failover (2 attempts per endpoint).
 * Every state change is persisted to disk BEFORE it is reported, so a server
 * restart never loses state — interrupted jobs are resumed on boot (below).
 */
async function executeJob(job) {
  const controller = new AbortController();
  jobAborts.set(job.id, controller);
  touchJob(job, { status: "running", step: "started on server" });
  await persistJobs();
  try {
    for (const ep of job.endpoints ?? []) {
      const label = ep.label ?? ep.model ?? "provider";
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (controller.signal.aborted) throw new Error("cancelled");
        touchJob(job, { provider: label, step: `provider ${label} — attempt ${attempt}/2, streaming…` });
        job.logs = [...job.logs, `→ ${label}: attempt ${attempt}/2`].slice(-80);
        await persistJobs();
        void mirrorJobRow(job);
        const attemptController = new AbortController();
        const onAbort = () => attemptController.abort();
        controller.signal.addEventListener("abort", onAbort);
        const hardTimeout = setTimeout(() => attemptController.abort(), 300000);
        let lastPersist = 0;
        try {
          job.output = "";
          const text = await streamJobCompletion(ep, job.messages ?? [], attemptController.signal, (full) => {
            job.output = full;
            job.updatedAt = Date.now();
            if (Date.now() - lastPersist > 2000) {
              lastPersist = Date.now();
              void persistJobs();
              void mirrorJobRow(job);
            }
          });
          if (!text.trim()) throw new Error("empty reply");
          const files = parseJobFileBlocks(text);
          touchJob(job, { status: "completed", output: text, files, error: "", step: `completed — ${files.length} complete file block(s)` });
          job.logs = [...job.logs, `✓ ${label}: completed with ${files.length} file block(s), ${text.length} chars`].slice(-80);
          await persistJobs();
          await mirrorJobRow(job, true);
          return;
        } catch (err) {
          if (controller.signal.aborted) throw new Error("cancelled");
          job.retries += 1;
          job.logs = [...job.logs, `✗ ${label}: ${String(err?.message ?? err).slice(0, 200)}`].slice(-80);
          touchJob(job, {});
          await persistJobs();
        } finally {
          clearTimeout(hardTimeout);
          controller.signal.removeEventListener("abort", onAbort);
        }
      }
    }
    touchJob(job, { status: "failed", error: "every provider failed — see logs", step: "failed — every provider failed" });
  } catch (err) {
    const cancelled = String(err?.message ?? err).includes("cancelled");
    touchJob(job, cancelled
      ? { status: "cancelled", step: "cancelled by user" }
      : { status: "failed", error: String(err?.message ?? err).slice(0, 300), step: "failed" });
  } finally {
    jobAborts.delete(job.id);
    await persistJobs();
    await mirrorJobRow(job, true);
  }
}

/** Public job view — heavy fields (full output, files) only on ?full=1 of a completed job. */
function publicJob(job, full = false) {
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    step: job.step,
    provider: job.provider,
    retries: job.retries,
    logs: job.logs.slice(-40),
    outputChars: (job.output ?? "").length,
    outputTail: (job.output ?? "").slice(-1500),
    output: full && job.status === "completed" ? (job.output ?? "") : undefined,
    files: full && job.status === "completed" ? (job.files ?? []) : undefined,
    fileCount: (job.files ?? []).length,
    error: job.error ?? "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

// SERVER RESTART RECOVERY: jobs that were queued/running when the process died
// are resumed automatically on boot — the browser only ever reattaches.
// (Decision rule mirrored in web/src/lib/serverJobs.ts bootRecoveryAction — keep in sync.)
for (const job of Object.values(jobs)) {
  if (job.status === "running" || job.status === "queued") {
    job.logs = [...job.logs, "↻ server restarted — job resumed automatically from persisted state"].slice(-80);
    void executeJob(job);
  }
}

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
      return json(res, 200, { ok: true, version: 5, startedAt: SERVER_STARTED_AT, docker, ytdlp, agents: agents.length, jobs: Object.keys(jobs).length, stateProjects: Object.keys(projState).length });
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

    // Create a build job — returns the job id IMMEDIATELY; generation continues
    // server-side. DUPLICATE PREVENTION: an id that already exists is NEVER
    // restarted — the existing job is returned with duplicate:true (reattach).
    // (Decision rule mirrored in web/src/lib/serverJobs.ts duplicateDecision — keep in sync.)
    if (url.pathname === "/jobs" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 20_000_000)).toString());
      const id = String(body.id ?? `sjob_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`).slice(0, 80);
      const existing = jobs[id];
      if (existing) return json(res, 200, { ok: true, duplicate: true, job: publicJob(existing) });
      const job = {
        id,
        projectId: String(body.projectId ?? ""),
        prompt: String(body.prompt ?? ""),
        messages: Array.isArray(body.messages) ? body.messages : [],
        endpoints: Array.isArray(body.endpoints) ? body.endpoints : [],
        supabase: body.supabase,
        status: "queued", step: "queued", provider: "", retries: 0,
        logs: [], output: "", files: [], error: "",
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      jobs[id] = job;
      await persistJobs();
      void executeJob(job);
      return json(res, 200, { ok: true, duplicate: false, job: publicJob(job) });
    }

    if (url.pathname === "/jobs" && req.method === "GET") {
      const pid = url.searchParams.get("projectId") ?? "";
      const list = Object.values(jobs)
        .filter((j) => !pid || j.projectId === pid)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return json(res, 200, { ok: true, jobs: list.slice(0, 10).map((j) => publicJob(j)) });
    }

    const jobMatch = url.pathname.match(/^\/jobs\/([\w.-]+?)(?:\/(cancel|retry))?$/);
    if (jobMatch) {
      const job = jobs[jobMatch[1]];
      if (!job) return json(res, 404, { error: "job not found" });
      const action = jobMatch[2];
      if (!action && req.method === "GET") {
        return json(res, 200, { ok: true, job: publicJob(job, url.searchParams.get("full") === "1") });
      }
      if (action === "cancel" && req.method === "POST") {
        jobAborts.get(job.id)?.abort();
        if (job.status === "queued" || job.status === "running") {
          touchJob(job, { status: "cancelled", step: "cancelled by user" });
          await persistJobs();
          await mirrorJobRow(job, true);
        }
        return json(res, 200, { ok: true, job: publicJob(job) });
      }
      if (action === "retry" && req.method === "POST") {
        if (job.status === "running" || job.status === "queued") {
          return json(res, 409, { error: "job is still running — a live job is never restarted" });
        }
        touchJob(job, { status: "queued", step: "retry requested", error: "", retries: 0, output: "", files: [] });
        job.logs = [...job.logs, "↻ retry requested"].slice(-80);
        await persistJobs();
        void executeJob(job);
        return json(res, 200, { ok: true, job: publicJob(job) });
      }
    }

    // v4: state index — lets the mobile companion list synced projects.
    if (url.pathname === "/state" && req.method === "GET") {
      const projects = Object.entries(projState).map(([pid, kinds]) => ({
        id: pid,
        kinds: Object.keys(kinds),
        updatedAt: Math.max(0, ...Object.values(kinds).map((k) => Number(k.updatedAt) || 0)),
      }));
      return json(res, 200, { ok: true, projects });
    }

    // Per-project state sync (v3, extended in v4 with tasks + evolution).
    // Newer-wins — a push whose updatedAt is OLDER than the stored copy is
    // rejected with 409 so a stale browser can never clobber fresher state.
    // v5 adds the "project" kind: a full app snapshot (name + file list + bundled
    // HTML preview) so the mobile companion can SEE the app built on the PC.
    // "source" (v5) is the REAL project — files + chat — so projects created on
    // one device open as full projects on every other device.
    const stateMatch = url.pathname.match(/^\/state\/([\w.-]+)\/(queue|memory|checkpoints|tasks|evolution|project|source)$/);
    if (stateMatch) {
      const pid = stateMatch[1];
      const kind = stateMatch[2];
      if (req.method === "GET") {
        const env = projState[pid]?.[kind];
        return env
          ? json(res, 200, { ok: true, data: env.data, updatedAt: env.updatedAt })
          : json(res, 404, { error: "no state stored for this project/kind" });
      }
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req, 20_000_000)).toString());
        const incoming = { data: body.data, updatedAt: Number(body.updatedAt ?? Date.now()) };
        const existing = projState[pid]?.[kind];
        if (existing && existing.updatedAt > incoming.updatedAt) {
          return json(res, 409, { ok: false, conflict: true, updatedAt: existing.updatedAt });
        }
        projState[pid] = projState[pid] ?? {};
        projState[pid][kind] = incoming;
        await persistProjState();
        return json(res, 200, { ok: true, updatedAt: incoming.updatedAt });
      }
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
