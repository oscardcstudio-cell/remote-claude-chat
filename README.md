# remote-claude-chat

Chat **Claude Code distant**, brandable, multi-projet. Un pote ouvre une URL (`mecene.io/julia`,
`autreprojet.app/chat`…), tape un message, un agent Claude Code spécialisé sur **ce repo** répond.
**Ton PC reste le seul host d'exécution** (CLI claude loggé à ton abonnement + repo) ; la prod ne
porte jamais ni clé ni exec.

Généralisé depuis la brique D de `subvention_match` (station Julia).

```
Pote (URL publique)  →  Relais (Railway, seul writer DB)  ←poll—  Worker (TON PC)  →  claude CLI (worktree dédié)
     ACCESS_TOKEN              WORKER_TOKEN
```

## Pourquoi cette archi

- **PC derrière NAT** → aucun port ouvrable. Le PC **initie** toujours (poll sortant ~2s). Pas de WebSocket.
- **Prod = relais pur** : queue de messages en DB, jamais d'exec ni de `ANTHROPIC_API_KEY` → zéro RCE côté Railway.
- **2 secrets distincts** (jamais l'URL seule, sinon RCE publique sur ton PC) :
  - `WORKER_TOKEN` — worker ↔ relais (1 secret partagé).
  - `ACCESS_TOKEN` — 1 pote = 1 token, **scopé à 1 projet**, **révocable**, en table `remote_chat_tokens`.
- **Exec = CLI abonnement**, pas de clé API. Capacités illimitées (push/rm/git reset) ; les garde-fous
  sont sur le **canal** (2 tokens) et l'**audit** (chaque exec → `remote_chat_events` action `chat.exec`).
- **Worktree dédié par projet** (`rcc/chat`) → jamais d'écriture directe sur ta branche de travail.

## Modèle multi-projet / multi-pote

| Concept | Vit où | Clé |
|---|---|---|
| **Projet** | `projects.json` sur le PC (jamais en prod) | `id` → repo + worktree |
| **Token d'accès** | table `remote_chat_tokens` (Railway) | `token` → `project_id` (scope) |
| **Conversation** | table `remote_chat_messages` | `(project_id, conv_id)` ; `conv_id` = une session `claude --resume` |

- **1 worker, N projets.** Concurrence **parallèle entre projets**, **sérialisée dans un projet**
  (un projet en cours d'exec sort de la liste de poll → ses messages suivants font la file). Choix figé
  (Oscar 2026-06-20) : robustesse > parallélisme intra-projet.
- **Un pote ne voit que SON projet** : le relais scope chaque lecture au `project_id` du token.

## Installation (jamais de copie — dépendance versionnée)

```bash
# en dépendance versionnée (Docker/Railway ET clone-seul)
npm i github:oscardcstudio-cell/remote-claude-chat#v0.1.0
# ou en local (monorepo de packages)
npm i file:../../packages/remote-claude-chat
```

Peer deps optionnelles selon ce que tu importes : `express` (relais), `drizzle-orm` (store pg), `react` (widget React).

---

## Brancher sur un nouveau projet en 15 min

### 1. DB (une fois) — jouer la migration côté Railway/Supabase

```bash
psql "$DATABASE_URL" -f node_modules/remote-claude-chat/src/schema/migration.sql
```

Crée `remote_chat_messages`, `remote_chat_tokens`, `remote_chat_events` (idempotent, rejouable, jamais de DROP).

### 2. Relais — monter le router dans ton serveur Express (prod)

```js
import express from "express";
import { db } from "./db.js";                                   // ton instance Drizzle
import { createChatRelayRouter } from "remote-claude-chat/server";
import { createDrizzlePgStore } from "remote-claude-chat/server/stores/drizzle-pg";

const app = express();
app.use(createChatRelayRouter({
  store: createDrizzlePgStore({ db }),
  workerToken: process.env.WORKER_TOKEN,                        // poser cette var sur Railway
}));
// expose POST/GET /api/chat/:convId[/message]  (pote)  +  POST /_worker/poll|reply  (worker)
```

> Déjà tes propres tables (ex `julia_chat_messages`) ? Passe-les via `createDrizzlePgStore({ db, tables, tableNames })`
> ou écris ton propre `store` (6 méthodes, cf. l'interface `Store` dans `createChatRelayRouter.js`).

### 3. Créer un token pour le pote (révocable)

```sql
INSERT INTO remote_chat_tokens (token, project_id, label, daily_cap)
VALUES ('<secret-long-aléatoire>', 'mecene', 'julia', NULL);   -- daily_cap NULL = illimité
-- révoquer : UPDATE remote_chat_tokens SET disabled = true WHERE label = 'julia';
```

### 4. Poser l'onglet chat (front)

Vanilla (n'importe quelle page, dashboard server-rendered inclus) :

```html
<div id="chat" style="height:480px"></div>
<script type="module">
  import { mountChatTab } from "remote-claude-chat/client";
  mountChatTab(document.getElementById("chat"), {
    projectId: "mecene",
    accessToken: "<ACCESS_TOKEN du pote>",                      // injecté par ta page protégée
    apiBase: "/api/chat",
    brand: { projectName: "Julia · Mecene", accent: "#1f6feb", logo: "/logo.svg" },
  });
</script>
```

React :

```jsx
import { ChatTab } from "remote-claude-chat/client/react";
<ChatTab projectId="mecene" accessToken={token} apiBase="/api/chat"
         brand={{ projectName: "Julia · Mecene", accent: "#1f6feb" }} />
```

### 5. Lancer le worker multi-projet sur ton PC

`projects.json` :

```json
{
  "projects": [
    { "id": "mecene", "repo": "C:/dev/claude/oscardcstudio/subvention_match", "branch": "rcc/chat" },
    { "id": "autreprojet", "repo": "C:/dev/claude/oscardcstudio/autre-repo" }
  ]
}
```

```bash
RELAY_URL=https://mecene.io \
WORKER_TOKEN=<même secret que côté relais> \
RCC_PROJECTS=./projects.json \
npx rcc-worker
# PowerShell : $env:RELAY_URL="https://mecene.io"; $env:WORKER_TOKEN="…"; npx rcc-worker
```

Au 1er lancement, le worker crée un worktree dédié par projet (défaut `<repo>-rcc-chat`, branche `rcc/chat`).
**PC allumé** pendant que les potes bossent. `worktree` et `branch` sont surchargeables par projet.

---

## Exports

| Export | Rôle |
|---|---|
| `remote-claude-chat/server` | `createChatRelayRouter({ store, workerToken })` → Express Router (relais) |
| `remote-claude-chat/server/stores/drizzle-pg` | `createDrizzlePgStore({ db })` (défaut prod) |
| `remote-claude-chat/server/stores/memory` | `createMemoryStore({ tokens })` (tests) |
| `remote-claude-chat/schema` | tables Drizzle (`remoteChatMessages`, `remoteChatTokens`, `remoteChatEvents`) |
| `remote-claude-chat/schema/sql` | `migration.sql` (source de vérité du schéma) |
| `remote-claude-chat/worker` | `createWorker(...)` (programmable) |
| `rcc-worker` (bin) | worker CLI multi-projet |
| `remote-claude-chat/client` | `mountChatTab(el, opts)` (vanilla, zéro dépendance) |
| `remote-claude-chat/client/react` | `<ChatTab/>` (React) |

## Variables d'environnement

| Côté | Var | Requis | Défaut | Rôle |
|---|---|---|---|---|
| Relais | `WORKER_TOKEN` | oui (prod) | — | auth worker↔relais |
| Relais | `NODE_ENV` | — | — | `!= production` → bypass auth (dev local) |
| Worker | `RELAY_URL` | oui | — | base prod, sans slash final (`RAILWAY_URL` accepté) |
| Worker | `WORKER_TOKEN` | oui | — | même valeur que côté relais |
| Worker | `RCC_PROJECTS` | — | `./projects.json` | manifest des projets |
| Worker | `POLL_MS` | — | `2000` | intervalle de poll |
| Worker | `CLAUDE_BIN` | — | `claude` | binaire CLI |

> **Ne jamais** mettre `ANTHROPIC_API_KEY` côté relais/Railway. L'exec vit sur le PC, sur le CLI loggé à l'abonnement.

## Garde-fou de coût (token fuité)

Pas de clé API metered : l'exec tape sur **ton abonnement** (flat). Le risque d'un token fuité n'est pas
la facture mais (a) ta **fenêtre de quota d'abonnement** et (b) le **compute sur ton PC**. Donc :
`daily_cap` par token (msgs/jour, `NULL` = illimité, **off par défaut**) = kill-switch ; `disabled = true`
révoque instantanément ; chaque exec est audité (`chat.exec`, coût réel `total_cost_usd` loggé pour info).

## Confinement de l'exec (`confine`, défaut `true`)

> **Ce que ça protège — et ce que ça NE protège PAS.** Confinement **LÉGER** : contre l'**accident**
> et le **snoop casual** (un pote qui demande à l'agent « lis et montre-moi tes clés / tes secrets »).
> **PAS** une sandbox contre un adversaire déterminé — pas de Docker/WSL ici, l'exec tourne sous ton
> compte Windows. Public visé : des gens de confiance. Ne donne pas une URL à quelqu'un que tu ne
> laisserais pas physiquement sur ton PC.

Quand `confine: true` (défaut de `createWorker`), chaque `claude -p` est lancé avec :

1. **Settings global d'Oscar NON chargé** — `--setting-sources project,local` exclut
   `~/.claude/settings.json` → son `defaultMode: bypassPermissions` (qui désactive TOUTES les
   permissions) ne s'applique pas. `--permission-mode default` en renfort (override CLI).
2. **Deny-list sur les secrets** — `--settings <.rcc-confined-settings.json>` refuse l'outil
   **Read** (et les lecteurs Bash reconnus `cat`/`head`/`tail`/`sed`) sur `~/.claude/**`, `.ssh`,
   `.aws`, `AppData`, `**/.env`, `**/credentials.json`, clés SSH, `.npmrc`, `secrets/**`. Le fichier
   est **généré au runtime** depuis le template `src/worker/confined-settings.json` : le placeholder
   `{{HOME}}` est remplacé par le home réel de l'opérateur (`os.homedir()`), donc le repo public
   n'est pas lié à un utilisateur particulier.
   ⚠️ Syntaxe Windows obligatoire : `Read(//c/Users/...)` (POSIX-normalisé, double-slash, lecteur
   minuscule) — un chemin `C:\Users\...` ne matcherait **rien** (faux-vert silencieux).
3. **Env curé** — claude n'hérite PAS de `process.env` brut. Allow-list explicite (PATH, SystemRoot,
   TEMP, l'auth claude) ; tout le reste — `SLACK_*`, `GITHUB_TOKEN_*`, `OPENROUTER/NVIDIA keys`… —
   **disparaît** du process, donc d'un `env` lancé par le pote. `ANTHROPIC_API_KEY`/`AUTH_TOKEN`
   volontairement absents (gagneraient sur l'OAuth d'abonnement + fuiteraient). `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
   laissé à son défaut (ON) → scrub des creds des sous-process Bash.

**Ce qui tient — vérifié empiriquement** (`test/confine-boundary.mjs`, claude v2.1.161, prompts sur
fichiers banals pour isoler la frontière du jugement du modèle) :
- L'outil **Read** d'un chemin deny est refusé ("accès au répertoire refusé"), un fichier DANS le projet
  reste lisible (deny **sélective**, pas blocage global).
- Un **sous-process arbitraire** (`python -c "open(...).read()"`, script Node, `type`, `Get-Content`)
  n'est PAS auto-exécuté : en `--permission-mode default` headless il exige une approbation que personne
  ne peut donner → `permission_denials` → refusé. Le "trou python" qu'on craignait est fermé **tant que
  les deux conditions ci-dessous tiennent**.

**Conditions qui ROUVRENT le trou — à ne pas violer :**
- **Ne jamais passer en mode laxiste** (`acceptEdits`, `bypassPermissions`, `--dangerously-skip-permissions`) :
  l'approbation des commandes saute → python/node lisent n'importe quel chemin. Le confinement REPOSE sur
  `default` (ou plus strict).
- **Ne pas allow-lister Bash dans un `.claude/settings.json` de repo d'agent** : `--setting-sources project,local`
  charge encore les settings du projet → un `permissions.allow` large y rouvre l'exec arbitraire.

**Trous assumés (honnêteté) :**
- **Adversaire déterminé** : pas une sandbox. Un acteur motivé peut tenter des formulations détournées,
  de l'ingénierie sociale, ou exploiter une faille du CLI. Le seul vrai rempart serait le **sandbox OS**
  de claude (`sandbox.filesystem`, indispo Windows natif) ou un **conteneur/VM**. Public visé : confiance.
- **L'écriture / git** : l'agent garde Bash + git dans son worktree. `confine` borne la **lecture de
  secrets**, pas les capacités d'écriture (c'est le rôle du worktree dédié + des 2 tokens de canal).

`confine: false` rétablit le comportement historique (exec brut, hérite de tout `process.env` et du
settings global avec bypassPermissions) — réservé à un usage **strictement local de confiance totale**.

## Sécurité — checklist avant d'exposer une URL

- [ ] `WORKER_TOKEN` long aléatoire, identique relais ⇄ worker, **jamais commité**.
- [ ] Chaque pote a son `ACCESS_TOKEN` (table), scopé à 1 projet, transmis par un canal privé.
- [ ] La page qui appelle `mountChatTab` est **protégée** (le token ne doit pas être public dans le HTML d'une page ouverte).
- [ ] `ANTHROPIC_API_KEY` absente de Railway.
- [ ] Worktree dédié vérifié (pas d'exec sur ta branche de travail).
- [ ] `confine: true` (défaut) — confinement léger de l'exec actif (cf. section ci-dessus).

## Test

```bash
npm test   # smoke zéro-dépendance : cycle de vie du store (token → enqueue → poll → reply → scope)
```
