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
const POLL_MS = Number(process.env.POLL_MS || 2000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

if (!RELAY_URL || !WORKER_TOKEN) {
  console.error("❌ RELAY_URL et WORKER_TOKEN requis (cf. en-tête de cli.js).");
  process.exit(1);
}
if (!fs.existsSync(PROJECTS_FILE)) {
  console.error(`❌ projects.json introuvable: ${PROJECTS_FILE} (override via RCC_PROJECTS).`);
  process.exit(1);
}

let projects;
try {
  const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
  projects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(projects) || !projects.length) throw new Error("aucun projet");
} catch (e) {
  console.error(`❌ projects.json invalide (${PROJECTS_FILE}): ${e.message}`);
  process.exit(1);
}

const worker = createWorker({ relayUrl: RELAY_URL, workerToken: WORKER_TOKEN, projects, pollMs: POLL_MS, claudeBin: CLAUDE_BIN });
process.on("SIGINT", () => { console.log("\n⏹ arrêt worker."); worker.stop(); setTimeout(() => process.exit(0), 100); });
worker.start();
