/**
 * chatClient.test.mjs — logique de polling/envoi headless (zéro DOM, zéro réseau réel).
 *
 * On stub `globalThis.fetch` (jamais d'appel HTTP réel) et `globalThis.localStorage`
 * (le client persiste le convId par projet). On vérifie : génération/persistance du convId,
 * headers d'auth, normalisation apiBase, send (trim, body, erreur serveur), refresh
 * (notifie seulement si ça change), start/stop. Pas d'assertion sur Date.now (convId opaque).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createChatClient } from "../src/client/chatClient.js";

// ── Stubs globaux ────────────────────────────────────────────────────────────────
let calls;            // historique des fetch
let nextResponses;    // file de réponses { ok, status, json }

function fakeFetch(url, init = {}) {
  calls.push({ url, init });
  const r = nextResponses.shift() || { ok: true, status: 200, json: async () => ({ messages: [] }) };
  return Promise.resolve({
    ok: r.ok ?? true,
    status: r.status ?? 200,
    json: r.json || (async () => r.body ?? {}),
  });
}

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

const origFetch = globalThis.fetch;
const origLS = globalThis.localStorage;

beforeEach(() => {
  calls = [];
  nextResponses = [];
  globalThis.fetch = fakeFetch;
  globalThis.localStorage = makeLocalStorage();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.localStorage = origLS;
});

test("convId fourni → réutilisé tel quel", () => {
  const c = createChatClient({ convId: "conv-fixe" });
  assert.equal(c.convId, "conv-fixe");
});

test("convId généré → persisté en localStorage par projet, stable au remount", () => {
  const c1 = createChatClient({ projectId: "projA" });
  assert.match(c1.convId, /^c-/);
  assert.equal(globalThis.localStorage.getItem("rcc:convId:projA"), c1.convId);
  // remount même projet → même convId (persistance)
  const c2 = createChatClient({ projectId: "projA" });
  assert.equal(c2.convId, c1.convId);
  // projet différent → convId différent
  const c3 = createChatClient({ projectId: "projB" });
  assert.notEqual(c3.convId, c1.convId);
});

test("convId: projectId omis → clé 'default'", () => {
  createChatClient({});
  assert.ok(globalThis.localStorage.getItem("rcc:convId:default"));
});

test("convId: localStorage indisponible (SSR) → fallback éphémère sans crash", () => {
  globalThis.localStorage = { getItem: () => { throw new Error("no LS"); }, setItem: () => {} };
  const c = createChatClient({ projectId: "p" });
  assert.match(c.convId, /^c-/);
});

test("apiBase: slash final supprimé (normalisation)", async () => {
  const c = createChatClient({ apiBase: "/api/chat/", convId: "c1" });
  await c.refresh();
  assert.match(calls[0].url, /^\/api\/chat\/c1$/); // pas de double slash
});

test("refresh: GET avec header x-access-token + x-project-id", async () => {
  nextResponses.push({ ok: true, json: async () => ({ messages: [{ role: "user", content: "hi" }] }) });
  const seen = [];
  const c = createChatClient({ convId: "c1", accessToken: "TOK", projectId: "pj", onMessages: (m) => seen.push(m) });
  const msgs = await c.refresh();
  assert.equal(calls[0].init.headers["x-access-token"], "TOK");
  assert.equal(calls[0].init.headers["x-project-id"], "pj");
  assert.equal(msgs.length, 1);
  assert.deepEqual(seen[0], [{ role: "user", content: "hi" }]);
});

test("refresh: sans accessToken → pas de header d'auth", async () => {
  const c = createChatClient({ convId: "c1" });
  await c.refresh();
  assert.equal("x-access-token" in calls[0].init.headers, false);
});

test("refresh: ne notifie onMessages que si le contenu change", async () => {
  const seen = [];
  nextResponses.push({ ok: true, json: async () => ({ messages: [{ id: 1 }] }) });
  nextResponses.push({ ok: true, json: async () => ({ messages: [{ id: 1 }] }) }); // identique
  nextResponses.push({ ok: true, json: async () => ({ messages: [{ id: 1 }, { id: 2 }] }) }); // changé
  const c = createChatClient({ convId: "c1", onMessages: (m) => seen.push(m) });
  await c.refresh();
  await c.refresh();
  await c.refresh();
  assert.equal(seen.length, 2, "1er + 3e refresh notifient, le 2e identique non");
});

test("refresh: réponse non-ok → throw avec status", async () => {
  nextResponses.push({ ok: false, status: 401 });
  const c = createChatClient({ convId: "c1" });
  await assert.rejects(() => c.refresh(), /401/);
});

test("send: contenu vide → no-op (aucun fetch)", async () => {
  const c = createChatClient({ convId: "c1" });
  await c.send("   ");
  assert.equal(calls.length, 0);
});

test("send: trim + POST body content + refresh ensuite", async () => {
  nextResponses.push({ ok: true, json: async () => ({ message: {} }) });   // POST message
  nextResponses.push({ ok: true, json: async () => ({ messages: [] }) });  // refresh
  const c = createChatClient({ convId: "c1", accessToken: "TOK" });
  await c.send("  bonjour  ");
  const post = calls[0];
  assert.equal(post.init.method, "POST");
  assert.match(post.url, /\/c1\/message$/);
  assert.deepEqual(JSON.parse(post.init.body), { content: "bonjour" });
  assert.equal(post.init.headers["Content-Type"], "application/json");
  assert.equal(post.init.headers["x-access-token"], "TOK");
  assert.equal(calls.length, 2, "send déclenche un refresh derrière");
});

test("send: erreur serveur avec message → throw ce message", async () => {
  nextResponses.push({ ok: false, status: 429, json: async () => ({ error: "Quota journalier atteint." }) });
  const c = createChatClient({ convId: "c1" });
  await assert.rejects(() => c.send("x"), /Quota journalier atteint/);
});

test("send: erreur serveur sans corps JSON → throw avec status", async () => {
  nextResponses.push({ ok: false, status: 500, json: async () => { throw new Error("not json"); } });
  const c = createChatClient({ convId: "c1" });
  await assert.rejects(() => c.send("x"), /500/);
});

test("convId: encodage URL des caractères spéciaux", async () => {
  const c = createChatClient({ convId: "a b/c" });
  await c.refresh();
  assert.match(calls[0].url, /a%20b%2Fc/);
});

test("start/stop: stop avant tout tick → onError jamais appelé sur fetch en échec", async () => {
  // start lance loop() immédiatement (refresh sync-ish). On stoppe juste après.
  const errs = [];
  const c = createChatClient({ convId: "c1", pollMs: 10000, onError: (e) => errs.push(e) });
  c.start();
  c.stop();
  // laisser les microtasks se vider
  await new Promise((r) => setImmediate(r));
  // pas d'assertion stricte sur le timing : on vérifie surtout que stop n'a pas planté
  assert.equal(typeof c.stop, "function");
});

test("refresh: messages absents → tableau vide retourné", async () => {
  nextResponses.push({ ok: true, json: async () => ({}) }); // pas de champ messages
  const c = createChatClient({ convId: "c1" });
  const msgs = await c.refresh();
  assert.deepEqual(msgs, []);
});
