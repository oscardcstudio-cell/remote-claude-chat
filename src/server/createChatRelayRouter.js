/**
 * createChatRelayRouter — relais HTTP du chat Claude Code distant.
 *
 * Tourne sur Railway (ou tout host prod). RÔLE STRICT : relais + SEUL writer DB.
 * Ne porte JAMAIS de clé Anthropic ni d'exec — l'exécution vit sur le PC (cf. worker).
 *
 * 3 surfaces, 2 secrets distincts (jamais l'URL seule, sinon RCE publique sur le PC) :
 *   - Pote   → {apiBase}/:convId[/message]   auth = ACCESS_TOKEN (table tokens, révocable, scopé 1 projet)
 *   - Worker → {workerBase}/poll | /reply    auth = WORKER_TOKEN (1 secret partagé worker↔relais)
 *
 * STORAGE-AGNOSTIC : on n'importe aucune table. Le consumer injecte un `store` qui
 * implémente l'interface ci-dessous. Stores fournis : drizzle-pg (défaut prod), memory (tests).
 *
 * @typedef {Object} Store
 * @property {(t:string)=>Promise<{id:string,projectId:string,disabled:boolean,dailyCap:?number,label:?string}|null>} resolveAccessToken
 *           Résout un ACCESS_TOKEN → descripteur, ou null si inconnu.
 * @property {(accessTokenId:string)=>Promise<number>} countTodayByToken
 *           Nb de messages user postés aujourd'hui par ce token (pour le cap optionnel).
 * @property {(a:{projectId:string,convId:string,accessTokenId:string,content:string})=>Promise<object>} enqueueUserMessage
 *           Empile un message user (status queued). Renvoie la ligne créée.
 * @property {(a:{projectId:string,convId:string})=>Promise<object[]>} listConversation
 *           Messages d'une conversation, ordre chronologique.
 * @property {(a:{projectIds:string[]})=>Promise<{id:string,projectId:string,convId:string,content:string}|null>} pollNext
 *           Le + ancien message user `queued` PARMI ces projets → passe `delivered` (atomique). null si vide.
 * @property {(a:{id:string,projectId:string,convId:string,reply?:string,error?:string,costUsd?:number})=>Promise<void>} reply
 *           Clôt le message (done|error) + insère la réponse assistant.
 * @property {(a:{projectId?:string,convId?:string,action:string,detail?:object})=>Promise<void>} audit
 *           Trace un event. No-op autorisé si le consumer audite ailleurs.
 *
 * @param {Object} opts
 * @param {Store}  opts.store
 * @param {string} [opts.workerToken]  secret worker↔relais (sinon process.env.WORKER_TOKEN)
 * @param {boolean}[opts.devBypass]    bypass auth en dev local (défaut: NODE_ENV !== 'production')
 * @param {string} [opts.apiBase]      préfixe surface pote (défaut '/api/chat')
 * @param {string} [opts.workerBase]   préfixe surface worker (défaut '/_worker')
 * @param {number} [opts.maxReplyBytes] limite body worker reply (défaut 2 Mo)
 * @returns {import('express').Router}
 */
import express from "express";
import crypto from "node:crypto";

