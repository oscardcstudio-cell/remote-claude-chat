/**
 * worker.js — bridge local multi-agents. Tourne sur le PC d'Oscar (jamais en prod).
 *
 * Deux sources d'agents :
 *  - `agentsDir` : un dossier dont CHAQUE sous-dossier contenant un CLAUDE.md = un agent
 *    AUTO-DÉCOUVERT (déposer un dossier → l'agent apparaît, zéro config). Exec en place
 *    (cwd = le dossier de l'agent). Pensé pour des agents de discussion (peu d'écriture).
 *  - `projects` : agents explicites {id, repo, branch, cwd} exécutés dans un WORKTREE dédié
 *    (isolation, pour les agents qui écrivent — ex un corpus retravaillé).
 *
 * Boucle : POST <relayUrl>/_worker/poll {projects:[ids LIBRES]} → spawn `claude -p --resume`
 * dans le bon cwd → POST /_worker/reply. Publie la liste d'agents via POST /_worker/agents
 * (le relais la sert au dashboard → sélecteur d'agents).
 *
 * Exec : CLI claude loggé à l'abonnement. Aucune clé API. Capacités illimitées.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function createWorker({ relayUrl, workerToken, agentsDir, projects = [], pollMs = 2000, claudeBin = "claude", sessionsFile, rescanMs = 15000, log = console }) {
  if (!relayUrl) throw new Error("worker: relayUrl requis.");
  if (!workerToken) throw new Error("worker: workerToken requis.");
  relayUrl = relayUrl.replace(/\/$/, "");

  const explicit = projects.map(normalizeProject);
  for (const p of explicit) ensureWorktree(p, log);          // worktree pour les agents explicites
  const byId = new Map();
  const busy = new Set();
  const SESSIONS = sessionsFile || path.resolve(process.cwd(), ".rcc-sessions.json");
  let sessions = loadJson(SESSIONS, {});
  let running = true, lastPublished = "";

  function rescan() {
    const next = new Map();
    for (const p of explicit) next.set(p.id, p);             // agents explicites (worktree)
    if (agentsDir && fs.existsSync(agentsDir)) {             // agents auto-découverts (exec en place)
      for (const name of fs.readdirSync(agentsDir)) {
        const dir = path.join(agentsDir, name);
        if (!fs.existsSync(path.join(dir, "CLAUDE.md"))) continue;
        if (next.has(name)) continue;                        // un explicite gagne sur l'auto
        next.set(name, { id: name, execCwd: dir, ...readMeta(dir, name) });
      }
    }
    byId.clear();
    for (const [k, v] of next) byId.set(k, v);
  }

  async function api(method, route, body) {
    const r = await fetch(relayUrl + route, {
      method, headers: { "x-worker-token": workerToken, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error(`${method} ${route} → ${r.status}`);
    return r.json().catch(() => ({}));
  }

  async function publishAgents() {
    const list = [...byId.values()].map((a) => ({ id: a.id, label: a.label, accent: a.accent, mode: a.mode || "chat" }));
    const sig = JSON.stringify(list);
    if (sig === lastPublished) return;
    try { await api("POST", "/_hub/agents", { agents: list }); lastPublished = sig; log.log?.(`↑ ${list.length} agent(s) publié(s)`); }
    catch (e) { log.error?.("⚠ publish agents:", e.message); }
  }

  function runClaude(agent, content, sessionId) {
    return new Promise((resolve) => {
      const args = ["-p", "--output-format", "json"];
      if (sessionId) args.push("--resume", sessionId);
      const child = spawn(claudeBin, args, { cwd: agent.execCwd, shell: true });
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => resolve({ error: `spawn ${claudeBin}: ${e.message}` }));
      child.on("close", (code) => {
        if (code !== 0) return resolve({ error: `claude exit ${code}: ${(err || out).slice(0, 2000)}` });
        try { const j = JSON.parse(out); resolve({ reply: j.result ?? "", sessionId: j.session_id, costUsd: j.total_cost_usd }); }
        catch { resolve({ reply: out.trim() || "(réponse vide)" }); }
      });
      child.stdin.write(content); child.stdin.end();
    });
  }

  async function runOne(msg) {
    const agent = byId.get(msg.projectId);
    if (!agent) { log.error?.(`⚠ agent inconnu: ${msg.projectId}`); return; }
    const key = `${msg.projectId}:${msg.convId}`;
    log.log?.(`▶ [${msg.projectId}] ${msg.content.slice(0, 70)}`);
    const res = await runClaude(agent, msg.content, sessions[key]);
    if (res.error) { log.error?.(`  ✗ ${res.error.slice(0, 160)}`); await api("POST", "/_worker/reply", { id: msg.id, projectId: msg.projectId, convId: msg.convId, error: res.error }); }
    else { if (res.sessionId) { sessions[key] = res.sessionId; saveJson(SESSIONS, sessions, log); }
      await api("POST", "/_worker/reply", { id: msg.id, projectId: msg.projectId, convId: msg.convId, reply: res.reply, costUsd: res.costUsd }); }
  }

  async function tick() {
    const free = [...byId.keys()].filter((id) => !busy.has(id));
    if (!free.length) return;
    const { message } = await api("POST", "/_worker/poll", { projects: free });
    if (!message) return;
    busy.add(message.projectId);
    runOne(message).catch((e) => log.error?.("⚠ exec:", e.message)).finally(() => busy.delete(message.projectId));
  }

  async function start() {
    rescan(); await publishAgents();
    log.log?.(`🔌 rcc-worker → ${relayUrl} · ${byId.size} agent(s) · poll ${pollMs}ms`);
    let lastScan = Date.now();
    while (running) {
      try {
        if (Date.now() - lastScan > rescanMs) { rescan(); await publishAgents(); lastScan = Date.now(); }
        await tick();
      } catch (e) { log.error?.("⚠ poll:", e.message); }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  function stop() { running = false; }
  return { start, stop, get agents() { return [...byId.values()]; } };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function readMeta(dir, id) {
  let label = id, accent = "#c8a86b", mode = "chat";
  const metaFile = path.join(dir, "agent.json");
  if (fs.existsSync(metaFile)) { try { const m = JSON.parse(fs.readFileSync(metaFile, "utf8")); label = m.label || label; accent = m.accent || accent; mode = m.mode || mode; return { label, accent, mode }; } catch {} }
  try { const h = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").split("\n").find((l) => l.startsWith("# ")); if (h) label = h.replace(/^#\s*/, "").replace(/^CLAUDE\.md\s*[—-]\s*/i, "").trim(); } catch {}
  return { label, accent, mode };
}

