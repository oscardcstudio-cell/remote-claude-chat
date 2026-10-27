/**
 * router.test.mjs — couverture du relais HTTP createChatRelayRouter.
 *
 * On monte le router sur un vrai serveur express + http.Server local (loopback éphémère),
 * et on tape dessus avec fetch. Store = memoryStore (JAMAIS drizzle/Postgres réel).
 * Aucun appel réseau externe : tout reste sur 127.0.0.1.
 *
 * Axes couverts : auth fail-closed (le défaut sécu), validation d'input, scope projet,
 * quota journalier (429), surfaces worker (poll/reply) avec WORKER_TOKEN constant-time,
 * token "personne" (*) + allow-list, devBypass opt-in.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createChatRelayRouter } from "../src/server/createChatRelayRouter.js";
import { createMemoryStore } from "../src/server/stores/memoryStore.js";

// ── Petit harness : monte un router sur un serveur loopback, renvoie une fonction de requête. ──
function mountServer(routerOpts) {
  const app = express();
  app.use(createChatRelayRouter(routerOpts));
  // Handler d'erreur express (les routes appellent next(e) → 500 par défaut, on le rend lisible).
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err?.message || err) }); });
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      async function req(method, path, { headers = {}, body } = {}) {
        const r = await fetch(base + path, {
          method,
          headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await r.json(); } catch { /* corps vide */ }
        return { status: r.status, json };
      }
      resolve({ req, close: () => new Promise((res) => server.close(res)) });
    });
  });
}

// ── Construit l'env standard : fail-closed (devBypass off), workerToken fixe. ──
function makeEnv(extraTokens = []) {
  const store = createMemoryStore({
    tokens: [
      { token: "tok-julia", projectId: "mecene", dailyCap: 2 },
      { token: "tok-marc", projectId: "autreprojet" },
      { token: "tok-off", projectId: "mecene", disabled: true },
      ...extraTokens,
    ],
  });
  return { store, workerToken: "WTOK-secret" };
}

test("constructeur: store manquant → throw", () => {
  assert.throws(() => createChatRelayRouter({}), /store/);
  assert.throws(() => createChatRelayRouter(), /store/);
});

test("constructeur: store fourni → renvoie un router express", () => {
  const { store } = makeEnv();
  const router = createChatRelayRouter({ store });
  assert.equal(typeof router, "function"); // un Router express est une fonction middleware
});

// ── Surface POTE : auth fail-closed ──────────────────────────────────────────────
test("pote: sans x-access-token → 401 (fail-closed)", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("GET", "/api/chat/c1");
    assert.equal(r.status, 401);
    assert.match(r.json.error, /autoris/i);
  } finally { await srv.close(); }
});

test("pote: token inconnu → 401", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("GET", "/api/chat/c1", { headers: { "x-access-token": "n-existe-pas" } });
    assert.equal(r.status, 401);
  } finally { await srv.close(); }
});

test("pote: token disabled → 401", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("GET", "/api/chat/c1", { headers: { "x-access-token": "tok-off" } });
    assert.equal(r.status, 401);
  } finally { await srv.close(); }
});

test("pote: token valide → liste conversation (vide au départ)", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("GET", "/api/chat/c1", { headers: { "x-access-token": "tok-julia" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.messages, []);
  } finally { await srv.close(); }
});

// ── Surface POTE : envoi message + validation ────────────────────────────────────
test("pote: POST message vide → 400 content requis", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("POST", "/api/chat/c1/message", {
      headers: { "x-access-token": "tok-julia" }, body: { content: "   " },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /content/i);
  } finally { await srv.close(); }
});

test("pote: POST message sans body content → 400", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("POST", "/api/chat/c1/message", {
      headers: { "x-access-token": "tok-julia" }, body: {},
    });
    assert.equal(r.status, 400);
  } finally { await srv.close(); }
});

test("pote: POST message valide → enqueued + audit, scope au projet du token", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("POST", "/api/chat/c1/message", {
      headers: { "x-access-token": "tok-julia" }, body: { content: "  salut  " },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.message.content, "salut"); // trim appliqué
    assert.equal(r.json.message.projectId, "mecene"); // scope = projet du token, jamais du client
    assert.equal(r.json.message.status, "queued");
    // audit tracé
    assert.equal(store._events.some((e) => e.action === "chat.message"), true);
  } finally { await srv.close(); }
});

test("pote: ne peut pas usurper un autre projet via header (scope = token, pas client)", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    // marc (autreprojet) tente d'injecter dans mecene via x-project-id → ignoré (token scopé)
    const r = await srv.req("POST", "/api/chat/c1/message", {
      headers: { "x-access-token": "tok-marc", "x-project-id": "mecene" }, body: { content: "intrusion" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.message.projectId, "autreprojet"); // resté sur SON projet
  } finally { await srv.close(); }
});

