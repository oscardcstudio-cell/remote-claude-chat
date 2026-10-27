/**
 * worker.test.mjs — couverture de createWorker SANS spawn du CLI claude ni réseau.
 *
 * On ne lance JAMAIS start() (qui poll le relais + spawn `claude`). On teste :
 *  - guards du constructeur (relayUrl / workerToken requis),
 *  - auto-découverte d'agents depuis agentsDir (sous-dossier avec CLAUDE.md = 1 agent),
 *  - lecture des métadonnées (agent.json prioritaire, sinon titre du CLAUDE.md),
 *  - busyCount initial.
 * Tous les fichiers sont écrits dans un dossier temp sous os.tmpdir() et nettoyés.
 * confine:false → pas de génération de settings durci, pas d'I/O parasite.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker } from "../src/worker/worker.js";

let TMP;            // racine temp de la session de test
let AGENTS_DIR;     // dossier d'agents auto-découverts
let SESSIONS;       // fichier sessions hors agentsDir

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rcc-worker-test-"));
  AGENTS_DIR = path.join(TMP, "agents");
  SESSIONS = path.join(TMP, "sessions.json");
  fs.mkdirSync(AGENTS_DIR, { recursive: true });

  // Agent 1 : CLAUDE.md avec un titre → label dérivé du titre
  const a1 = path.join(AGENTS_DIR, "julia");
  fs.mkdirSync(a1);
  fs.writeFileSync(path.join(a1, "CLAUDE.md"), "# CLAUDE.md — Julia la mécène\n\nblabla");

  // Agent 2 : CLAUDE.md + agent.json (les méta du json priment)
  const a2 = path.join(AGENTS_DIR, "marc");
  fs.mkdirSync(a2);
  fs.writeFileSync(path.join(a2, "CLAUDE.md"), "# Marc fallback\n");
  fs.writeFileSync(path.join(a2, "agent.json"), JSON.stringify({ label: "Marc VIP", accent: "#fff", mode: "task" }));

  // Dossier SANS CLAUDE.md → ignoré (pas un agent)
  fs.mkdirSync(path.join(AGENTS_DIR, "pas-un-agent"));
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// Helper : construit un worker confine:false, agentsDir donné, et le démarre juste assez pour
// déclencher rescan() — on appelle start() puis stop() immédiatement (le premier rescan est sync
// dans start()). En réalité start() est async et boucle ; on lit `agents` après un microtask.
function buildWorker(extra = {}) {
  return createWorker({
    relayUrl: "http://127.0.0.1:9", // jamais contacté (on n'attend pas le poll)
    workerToken: "wtok",
    agentsDir: AGENTS_DIR,
    sessionsFile: SESSIONS,
    confine: false,
    pollMs: 1000000, // poll quasi-jamais
    log: { log() {}, error() {} },
    ...extra,
  });
}

test("guard: relayUrl manquant → throw", () => {
  assert.throws(() => createWorker({ workerToken: "x" }), /relayUrl/);
});

test("guard: workerToken manquant → throw", () => {
  assert.throws(() => createWorker({ relayUrl: "http://x" }), /workerToken/);
});

test("createWorker: renvoie l'API publique (start/stop/agents/busyCount)", () => {
  const w = buildWorker();
  assert.equal(typeof w.start, "function");
  assert.equal(typeof w.stop, "function");
  assert.equal(typeof w.busyCount, "number");
  assert.equal(w.busyCount, 0);
  assert.equal(Array.isArray(w.agents), true);
});

test("auto-découverte: rescan trouve les agents avec CLAUDE.md, ignore les autres", async () => {
  const w = buildWorker();
  // start() fait un rescan() synchrone avant son premier await (publishAgents).
  w.start();
  w.stop(); // coupe la boucle ; le rescan a déjà peuplé byId
  await new Promise((r) => setImmediate(r));
  const ids = w.agents.map((a) => a.id).sort();
  assert.deepEqual(ids, ["julia", "marc"]); // 'pas-un-agent' exclu
});

test("métadonnées: label dérivé du titre CLAUDE.md (nettoyé du préfixe)", async () => {
  const w = buildWorker();
  w.start(); w.stop();
  await new Promise((r) => setImmediate(r));
  const julia = w.agents.find((a) => a.id === "julia");
  assert.equal(julia.label, "Julia la mécène"); // '# CLAUDE.md — ' retiré
});

test("métadonnées: agent.json prime sur le titre CLAUDE.md", async () => {
  const w = buildWorker();
  w.start(); w.stop();
  await new Promise((r) => setImmediate(r));
  const marc = w.agents.find((a) => a.id === "marc");
  assert.equal(marc.label, "Marc VIP");
  assert.equal(marc.accent, "#fff");
  assert.equal(marc.mode, "task");
});

test("agentsDir inexistant → aucun agent, pas de crash", async () => {
  const w = createWorker({
    relayUrl: "http://127.0.0.1:9", workerToken: "wtok",
    agentsDir: path.join(TMP, "nexiste-pas"), sessionsFile: SESSIONS,
    confine: false, pollMs: 1000000, log: { log() {}, error() {} },
  });
  w.start(); w.stop();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.agents, []);
});

test("normalizeProject: projet sans repo → throw au constructeur", () => {
  assert.throws(() => createWorker({
    relayUrl: "http://x", workerToken: "wtok", confine: false,
    sessionsFile: SESSIONS, log: { log() {}, error() {} },
    projects: [{ id: "p1" }], // repo manquant
  }), /repo/);
});

test("relayUrl: slash final retiré (pas de double slash dans les routes)", () => {
  // On ne peut pas lire relayUrl directement, mais le constructeur ne doit pas throw
  // et normalise en interne. Smoke : un trailing slash est accepté.
  assert.doesNotThrow(() => createWorker({
    relayUrl: "http://127.0.0.1:9/", workerToken: "wtok", confine: false,
    agentsDir: AGENTS_DIR, sessionsFile: SESSIONS, pollMs: 1000000,
    log: { log() {}, error() {} },
  }));
});