function normalizeProject(p) {
  if (!p.id || !p.repo) throw new Error(`projet invalide (id + repo requis): ${JSON.stringify(p)}`);
  const repo = path.resolve(p.repo);
  const worktree = p.worktree ? path.resolve(p.worktree) : path.resolve(repo, "..", `${path.basename(repo)}-rcc-chat`);
  return { id: p.id, repo, branch: p.branch || "rcc/chat", worktree, execCwd: p.cwd ? path.join(worktree, p.cwd) : worktree, label: p.label || p.id, accent: p.accent, mode: p.mode || "chat" };
}

function ensureWorktree(p, log) {
  if (fs.existsSync(path.join(p.worktree, ".git"))) { log.log?.(`✓ worktree [${p.id}]`); return; }
  try {
    const branches = execFileSync("git", ["branch", "--list", p.branch], { cwd: p.repo, encoding: "utf8" });
    execFileSync("git", branches.trim() ? ["worktree", "add", p.worktree, p.branch] : ["worktree", "add", p.worktree, "-b", p.branch], { cwd: p.repo, stdio: "inherit" });
    log.log?.(`✓ worktree créé [${p.id}]`);
  } catch (e) { throw new Error(`worktree [${p.id}] impossible: ${e.message}`); }
}

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function saveJson(file, data, log) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { log.error?.("⚠ save:", e.message); } }