test("pote: quota journalier dépassé → 429", async () => {
  const { store, workerToken } = makeEnv(); // tok-julia dailyCap=2
  const srv = await mountServer({ store, workerToken });
  try {
    const h = { "x-access-token": "tok-julia" };
    assert.equal((await srv.req("POST", "/api/chat/c1/message", { headers: h, body: { content: "1" } })).status, 200);
    assert.equal((await srv.req("POST", "/api/chat/c1/message", { headers: h, body: { content: "2" } })).status, 200);
    const r3 = await srv.req("POST", "/api/chat/c1/message", { headers: h, body: { content: "3" } });
    assert.equal(r3.status, 429);
    assert.match(r3.json.error, /[Qq]uota/);
  } finally { await srv.close(); }
});

test("pote: dailyCap null → pas de quota (marc illimité)", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const h = { "x-access-token": "tok-marc" };
    for (let i = 0; i < 5; i++) {
      const r = await srv.req("POST", "/api/chat/m/message", { headers: h, body: { content: `m${i}` } });
      assert.equal(r.status, 200);
    }
  } finally { await srv.close(); }
});

// ── Token "personne" (*) + allow-list ────────────────────────────────────────────
test("pote: token '*' sans x-project-id → 400", async () => {
  const { store, workerToken } = makeEnv([{ token: "tok-star", projectId: "*" }]);
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("GET", "/api/chat/c1", { headers: { "x-access-token": "tok-star" } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /x-project-id/);
  } finally { await srv.close(); }
});

test("pote: token '*' + x-project-id → cible cet agent", async () => {
  const { store, workerToken } = makeEnv([{ token: "tok-star", projectId: "*" }]);
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("POST", "/api/chat/c1/message", {
      headers: { "x-access-token": "tok-star", "x-project-id": "nimporte" }, body: { content: "yo" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.message.projectId, "nimporte");
  } finally { await srv.close(); }
});

test("pote: token '*' avec allow-list → projet hors-liste = 403", async () => {
  const { store, workerToken } = makeEnv([{ token: "tok-star", projectId: "*", allowList: ["mecene"] }]);
  const srv = await mountServer({ store, workerToken });
  try {
    const ok = await srv.req("POST", "/api/chat/c1/message", {
      headers: { "x-access-token": "tok-star", "x-project-id": "mecene" }, body: { content: "ok" },
    });
    assert.equal(ok.status, 200);
    const ko = await srv.req("POST", "/api/chat/c1/message", {
      headers: { "x-access-token": "tok-star", "x-project-id": "interdit" }, body: { content: "ko" },
    });
    assert.equal(ko.status, 403);
    assert.match(ko.json.error, /non autoris/i);
  } finally { await srv.close(); }
});

// ── Surface WORKER : auth WORKER_TOKEN ───────────────────────────────────────────
test("worker: WORKER_TOKEN absent → 503 (worker désactivé)", async () => {
  const { store } = makeEnv();
  const srv = await mountServer({ store, workerToken: "" }); // pas de token serveur
  try {
    const r = await srv.req("POST", "/_worker/poll", { body: { projects: ["mecene"] } });
    assert.equal(r.status, 503);
  } finally { await srv.close(); }
});

test("worker: mauvais x-worker-token → 401", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("POST", "/_worker/poll", {
      headers: { "x-worker-token": "WTOK-faux" }, body: { projects: ["mecene"] },
    });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /Worker/);
  } finally { await srv.close(); }
});

test("worker: token de mauvaise longueur → 401 (safeEqual rejette length mismatch)", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("POST", "/_worker/poll", {
      headers: { "x-worker-token": "x" }, body: { projects: ["mecene"] },
    });
    assert.equal(r.status, 401);
  } finally { await srv.close(); }
});

test("worker: poll sans projects[] → 400", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r = await srv.req("POST", "/_worker/poll", {
      headers: { "x-worker-token": workerToken }, body: {},
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /projects/);
  } finally { await srv.close(); }
});

