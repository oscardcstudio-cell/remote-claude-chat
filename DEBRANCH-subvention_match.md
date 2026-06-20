# Débranchement subvention_match (brique D) → consumer de `remote-claude-chat`

But : la brique D devient un **consumer du package**, pas une copie. Interdiction de vendoriser
(règle d'or meta). Tant que la bascule n'est pas finie, inscrire la copie actuelle dans `VENDORED.md`
de subvention_match comme **dette transitoire** (pas un état béni).

## État actuel (la copie à éliminer)

| Pièce proto | Fichier | Devient |
|---|---|---|
| Relais | `server/modules/julia-chat.ts` | `createChatRelayRouter` + store |
| Worker | `tools/julia-worker/index.mjs` | `rcc-worker` + `projects.json` (entrée `mecene`) |
| Table | `julia_chat_messages` (sans `project_id`/`access_token_id`) | `remote_chat_messages` |
| Auth pote | `JULIA_TOKEN` unique (cookie `mc_julia`) | 1 ligne `remote_chat_tokens` (label `julia`) |
| Audit | `julia_events` action `chat.exec` | `remote_chat_events` **ou** store custom qui réécrit vers `julia_events` |
| UI | onglet vanilla `dashboards/julia.html` | `mountChatTab` (même rendu, logique packagée) |

## Étapes

1. **Dépendre du package** (jamais copier) :
   ```bash
   npm i github:oscardcstudio-cell/remote-claude-chat#v0.1.0
   ```
2. **Schéma** : jouer `migration.sql` sur la DB Supabase (idempotent). Crée les 3 tables `remote_chat_*`.
   `julia_chat_messages` reste en place (historique) — pas de DROP (règle server/CLAUDE.md).
3. **Token Julia** : insérer 1 ligne `remote_chat_tokens (token = <valeur JULIA_TOKEN>, project_id = 'mecene', label = 'julia')`.
   La page `/julia` injecte ce token en header `x-access-token` côté `mountChatTab` (au lieu du cookie `mc_julia` pour le chat).
4. **Relais** : remplacer le corps de `server/modules/julia-chat.ts` par :
   ```ts
   import { createChatRelayRouter } from "remote-claude-chat/server";
   import { createDrizzlePgStore } from "remote-claude-chat/server/stores/drizzle-pg";
   export function registerJuliaChatRoutes(app) {
     app.use(createChatRelayRouter({ store: createDrizzlePgStore({ db }), workerToken: process.env.WORKER_TOKEN }));
   }
   ```
   → audit unifié dans `julia_events` ? fournir un store custom qui délègue à `createDrizzlePgStore`
   mais surcharge `audit()` pour insérer dans `juliaEvents` (`caseId:'chat', action:'chat.exec'`). Sinon `remote_chat_events` suffit.
5. **Worker** : supprimer `tools/julia-worker/`, créer `projects.json` (PC) avec l'entrée `mecene` →
   `repo = subvention_match`, `branch = rcc/chat` (ou réutiliser `julia/chat` existant via `branch`/`worktree`). Lancer `npx rcc-worker`.
   Remplacer le script npm `julia:worker` par un wrapper `rcc-worker` (ou doc).
6. **UI** : remplacer la boucle polling maison de `dashboards/julia.html` par `mountChatTab(el, { projectId:'mecene', accessToken, apiBase:'/api/chat', brand })`.
7. **Vérif E2E** sur `:5001` (relais) + worker réel sur le PC, puis **retirer la ligne dette** de `VENDORED.md`.

## Garde-fou

- Pendant la transition : `VENDORED.md` (subvention_match) liste `julia-chat.ts` + `tools/julia-worker/` comme dette → débrancher.
- Convs en cours dans `julia_chat_messages` : soit migrer les lignes (`INSERT ... SELECT` en ajoutant `project_id='mecene'`),
  soit repartir d'une conv neuve (les sessions CLI `--resume` sont keyées `mecene:<convId>` côté worker — un nouveau `convId` = nouvelle session, acceptable).
- `JULIA_TOKEN`/`WORKER_TOKEN` Railway inchangés (le package lit `WORKER_TOKEN` ; le token Julia devient une **ligne DB**, plus une var).

## Hors-scope de ce package (reste dans subvention_match)

Tout ce qui n'est pas le chat : `julia_cases`, `julia_pieces`, `julia_dossiers`, `julia_org_runs`, `julia_retours`,
le gate humain, le drain retours. Le package ne porte **que** la brique chat distant.
