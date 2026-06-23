# remote-claude-chat — backlog sécurité

Audit read-only (2026-06-22). **Tous les findings package sont corrigés** (2026-06-23, v0.2.2→v0.2.4).
Chaque ligne : `fichier:ligne — problème — résolution`.

## Ouvert
_(aucun finding package ouvert)_

## RÉSOLU — 2026-06-23 (v0.2.4)
- `package.json:peerDependencies` (advisory GHSA-gpj5-g38j-94v9 / CVE-2026-39356, HIGH) — `drizzle-orm >=0.30` autorisait des versions `< 0.45.2` vulnérables à une SQL injection via `escapeName()` (identifiants mal échappés dans `sql.identifier()`/`.as()`). **FIXÉ** : plancher peerDep → `drizzle-orm >=0.45.2` (force tout consommateur sur une version patchée). **Exploitabilité du store = nulle** : le seul identifiant atteignant `sql.identifier()` (`drizzlePgStore.js:55,59,74`) est `tableNames`/`N.messages` = nom de table **config-time** (défaut `remote_chat_messages`), jamais une entrée runtime ; tout ce qui est user-contrôlé (`projectId`, `convId`, `content`, `token`) passe en **paramètre lié** (`eq()`, `sql\`${p}\``, `.values()`). L'advisory exclut explicitement les apps « using only static schema objects ». Bump = défense en profondeur + plancher de contrat. **Code package inchangé** : schema + store + SQL bruts (`sql.identifier`/`sql.join`) testés OK sous 0.45.2 (forme objet du callback index l.25/40/51 survit). ⚠ Le fix EFFECTIF (version installée) est côté **consommateur** (dep directe `drizzle-orm`) — un plancher peer ne déplace pas un `0.36.x` déjà épinglé.

## RÉSOLU — 2026-06-23 (v0.2.3)
- `src/server/createChatRelayRouter.js:45` (CRITIQUE) — `devBypass = NODE_ENV !== "production"` : **fail-open** (NODE_ENV réglé nulle part en prod → auth bypassée si défaut utilisé). **FIXÉ** : défaut `devBypass = RCC_DEV_BYPASS === "1"` (opt-in EXPLICITE, jamais déduit). Vérifié : le relais déployé (`intellectual-source-app`) passe `devBypass: false` en dur + `WORKER_TOKEN`/`RCC_TOKENS`/`DATABASE_URL` set en prod → jamais exploité. Fix = bon défaut pour futurs consommateurs.
- `src/server/createChatRelayRouter.js:84` (HIGH) — token-personne (`project_id="*"`) acceptait n'importe quel `x-project-id`. **FIXÉ** : `allowList` opt-in sur le token — si présente, `x-project-id ∈ allowList` obligatoire (403 sinon) ; absente = tous projets permis (rétro-compat). Câblé memory + drizzle-pg (colonne `allow_list` jsonb) + relais.
- `src/worker/worker.js:102` (MED) — `--resume <sessionId>` lu depuis `.rcc-sessions.json` (altérable) ré-interprété par le shell → injection. **FIXÉ** : validation stricte `^[A-Za-z0-9_-]+$` du sessionId avant de l'ajouter aux args (sinon ignoré + log). `shell:true` **conservé** (requis pour exécuter `claude.cmd` sur Windows ; `spawn shell:false` sur un `.cmd` casse l'exec). Le `content` passe par stdin (jamais en arg) → non injectable. Seul `sessionId` était le vecteur, fermé.
- `src/worker/worker.js:114` (MED) — message resté `delivered` pour toujours si le worker meurt / le reply réseau échoue → réponse avalée. **FIXÉ** : `store.requeueStale({olderThanMs})` re-queue les `delivered` trop vieux ; appelé au `/poll` du relais (option `redeliverAfterMs`, défaut 5 min). Câblé memory (timestamp `deliveredAt`) + drizzle-pg (colonne `delivered_at` + index).
- `src/worker/cli.js:45` (LOW) — SIGINT forçait `process.exit(0)` après 100ms → child claude orphelin / worktree sale. **FIXÉ** : `worker.stop()` puis attente de `busyCount === 0` (garde 20s) avant exit ; 2e Ctrl-C = exit forcé.
- `src/server/createChatRelayRouter.js:126` (MED) — `WORKER_TOKEN` comparé `!==` non constant-time → timing attack. **FIXÉ** : `safeEqual()` (`crypto.timingSafeEqual` + check longueur).
- `src/client/mountChatTab.js:84` (MED) — `brand.logo` non échappé dans `src=` → XSS/attr-breakout. **FIXÉ** : `escapeHtml()`.
- `src/worker/worker.js:134` (LOW) — `runOne(...).catch()` ne notifiait pas le relais si exec throw → message `delivered` sans reply. **FIXÉ** : `POST /_worker/reply {error}` dans le `.catch`.
- `src/server/stores/memoryStore.js:47` (LOW) — `reply()` insérait un assistant orphelin si id inconnu. **FIXÉ** : early-return si `!orig`.
- `src/worker/confined-settings.json` (HIGH) — username `oscar` hardcodé → faux-vert sécu pour tout autre user. **FIXÉ v0.2.1** : templating `{{HOME}}` runtime (`os.homedir()`).

## ⚠ DÉPLOIEMENT — état
- ✅ **Package publié** : `github:oscardcstudio-cell/remote-claude-chat#v0.2.3` (tag live, 2026-06-23). N'importe quel consommateur peut s'y épingler.
- ⏸ **Bump consommateur `Intellectual_Source/console` — À FAIRE PAR OSCAR.** Bloqué cette session : `console/server.mjs` a du WIP non-committé (sans rapport) + le repo n'a pas de remote git (deploy = `railway up` manuel → shipperait le working tree). Quand le WIP est prêt :
  1. `cd Intellectual_Source/console && npm install "github:oscardcstudio-cell/remote-claude-chat#v0.2.3"` (⚠ forcer le tag explicite, sinon le lock garde l'ancien SHA — vérifier la ligne `resolved`). Mettre `package.json` dep → `#v0.2.3`.
  2. `migration.sql` est rejoué **automatiquement au boot** (`db.mjs:23`) — rien à faire manuellement sur la DB (colonnes additives idempotentes).
  3. Déployer (`railway up`) → vérifier Railway `intellectual-source-app` **SUCCESS** + `/healthz` 200.
  4. (opt) Activer la restriction allowList : ajouter `allowList: [...]` au token `*` dans `RCC_TOKENS`. Sans ça, comportement legacy (tous projets).

## ⚠ HORS PÉRIMÈTRE PACKAGE — code consommateur à durcir (repo Intellectual_Source, pas ce package)
- `Intellectual_Source/console/server.mjs:15` — `WORKER_TOKEN = process.env.WORKER_TOKEN || "local-worker-secret"` : fallback vers un secret PUBLIC connu si l'env est absent → worker-auth bypassable. **Railway prod a la var set (vérifié 2026-06-23)** donc pas exploité, mais le fallback est un fail-open latent. Fix conseillé : fail-closed (exit si absent en prod).
- `Intellectual_Source/console/server.mjs:21` — `TOKENS` fallback `"achraf-local-token"` wildcard si `RCC_TOKENS` absent : même risque (access-token public connu). `RCC_TOKENS` set en prod (vérifié).
- `Intellectual_Source/console/server.mjs:49` — auth hub `/_hub/agents` en `!==` non constant-time (cosmétique, même classe que le fix package).
