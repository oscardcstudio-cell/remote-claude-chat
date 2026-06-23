/**
 * memoryStore — implémentation Store en mémoire (tests, dev local).
 * Non persistant. Ne pas utiliser en prod (Railway redéploie → tout perdu).
 */
let SEQ = 0;
const uid = () => `mem-${Date.now()}-${++SEQ}`;

export function createMemoryStore({ tokens = [] } = {}) {
  const messages = [];                       // { id, projectId, convId, accessTokenId, role, content, status, error, costUsd, createdAt }
  const tokenRows = tokens.map((t) => ({ disabled: false, dailyCap: null, label: null, ...t, id: t.id || uid() }));
  const events = [];

  return {
    async resolveAccessToken(token) {
      const t = tokenRows.find((r) => r.token === token);
      return t ? { id: t.id, projectId: t.projectId, disabled: !!t.disabled, dailyCap: t.dailyCap ?? null, label: t.label ?? null, allowList: Array.isArray(t.allowList) ? t.allowList.map(String) : null } : null;
    },

    async countTodayByToken(accessTokenId) {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      return messages.filter((m) => m.accessTokenId === accessTokenId && m.role === "user" && m.createdAt >= start).length;
    },

    async enqueueUserMessage({ projectId, convId, accessTokenId, content }) {
      const row = { id: uid(), projectId, convId, accessTokenId, role: "user", content, status: "queued", error: null, costUsd: null, createdAt: new Date() };
      messages.push(row);
      return row;
    },

    async listConversation({ projectId, convId }) {
      return messages
        .filter((m) => m.projectId === projectId && m.convId === convId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async pollNext({ projectIds }) {
      const set = new Set(projectIds);
      const msg = messages
        .filter((m) => m.role === "user" && m.status === "queued" && set.has(m.projectId))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!msg) return null;
      msg.status = "delivered";
      msg.deliveredAt = Date.now();
      return { id: msg.id, projectId: msg.projectId, convId: msg.convId, content: msg.content };
    },

    // Re-queue les messages "delivered" depuis trop longtemps (worker mort / reply réseau échoué).
    async requeueStale({ olderThanMs = 5 * 60 * 1000 } = {}) {
      const cutoff = Date.now() - olderThanMs;
      let n = 0;
      for (const m of messages) {
        if (m.role === "user" && m.status === "delivered" && m.deliveredAt && m.deliveredAt < cutoff) {
          m.status = "queued"; m.deliveredAt = null; n++;
        }
      }
      return n;
    },

    async reply({ id, projectId, convId, reply, error, costUsd }) {
      const orig = messages.find((m) => m.id === id);
      if (!orig) return; // id inconnu → ne pas insérer un message assistant orphelin (statut incohérent)
      orig.status = error ? "error" : "done"; if (error) orig.error = String(error); if (costUsd != null) orig.costUsd = costUsd;
      messages.push({
        id: uid(), projectId: projectId ?? orig.projectId, convId, accessTokenId: null, role: "assistant",
        content: error ? `⚠ Erreur d'exécution : ${String(error)}` : (reply ?? "").toString(),
        status: "done", error: null, costUsd: costUsd ?? null, createdAt: new Date(),
      });
    },

    async audit({ projectId, convId, action, detail }) {
      events.push({ id: uid(), projectId, convId, action, detail, createdAt: new Date() });
    },

    // exposés pour les tests
    _messages: messages,
    _events: events,
  };
}
