/**
 * memoryStore.test.mjs — couverture directe du contrat Store (impl mémoire).
 *
 * Complète smoke.mjs : on cible ici les branches/edges que le smoke n'exerce pas
 * (token désactivé, reply id inconnu, fallback projectId dans reply, FIFO du poll,
 * scope strict de listConversation, comptage par token, allowList non-string).
 * Aucun I/O : 100% mémoire, déterministe (on n'assert jamais sur Date.now/uid exacts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../src/server/stores/memoryStore.js";

test("createMemoryStore: sans tokens → store vide opérationnel", async () => {
  const s = createMemoryStore();
  assert.equal(await s.resolveAccessToken("rien"), null);
  assert.deepEqual(await s.listConversation({ projectId: "p", convId: "c" }), []);
  assert.equal(await s.pollNext({ projectIds: ["p"] }), null);
});

test("resolveAccessToken: descripteur complet + défauts (disabled false, dailyCap null)", async () => {
  const s = createMemoryStore({ tokens: [{ token: "t", projectId: "p", label: "lbl" }] });
  const d = await s.resolveAccessToken("t");
  assert.equal(d.projectId, "p");
  assert.equal(d.disabled, false);
  assert.equal(d.dailyCap, null);
  assert.equal(d.label, "lbl");
  assert.ok(d.id, "un id est attribué");
});

test("resolveAccessToken: disabled:true exposé tel quel", async () => {
  const s = createMemoryStore({ tokens: [{ token: "t", projectId: "p", disabled: true }] });
  const d = await s.resolveAccessToken("t");
  assert.equal(d.disabled, true);
});

test("resolveAccessToken: allowList non-array → null (normalisation)", async () => {
  const s = createMemoryStore({ tokens: [{ token: "t", projectId: "*", allowList: "pasunarray" }] });
  const d = await s.resolveAccessToken("t");
  assert.equal(d.allowList, null);
});

test("resolveAccessToken: allowList array → strings", async () => {
  const s = createMemoryStore({ tokens: [{ token: "t", projectId: "*", allowList: [1, "deux"] }] });
  const d = await s.resolveAccessToken("t");
  assert.deepEqual(d.allowList, ["1", "deux"]);
});

test("enqueueUserMessage: status queued, role user, champs initiaux", async () => {
  const s = createMemoryStore();
  const m = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "tk", content: "hi" });
  assert.equal(m.status, "queued");
  assert.equal(m.role, "user");
  assert.equal(m.content, "hi");
  assert.equal(m.error, null);
  assert.equal(m.costUsd, null);
  assert.ok(m.createdAt instanceof Date);
});

test("pollNext: FIFO (le plus ancien queued d'abord)", async () => {
  const s = createMemoryStore();
  const a = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "tk", content: "1" });
  const b = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "tk", content: "2" });
  // force un ordre temporel déterministe sans dépendre de la résolution d'horloge
  a.createdAt = new Date(1000);
  b.createdAt = new Date(2000);
  assert.equal((await s.pollNext({ projectIds: ["p"] })).id, a.id);
  assert.equal((await s.pollNext({ projectIds: ["p"] })).id, b.id);
  assert.equal(await s.pollNext({ projectIds: ["p"] }), null);
});

test("pollNext: passe queued → delivered (atomique, pas re-servi)", async () => {
  const s = createMemoryStore();
  const m = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "tk", content: "x" });
  await s.pollNext({ projectIds: ["p"] });
  assert.equal(s._messages.find((r) => r.id === m.id).status, "delivered");
  assert.equal(await s.pollNext({ projectIds: ["p"] }), null);
});

test("pollNext: filtre par projectIds (jamais un projet hors liste)", async () => {
  const s = createMemoryStore();
  await s.enqueueUserMessage({ projectId: "p2", convId: "c", accessTokenId: "tk", content: "x" });
  assert.equal(await s.pollNext({ projectIds: ["p1"] }), null);
  assert.equal((await s.pollNext({ projectIds: ["p1", "p2"] })).projectId, "p2");
});

test("reply: id inconnu → no-op (pas de bulle assistant orpheline)", async () => {
  const s = createMemoryStore();
  await s.reply({ id: "fantome", convId: "c", reply: "salut" });
  assert.equal(s._messages.length, 0, "rien inséré pour un id inconnu");
});

test("reply ok: passe done + insère bulle assistant avec le reply", async () => {
  const s = createMemoryStore();
  const m = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "tk", content: "q" });
  await s.pollNext({ projectIds: ["p"] });
  await s.reply({ id: m.id, projectId: "p", convId: "c", reply: "r", costUsd: 0.5 });
  const orig = s._messages.find((x) => x.id === m.id);
  assert.equal(orig.status, "done");
  assert.equal(orig.costUsd, 0.5);
  const asst = s._messages.find((x) => x.role === "assistant");
  assert.equal(asst.content, "r");
  assert.equal(asst.costUsd, 0.5);
});

test("reply error: passe error + bulle d'erreur formatée", async () => {
  const s = createMemoryStore();
  const m = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "tk", content: "q" });
  await s.reply({ id: m.id, projectId: "p", convId: "c", error: "exit 1" });
  const orig = s._messages.find((x) => x.id === m.id);
  assert.equal(orig.status, "error");
  assert.equal(orig.error, "exit 1");
  const asst = s._messages.find((x) => x.role === "assistant");
  assert.match(asst.content, /Erreur d'exécution.*exit 1/);
});

test("reply: projectId omis → fallback sur celui du message original", async () => {
  const s = createMemoryStore();
  const m = await s.enqueueUserMessage({ projectId: "monproj", convId: "c", accessTokenId: "tk", content: "q" });
  await s.reply({ id: m.id, convId: "c", reply: "r" }); // pas de projectId
  const asst = s._messages.find((x) => x.role === "assistant");
  assert.equal(asst.projectId, "monproj");
});

test("reply: reply null/undefined → bulle assistant vide (pas de crash)", async () => {
  const s = createMemoryStore();
  const m = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "tk", content: "q" });
  await s.reply({ id: m.id, projectId: "p", convId: "c" }); // ni reply ni error
  const asst = s._messages.find((x) => x.role === "assistant");
  assert.equal(asst.content, "");
  assert.equal(s._messages.find((x) => x.id === m.id).status, "done");
});

test("listConversation: scope strict projet+conv + ordre chronologique", async () => {
  const s = createMemoryStore();
  const a = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "tk", content: "a" });
  const b = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "tk", content: "b" });
  await s.enqueueUserMessage({ projectId: "p", convId: "autre", accessTokenId: "tk", content: "z" });
  await s.enqueueUserMessage({ projectId: "autreproj", convId: "c", accessTokenId: "tk", content: "y" });
  a.createdAt = new Date(1000); b.createdAt = new Date(2000);
  const conv = await s.listConversation({ projectId: "p", convId: "c" });
  assert.deepEqual(conv.map((m) => m.content), ["a", "b"]); // ni autre conv, ni autre projet
});

test("countTodayByToken: ne compte que les messages user du token, du jour", async () => {
  const s = createMemoryStore();
  await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "A", content: "1" });
  await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "A", content: "2" });
  await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "B", content: "3" });
  assert.equal(await s.countTodayByToken("A"), 2);
  assert.equal(await s.countTodayByToken("B"), 1);
  assert.equal(await s.countTodayByToken("inconnu"), 0);
});

test("countTodayByToken: un message d'hier n'est pas compté", async () => {
  const s = createMemoryStore();
  const m = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "A", content: "vieux" });
  m.createdAt = new Date(Date.now() - 48 * 3600 * 1000); // avant-hier
  assert.equal(await s.countTodayByToken("A"), 0);
});

test("countTodayByToken: les bulles assistant ne comptent pas", async () => {
  const s = createMemoryStore();
  const m = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "A", content: "q" });
  await s.reply({ id: m.id, projectId: "p", convId: "c", reply: "r" }); // assistant a accessTokenId null
  assert.equal(await s.countTodayByToken("A"), 1); // seulement le user
});

test("requeueStale: ne re-queue que les delivered plus vieux que le seuil", async () => {
  const s = createMemoryStore();
  const m1 = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "A", content: "1" });
  const m2 = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "A", content: "2" });
  await s.pollNext({ projectIds: ["p"] }); // m1 delivered (récent)
  await s.pollNext({ projectIds: ["p"] }); // m2 delivered (récent)
  s._messages.find((r) => r.id === m1.id).deliveredAt = 1; // m1 = prise très ancienne
  const n = await s.requeueStale({ olderThanMs: 1000 });
  assert.equal(n, 1); // seul m1 re-queued
  assert.equal(s._messages.find((r) => r.id === m1.id).status, "queued");
  assert.equal(s._messages.find((r) => r.id === m2.id).status, "delivered");
});

test("requeueStale: aucun delivered stale → 0", async () => {
  const s = createMemoryStore();
  await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: "A", content: "1" });
  assert.equal(await s.requeueStale({ olderThanMs: 1000 }), 0); // queued, jamais delivered
});

test("audit: enregistre un event dans _events", async () => {
  const s = createMemoryStore();
  await s.audit({ projectId: "p", convId: "c", action: "chat.message", detail: { id: "x" } });
  assert.equal(s._events.length, 1);
  assert.equal(s._events[0].action, "chat.message");
  assert.deepEqual(s._events[0].detail, { id: "x" });
});
