/**
 * smoke.mjs — vérifie le contrat Store sur l'implémentation mémoire (zéro dépendance).
 * Couvre le cycle de vie complet : token → enqueue → poll (queued→delivered) → reply → list,
 * + scope projet, + comptage pour le cap. `npm test`.
 */
import assert from "node:assert";
import { createMemoryStore } from "../src/server/stores/memoryStore.js";

let ok = 0;
const t = async (name, fn) => { await fn(); ok++; console.log(`  ✓ ${name}`); };

const store = createMemoryStore({
  tokens: [
    { token: "tok-julia", projectId: "mecene", label: "julia", dailyCap: 2 },
    { token: "tok-marc", projectId: "autreprojet", label: "marc" },
  ],
});

await t("resolve token → projet scopé", async () => {
  const d = await store.resolveAccessToken("tok-julia");
  assert.equal(d.projectId, "mecene");
  assert.equal(d.dailyCap, 2);
  assert.equal(await store.resolveAccessToken("inconnu"), null);
});

await t("enqueue → poll passe queued à delivered", async () => {
  const julia = await store.resolveAccessToken("tok-julia");
  const m = await store.enqueueUserMessage({ projectId: "mecene", convId: "c1", accessTokenId: julia.id, content: "salut" });
  assert.equal(m.status, "queued");
  const polled = await store.pollNext({ projectIds: ["mecene"] });
  assert.equal(polled.id, m.id);
  assert.equal(polled.content, "salut");
  // re-poll : plus rien (passé delivered)
  assert.equal(await store.pollNext({ projectIds: ["mecene"] }), null);
});

await t("poll filtre par projet (worker n'héberge que ses repos)", async () => {
  const marc = await store.resolveAccessToken("tok-marc");
  await store.enqueueUserMessage({ projectId: "autreprojet", convId: "x1", accessTokenId: marc.id, content: "hello" });
  // un worker qui n'héberge que mecene ne voit pas autreprojet
  assert.equal(await store.pollNext({ projectIds: ["mecene"] }), null);
  const got = await store.pollNext({ projectIds: ["autreprojet"] });
  assert.equal(got.convId, "x1");
});

await t("reply → done + bulle assistant + scope de conversation", async () => {
  const julia = await store.resolveAccessToken("tok-julia");
  const m = await store.enqueueUserMessage({ projectId: "mecene", convId: "c1", accessTokenId: julia.id, content: "ça va ?" });
  await store.pollNext({ projectIds: ["mecene"] });
  await store.reply({ id: m.id, projectId: "mecene", convId: "c1", reply: "oui", costUsd: 0.01 });
  const conv = await store.listConversation({ projectId: "mecene", convId: "c1" });
  const roles = conv.map((x) => x.role);
  assert.ok(roles.includes("assistant"));
  assert.equal(conv[conv.length - 1].content, "oui");
  // un autre projet ne lit pas cette conv
  assert.equal((await store.listConversation({ projectId: "autreprojet", convId: "c1" })).length, 0);
});

await t("reply error → bulle d'erreur", async () => {
  const julia = await store.resolveAccessToken("tok-julia");
  const m = await store.enqueueUserMessage({ projectId: "mecene", convId: "c2", accessTokenId: julia.id, content: "boom" });
  await store.pollNext({ projectIds: ["mecene"] });
  await store.reply({ id: m.id, projectId: "mecene", convId: "c2", error: "exit 1" });
  const conv = await store.listConversation({ projectId: "mecene", convId: "c2" });
  assert.ok(conv.some((x) => x.role === "assistant" && x.content.includes("Erreur")));
  assert.equal(conv.find((x) => x.id === m.id).status, "error");
});

await t("countTodayByToken alimente le cap", async () => {
  const julia = await store.resolveAccessToken("tok-julia");
  const n = await store.countTodayByToken(julia.id);
  assert.ok(n >= 3, `attendu >=3 messages today, eu ${n}`);
});

await t("allowList opt-in : token '*' expose sa liste, legacy → null (rétro-compat)", async () => {
  const s = createMemoryStore({ tokens: [
    { token: "tok-star", projectId: "*", allowList: ["mecene", "autre"] },
    { token: "tok-open", projectId: "*" },
  ] });
  const star = await s.resolveAccessToken("tok-star");
  assert.deepEqual(star.allowList, ["mecene", "autre"]);
  const open = await s.resolveAccessToken("tok-open");
  assert.equal(open.allowList, null); // absente → tous projets permis (comportement legacy)
});

await t("requeueStale : delivered trop vieux → re-queued (anti réponse avalée)", async () => {
  const s = createMemoryStore({ tokens: [{ token: "tk", projectId: "p" }] });
  const tk = await s.resolveAccessToken("tk");
  const m = await s.enqueueUserMessage({ projectId: "p", convId: "c", accessTokenId: tk.id, content: "x" });
  await s.pollNext({ projectIds: ["p"] });                       // → delivered
  assert.equal(await s.pollNext({ projectIds: ["p"] }), null);   // plus rien à servir
  s._messages.find((r) => r.id === m.id).deliveredAt = 1;        // simule un worker mort (prise très ancienne)
  assert.equal(await s.requeueStale({ olderThanMs: 1000 }), 1);
  const again = await s.pollNext({ projectIds: ["p"] });         // redevenu servable
  assert.equal(again.id, m.id);
});

console.log(`\n${ok} tests OK`);
