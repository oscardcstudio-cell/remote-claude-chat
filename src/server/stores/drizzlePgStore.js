/**
 * drizzlePgStore — implémentation Store sur Drizzle ORM (Postgres). Défaut prod (Railway/Supabase).
 *
 * Le relais reste SEUL writer DB. Atomicité du poll garantie via UPDATE ... FOR UPDATE SKIP LOCKED
 * (deux poll concurrents — ou deux workers — ne prennent jamais le même message).
 *
 * @param {Object} opts
 * @param {import('drizzle-orm').Database} opts.db   instance Drizzle (node-postgres / postgres-js)
 * @param {object} [opts.tables]  { messages, tokens, events } — défaut : tables du package (schema.js)
 * @param {object} [opts.tableNames]  noms SQL bruts pour le poll atomique
 *                 (défaut { messages:'remote_chat_messages' }). À surcharger si vous mappez sur vos propres tables.
 */
import { sql, eq, and, asc, gte } from "drizzle-orm";
import { remoteChatMessages, remoteChatTokens, remoteChatEvents } from "../../schema/schema.js";

export function createDrizzlePgStore({ db, tables, tableNames } = {}) {
  if (!db) throw new Error("createDrizzlePgStore: `db` (instance Drizzle) requis.");
  const T = { messages: remoteChatMessages, tokens: remoteChatTokens, events: remoteChatEvents, ...(tables || {}) };
  const N = { messages: "remote_chat_messages", ...(tableNames || {}) };
  const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

  return {
    async resolveAccessToken(token) {
      const [t] = await db.select().from(T.tokens).where(eq(T.tokens.token, token)).limit(1);
      if (!t) return null;
      // touch last_used_at (best-effort, non bloquant pour l'auth)
      db.update(T.tokens).set({ lastUsedAt: new Date() }).where(eq(T.tokens.id, t.id)).catch(() => {});
      return { id: t.id, projectId: t.projectId, disabled: !!t.disabled, dailyCap: t.dailyCap ?? null, label: t.label ?? null };
    },

    async countTodayByToken(accessTokenId) {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const [r] = await db.select({ n: sql`count(*)::int` }).from(T.messages)
        .where(and(eq(T.messages.accessTokenId, accessTokenId), eq(T.messages.role, "user"), gte(T.messages.createdAt, start)));
      return Number(r?.n ?? 0);
    },

    async enqueueUserMessage({ projectId, convId, accessTokenId, content }) {
      const [row] = await db.insert(T.messages)
        .values({ projectId, convId, accessTokenId, role: "user", content, status: "queued" })
        .returning();
      return row;
    },

    async listConversation({ projectId, convId }) {
      return db.select().from(T.messages)
        .where(and(eq(T.messages.projectId, projectId), eq(T.messages.convId, convId)))
        .orderBy(asc(T.messages.createdAt));
    },

    async pollNext({ projectIds }) {
      // Atomique : verrouille la + ancienne ligne queued parmi les projets, passe delivered, renvoie l'essentiel.
      const ids = sql.join(projectIds.map((p) => sql`${p}`), sql`, `);
      const res = await db.execute(sql`
        UPDATE ${sql.identifier(N.messages)} m
           SET status = 'delivered'
         WHERE m.id = (
           SELECT id FROM ${sql.identifier(N.messages)}
            WHERE role = 'user' AND status = 'queued' AND project_id IN (${ids})
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
        RETURNING m.id, m.project_id AS "projectId", m.conv_id AS "convId", m.content
      `);
      const [msg] = rowsOf(res);
      return msg || null;
    },

    async reply({ id, projectId, convId, reply, error, costUsd }) {
      if (error) {
        await db.update(T.messages).set({ status: "error", error: String(error), costUsd: costUsd ?? null }).where(eq(T.messages.id, id));
      } else {
        await db.update(T.messages).set({ status: "done", costUsd: costUsd ?? null }).where(eq(T.messages.id, id));
      }
      await db.insert(T.messages).values({
        projectId, convId, role: "assistant",
        content: error ? `⚠ Erreur d'exécution : ${String(error)}` : (reply ?? "").toString(),
        status: "done", costUsd: costUsd ?? null,
      });
    },

    async audit({ projectId, convId, action, detail }) {
      await db.insert(T.events).values({ projectId, convId, action, detail });
    },
  };
}
