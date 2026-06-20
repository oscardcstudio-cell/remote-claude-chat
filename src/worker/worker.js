/**
 * worker.js — bridge local multi-projet. Tourne sur le PC d'Oscar (jamais en prod).
 *
 * 1 process, N projets (projects.json). Boucle de poll sortante (PC derrière NAT) :
 *   POST <relayUrl>/_worker/poll  { projects: [projetsLIBRES] }   (header x-worker-token)
 *   → spawn `claude -p --output-format json [--resume <sid>]` dans le worktree du projet
 *   POST <relayUrl>/_worker/reply { id, projectId, convId, reply|error, costUsd }
 *
 * Concurrence : parallèle ENTRE projets, sérialisé DANS un projet — un projet en cours d'exec
 * est retiré de la liste de poll, donc ses messages suivants attendent (file d'attente par projet).
 *
 * Exec : CLI claude loggé à l'abonnement du PC. AUCUNE clé API n'est lue ni passée.
 * Capacités illimitées (push/rm/git reset OK) ; garde-fous = canal (2 tokens) + audit (relais).
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function createWorker({ relayUrl, workerToken, projects, pollMs = 2000, claudeBin = "claude", sessionsFile, log = console }) {
  if (!relayUrl) throw new Error("worker: relayUrl requis.");
  if (!workerToken) throw new Error("worker: workerToken requis.");
  if (!Array.isArray(projects) || !projects.length) throw new Error("worker: au moins un projet requis (projects.json).");

  relayUrl = relayUrl.replace(/\/$/, "");
  const byId = new Map(projects.map((p) => [p.id, normalizeProject(p)]));
  const busy = new Set();                      // projectIds en cours d'exec (sérialisation par projet)
  const SESSIONS = sessionsFile || path.resolve(process.cwd(), ".rcc-sessions.json");
  let sessions = loadJson(SESSIONS, {});
  let running = true;

  // ── worktree dédié par projet (jamais d'écriture directe sur la branche de travail) ──
  for (const p of byId.values()) ensureWorktree(p, log);

  function persistSessions() { try { fs.writeFileSync(SESSIONS, JSON.stringify(sessions, null, 2)); } catch (e) { log.error?.("⚠ save sessions:", e.message); } }

  async function api(method, route, body) {
    const r = await fetch(relayUrl + route, {
      method,
      headers: { "x-worker-token": workerToken, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error(`${method} ${route} → ${r.status}`);
    return r.json();
  }

  function runClaude(project, content, sessionId) {
    return new Promise((resolve) => {
      const args = ["-p", "--output-format", "json"];
      if (sessionId) args.push("--resume", sessionId);
      // shell:true → résout claude.cmd sur Windows. Prompt via stdin (zéro souci de quoting).
      // execCwd = sous-dossier du worktree (un repo peut héberger N works, chacun son CLAUDE.md).
      const child = spawn(claudeBin, args, { cwd: project.execCwd, shell: true });
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => resolve({ error: `spawn ${claudeBin}: ${e.message}` }));
      child.on("close", (code) => {
        if (code !== 0) return resolve({ error: `claude exit ${code}: ${(err || out).slice(0, 2000)}` });
        try {
          const j = JSON.parse(out);
          resolve({ reply: j.result ?? "", sessionId: j.session_id, costUsd: j.total_cost_usd });
        } catch {
          resolve({ reply: out.trim() || "(réponse vide)" });   // sortie non-JSON : renvoyer le brut
        }
      });
      child.stdin.write(content);
      child.stdin.end();
    });
  }

  async function runOne(msg) {
    const project = byId.get(msg.projectId);
    if (!project) { // message pour un projet que ce worker n'héberge pas (ne devrait pas arriver, on a filtré le poll)
      log.error?.(`⚠ message pour projet inconnu: ${msg.projectId}`);
      return;
    }
    const key = `${msg.projectId}:${msg.convId}`;
    log.log?.(`▶ [${msg.projectId}/${msg.convId}] ${msg.content.slice(0, 80)}`);
    const res = await runClaude(project, msg.content, sessions[key]);
    if (res.error) {
      log.error?.(`  ✗ ${res.error.slice(0, 200)}`);
      await api("POST", "/_worker/reply", { id: msg.id, projectId: msg.projectId, convId: msg.convId, error: res.error });
    } else {
      if (res.sessionId) { sessions[key] = res.sessionId; persistSessions(); }
      log.log?.(`  ✓ ${(res.reply || "").slice(0, 80)}${res.costUsd != null ? ` ($${res.costUsd})` : ""}`);
      await api("POST", "/_worker/reply", { id: msg.id, projectId: msg.projectId, convId: msg.convId, reply: res.reply, costUsd: res.costUsd });
    }
  }

  async function tick() {
    const free = [...byId.keys()].filter((id) => !busy.has(id));
    if (!free.length) return;                                  // tous les projets occupés
    const { message } = await api("POST", "/_worker/poll", { projects: free });
    if (!message) return;
    busy.add(message.projectId);                               // marque busy AVANT l'exec (sérialise le projet)
    runOne(message).catch((e) => log.error?.("⚠ exec:", e.message)).finally(() => busy.delete(message.projectId));
  }

  async function start() {
    log.log?.(`🔌 rcc-worker → ${relayUrl} · ${byId.size} projet(s) · poll ${pollMs}ms`);
    while (running) {
      try { await tick(); } catch (e) { log.error?.("⚠ poll:", e.message); }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  function stop() { running = false; }

  return { start, stop, get projects() { return [...byId.values()]; } };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function normalizeProject(p) {
  if (!p.id || !p.repo) throw new Error(`projet invalide (id + repo requis): ${JSON.stringify(p)}`);
  const repo = path.resolve(p.repo);
  const worktree = p.worktree ? path.resolve(p.worktree) : path.resolve(repo, "..", `${path.basename(repo)}-rcc-chat`);
  return {
    id: p.id,
    repo,
    branch: p.branch || "rcc/chat",
    worktree,
    // execCwd : sous-dossier du worktree où claude s'exécute (charge le CLAUDE.md local). Défaut = racine.
    execCwd: p.cwd ? path.join(worktree, p.cwd) : worktree,
  };
}

function ensureWorktree(p, log) {
  if (fs.existsSync(path.join(p.worktree, ".git"))) { log.log?.(`✓ worktree [${p.id}]: ${p.worktree}`); return; }
  try {
    const branches = execFileSync("git", ["branch", "--list", p.branch], { cwd: p.repo, encoding: "utf8" });
    const args = branches.trim()
      ? ["worktree", "add", p.worktree, p.branch]
      : ["worktree", "add", p.worktree, "-b", p.branch];
    execFileSync("git", args, { cwd: p.repo, stdio: "inherit" });
    log.log?.(`✓ worktree créé [${p.id}]: ${p.worktree} (${p.branch})`);
  } catch (e) {
    throw new Error(`worktree [${p.id}] impossible (${p.worktree}): ${e.message}\n  → manuel: git -C "${p.repo}" worktree add "${p.worktree}" -b ${p.branch}`);
  }
}

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
