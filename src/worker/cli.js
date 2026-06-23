#!/usr/bin/env node
/**
 * rcc-worker — point d'entrée CLI du bridge local.
 *
 * Env :
 *   RELAY_URL     = https://mecene.io           (base prod, sans slash final ; RAILWAY_URL accepté en fallback)
 *   WORKER_TOKEN  = <secret long aléatoire>      (doit matcher la var côté relais)
 *   RCC_PROJECTS  = chemin de projects.json       (défaut ./projects.json)
 *   POLL_MS       = intervalle de poll            (défaut 2000)
 *   CLAUDE_BIN    = binaire claude                (défaut "claude")
 *
 * projects.json :
 *   { "projects": [
 *       { "id": "mecene", "repo": "C:/dev/.../subvention_match", "branch": "rcc/chat", "worktree": "C:/dev/.../mecene-rcc-chat" }
 *   ] }
 */
import fs from "node:fs";
import path from "node:path";
import { createWorker } from "./worker.js";

const RELAY_URL = (process.env.RELAY_URL || process.env.RAILWAY_URL || "").trim();
const WORKER_TOKEN = (process.env.WORKER_TOKEN || "").trim();
const PROJECTS_FILE = path.resolve(process.env.RCC_PROJECTS || "projects.json");
const AGENTS_DIR = process.env.RCC_AGENTS_DIR ? path.resolve(process.env.RCC_AGENTS_DIR) : null;
const POLL_MS = Number(process.env.POLL_MS || 2000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

if (!RELAY_URL || !WORKER_TOKEN) {
  console.error("❌ RELAY_URL et WORKER_TOKEN requis (cf. en-tête de cli.js).");
  process.exit(1);
}

// projects.json optionnel si RCC_AGENTS_DIR fournit des agents auto-découverts.
let projects = [];
if (fs.existsSync(PROJECTS_FILE)) {
  try { const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8")); projects = Array.isArray(parsed) ? parsed : parsed.projects || []; }
  catch (e) { console.error(`❌ projects.json invalide (${PROJECTS_FILE}): ${e.message}`); process.exit(1); }
}
if (!projects.length && !AGENTS_DIR) {
  console.error("❌ Fournis RCC_AGENTS_DIR (dossier d'agents auto-découverts) ou projects.json.");
  process.exit(1);
}

const worker = createWorker({ relayUrl: RELAY_URL, workerToken: WORKER_TOKEN, agentsDir: AGENTS_DIR, projects, pollMs: POLL_MS, claudeBin: CLAUDE_BIN });

// Arrêt propre : on cesse de poller puis on attend la fin des exécutions en cours (garde 20s)
// pour ne pas orphéliner un child claude / laisser un worktree sale. 2e Ctrl-C = exit immédiat.
let stopping = false;
process.on("SIGINT", async () => {
  if (stopping) { console.log("\n⏹ arrêt forcé."); process.exit(1); }
  stopping = true;
  worker.stop();
  console.log("\n⏹ arrêt worker — attente des exécutions en cours (Ctrl-C à nouveau pour forcer)…");
  const deadline = Date.now() + 20000;
  while (worker.busyCount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (worker.busyCount > 0) console.log(`⚠ ${worker.busyCount} exec encore en cours après 20s — exit quand même.`);
  process.exit(0);
});
worker.start();