test("worker: cycle complet poll → reply → conversation visible côté pote", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    // pote envoie
    const sent = await srv.req("POST", "/api/chat/conv9/message", {
      headers: { "x-access-token": "tok-julia" }, body: { content: "question" },
    });
    const msgId = sent.json.message.id;
    // worker poll → reçoit le message queued
    const poll = await srv.req("POST", "/_worker/poll", {
      headers: { "x-worker-token": workerToken }, body: { projects: ["mecene"] },
    });
    assert.equal(poll.status, 200);
    assert.equal(poll.json.message.id, msgId);
    assert.equal(poll.json.message.content, "question");
    // re-poll immédiat → null (passé delivered)
    const poll2 = await srv.req("POST", "/_worker/poll", {
      headers: { "x-worker-token": workerToken }, body: { projects: ["mecene"] },
    });
    assert.equal(poll2.json.message, null);
    // worker reply
    const rep = await srv.req("POST", "/_worker/reply", {
      headers: { "x-worker-token": workerToken },
      body: { id: msgId, projectId: "mecene", convId: "conv9", reply: "réponse" },
    });
    assert.equal(rep.status, 200);
    assert.equal(rep.json.ok, true);
    // pote relit → bulle assistant présente
    const list = await srv.req("GET", "/api/chat/conv9", { headers: { "x-access-token": "tok-julia" } });
    const roles = list.json.messages.map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant"]);
    assert.equal(list.json.messages[1].content, "réponse");
  } finally { await srv.close(); }
});

test("worker: reply sans id ou convId → 400", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const r1 = await srv.req("POST", "/_worker/reply", {
      headers: { "x-worker-token": workerToken }, body: { convId: "c" },
    });
    assert.equal(r1.status, 400);
    const r2 = await srv.req("POST", "/_worker/reply", {
      headers: { "x-worker-token": workerToken }, body: { id: "x" },
    });
    assert.equal(r2.status, 400);
  } finally { await srv.close(); }
});

test("worker: reply error → bulle d'erreur + audit ok:false", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    const sent = await srv.req("POST", "/api/chat/ce/message", {
      headers: { "x-access-token": "tok-julia" }, body: { content: "boom" },
    });
    const msgId = sent.json.message.id;
    await srv.req("POST", "/_worker/poll", { headers: { "x-worker-token": workerToken }, body: { projects: ["mecene"] } });
    const rep = await srv.req("POST", "/_worker/reply", {
      headers: { "x-worker-token": workerToken },
      body: { id: msgId, projectId: "mecene", convId: "ce", error: "exit 1" },
    });
    assert.equal(rep.status, 200);
    const list = await srv.req("GET", "/api/chat/ce", { headers: { "x-access-token": "tok-julia" } });
    assert.equal(list.json.messages.some((m) => m.role === "assistant" && /Erreur/.test(m.content)), true);
    // audit chat.exec avec ok:false
    const execEvt = store._events.find((e) => e.action === "chat.exec");
    assert.equal(execEvt.detail.ok, false);
  } finally { await srv.close(); }
});

test("worker: poll filtre par projet (ne sert pas un projet non hébergé)", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken });
  try {
    await srv.req("POST", "/api/chat/c/message", { headers: { "x-access-token": "tok-marc" }, body: { content: "x" } });
    // worker n'héberge que mecene → ne voit pas autreprojet
    const poll = await srv.req("POST", "/_worker/poll", {
      headers: { "x-worker-token": workerToken }, body: { projects: ["mecene"] },
    });
    assert.equal(poll.json.message, null);
  } finally { await srv.close(); }
});

// ── devBypass : opt-in explicite (jamais déduit) ─────────────────────────────────
test("devBypass: true → accès sans token, projet via header (défaut 'dev')", async () => {
  const { store } = makeEnv();
  const srv = await mountServer({ store, devBypass: true });
  try {
    const r = await srv.req("POST", "/api/chat/c1/message", { body: { content: "sans token" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.message.projectId, "dev");
    // worker aussi bypassé
    const poll = await srv.req("POST", "/_worker/poll", { body: { projects: ["dev"] } });
    assert.equal(poll.status, 200);
  } finally { await srv.close(); }
});

test("devBypass: x-project-id respecté en bypass", async () => {
  const { store } = makeEnv();
  const srv = await mountServer({ store, devBypass: true });
  try {
    const r = await srv.req("POST", "/api/chat/c1/message", {
      headers: { "x-project-id": "monprojet" }, body: { content: "x" },
    });
    assert.equal(r.json.message.projectId, "monprojet");
  } finally { await srv.close(); }
});

// ── Bases personnalisées ─────────────────────────────────────────────────────────
test("apiBase/workerBase personnalisés → routes montées au bon préfixe", async () => {
  const { store, workerToken } = makeEnv();
  const srv = await mountServer({ store, workerToken, apiBase: "/chat", workerBase: "/wk" });
  try {
    const r = await srv.req("GET", "/chat/c1", { headers: { "x-access-token": "tok-julia" } });
    assert.equal(r.status, 200);
    const w = await srv.req("POST", "/wk/poll", { headers: { "x-worker-token": workerToken }, body: { projects: ["mecene"] } });
    assert.equal(w.status, 200);
    // l'ancien préfixe ne répond plus (404)
    const old = await srv.req("GET", "/api/chat/c1", { headers: { "x-access-token": "tok-julia" } });
    assert.equal(old.status, 404);
  } finally { await srv.close(); }
});