// Comparaison constant-time d'un secret partagé (anti timing-attack).
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function createChatRelayRouter(opts) {
  const {
    store,
    workerToken = process.env.WORKER_TOKEN,
    // Fail-closed par défaut : le bypass auth est un opt-in EXPLICITE (jamais déduit de l'absence
    // d'une var d'env comme NODE_ENV, qui n'est réglée nulle part en prod → trou fail-open).
    devBypass = process.env.RCC_DEV_BYPASS === "1",
    apiBase = "/api/chat",
    workerBase = "/_worker",
    maxReplyBytes = 2 * 1024 * 1024,
    // Redelivery : un message resté "delivered" plus longtemps que ce délai (worker mort / reply
    // réseau échoué) est re-queué au prochain poll. 0 = désactivé.
    redeliverAfterMs = 5 * 60 * 1000,
  } = opts || {};
  if (!store) throw new Error("createChatRelayRouter: `store` requis.");

  const router = express.Router();

  // ── Surface POTE : envoyer un message / lire la conversation ──────────────────
  const chat = express.Router();
  chat.use(express.json({ limit: "256kb" }));

  // Auth pote : header x-access-token → token table. Scope = le projet du token.
  // Bypass dev local. Fail-closed en prod. Attache req.rcc = { projectId, tokenId, dailyCap }.
  chat.use(async (req, res, next) => {
    try {
      if (devBypass) {
        // En dev, on autorise un header de confort pour cibler un projet sans token réel.
        req.rcc = { projectId: req.headers["x-project-id"] || "dev", tokenId: null, dailyCap: null };
        return next();
      }
      const token = req.headers["x-access-token"];
      if (!token) return res.status(401).json({ error: "Accès non autorisé." });
      const desc = await store.resolveAccessToken(String(token));
      if (!desc || desc.disabled) return res.status(401).json({ error: "Accès non autorisé." });
      // Token "personne" (project_id = "*") : autorisé sur N agents ; l'agent ciblé est dans
      // le header x-project-id (choisi dans le dashboard). Token scopé : son project_id fixe.
      let projectId = desc.projectId;
      if (projectId === "*") {
        projectId = req.headers["x-project-id"];
        if (!projectId) return res.status(400).json({ error: "x-project-id requis (agent cible)." });
        // Allow-list opt-in : un token "personne" peut restreindre les agents joignables.
        // Absente (legacy) → tous projets permis (rétro-compat). Présente → membership obligatoire.
        if (Array.isArray(desc.allowList) && desc.allowList.length && !desc.allowList.includes(String(projectId)))
          return res.status(403).json({ error: "Projet non autorisé pour ce token." });
      }
      req.rcc = { projectId: String(projectId), tokenId: desc.id, dailyCap: desc.dailyCap ?? null };
      next();
    } catch (e) {
      next(e);
    }
  });

  // Lister une conversation (scopée au projet du token → un pote ne voit que SON projet).
  chat.get("/:convId", async (req, res, next) => {
    try {
      const messages = await store.listConversation({ projectId: req.rcc.projectId, convId: req.params.convId });
      res.json({ messages });
    } catch (e) { next(e); }
  });

  // Empiler un message user → queued (le worker le prendra).
  chat.post("/:convId/message", async (req, res, next) => {
    try {
      const content = (req.body?.content ?? "").toString().trim();
      if (!content) return res.status(400).json({ error: "content requis." });
      // Cap optionnel anti-token-fuité (off si dailyCap null).
      if (req.rcc.dailyCap != null && req.rcc.tokenId) {
        const used = await store.countTodayByToken(req.rcc.tokenId);
        if (used >= req.rcc.dailyCap) {
          return res.status(429).json({ error: "Quota journalier atteint. Réessaie demain." });
        }
      }
      const row = await store.enqueueUserMessage({
        projectId: req.rcc.projectId,
        convId: req.params.convId,
        accessTokenId: req.rcc.tokenId,
        content,
      });
      await store.audit({ projectId: req.rcc.projectId, convId: req.params.convId, action: "chat.message", detail: { id: row.id } });
      res.json({ message: row });
    } catch (e) { next(e); }
  });

  router.use(apiBase, chat);

  // ── Surface WORKER (PC d'Oscar) : poll + reply ────────────────────────────────
  const worker = express.Router();
  worker.use(express.json({ limit: maxReplyBytes }));

  // Auth worker : header x-worker-token == WORKER_TOKEN. Distinct de l'ACCESS_TOKEN.
  worker.use((req, res, next) => {
    if (devBypass) return next();
    if (!workerToken) return res.status(503).json({ error: "Worker désactivé: WORKER_TOKEN manquant." });
    if (!safeEqual(req.headers["x-worker-token"], workerToken)) return res.status(401).json({ error: "Worker non autorisé." });
    next();
  });

  // Le worker déclare quels projets il héberge → relais renvoie le + ancien message queued PARMI ceux-là.
  // Railway = seul writer : queued→delivered se fait ici, le worker ne touche jamais la DB.
  worker.post("/poll", async (req, res, next) => {
    try {
      const projectIds = Array.isArray(req.body?.projects) ? req.body.projects.map(String) : [];
      if (!projectIds.length) return res.status(400).json({ error: "projects[] requis." });
      // Re-queue les messages avalés (delivered trop vieux) avant de servir le suivant.
      if (redeliverAfterMs > 0 && typeof store.requeueStale === "function") {
        try { await store.requeueStale({ olderThanMs: redeliverAfterMs }); } catch { /* best-effort */ }
      }
      const message = await store.pollNext({ projectIds });
      res.json({ message: message || null });
    } catch (e) { next(e); }
  });

  // Le worker rend la réponse de l'agent (ou une erreur d'exec) + coût réel optionnel.
  worker.post("/reply", async (req, res, next) => {
    try {
      const { id, projectId, convId, reply, error, costUsd } = req.body || {};
      if (!id || !convId) return res.status(400).json({ error: "id et convId requis." });
      await store.reply({ id, projectId, convId, reply, error, costUsd });
      await store.audit({
        projectId, convId, action: "chat.exec",
        detail: { msgId: id, ok: !error, error: error ? String(error) : undefined, costUsd: costUsd ?? undefined },
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.use(workerBase, worker);

  return router;
}
