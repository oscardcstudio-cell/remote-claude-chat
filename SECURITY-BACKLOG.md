# remote-claude-chat — backlog sécurité

Findings d'un audit read-only (2026-06-22). **Non corrigés** (deferred par Oscar — projet actif).
Triés par sévérité. Chaque ligne : `fichier:ligne — problème — fix proposé`.

## CRITIQUE
- `src/server/createChatRelayRouter.js:45` — `devBypass = process.env.NODE_ENV !== "production"` : **fail-open**. `NODE_ENV=production` n'est réglé NULLE PART dans les configs de déploiement (railway.toml, Dockerfile, package.json). Si le relais tourne sur Railway sans cette var d'env → toute l'auth (pote + worker) est bypassée = accès public aux agents. **Fix** : fail-closed par défaut — bypass en opt-in explicite (`RCC_DEV_BYPASS=1`), jamais déduit de l'absence d'une var. **Vérifier d'abord** : `railway variables` sur le service relais pour savoir si NODE_ENV=production est réglé en prod (urgence réelle conditionnée à ça).

## HIGH
- `src/server/createChatRelayRouter.js:75` — token-personne (`project_id="*"`) accepte n'importe quel `x-project-id` sans allow-list → un seul ACCESS_TOKEN wildcard fuité = accès à TOUS les agents hébergés (y compris agents explicites en worktree qui écrivent). **Fix** : stocker une allow-list de projectIds sur le token wildcard, vérifier `x-project-id ∈ allowList`.
- `src/worker/confined-settings.json:5` — username `oscar` hardcodé dans les deny `Read(//c/Users/oscar/.ssh|.aws|.claude|AppData...)`. Sur toute autre machine/user, ces règles ne matchent RIEN → faux-vert sécu : le confinement annoncé ne protège aucun secret du home. Package destiné à être consommé en dépendance = bug réel pour tout consommateur. **Fix** : dériver le chemin de `os.homedir()`/`os.userInfo().username` au runtime et générer le settings dynamiquement (placeholder substitué), pas un littéral.

## MED
- `src/server/createChatRelayRouter.js:126` — comparaison `WORKER_TOKEN` par `!==` non constant-time → timing attack sur le secret partagé. **Fix** : `crypto.timingSafeEqual` après check de longueur ; rejeter si header absent.
- `src/worker/worker.js:95` — `spawn(claudeBin, args, { shell:true })` : `--resume <sessionId>` lu depuis `.rcc-sessions.json` (altérable hors-process) ré-interprété par cmd/sh → injection shell possible si le fichier de sessions est modifié. **Fix** : retirer `shell:true` (résoudre `claude.cmd` via PATHEXT/`where` sur Windows).
- `src/worker/worker.js:114` — si `POST /_worker/reply` échoue (réseau), le message reste `delivered` en DB pour toujours, jamais re-queué ni expiré → réponse avalée, le pote ne voit ni réponse ni erreur. **Fix** : redelivery côté relais (`delivered` depuis > N min → re-queued) ou retry persistant worker.
- `src/client/mountChatTab.js:84` — `brand.logo` interpolé non-échappé dans `src="${logo}"` alors que `projectName` EST échappé (ligne 86) → breakout d'attribut / XSS si `brand.logo` vient d'une config non fiable. **Fix** : `escapeHtml(logo)` ou `setAttribute` sur un élément créé en JS.

## LOW
- `src/worker/worker.js:126` — `runOne(...).catch()` log l'erreur mais ne notifie jamais le relais si `runClaude` throw avant le reply → message `delivered` sans reply. **Fix** : poster `/_worker/reply {error}` dans le `.catch` avant de libérer `busy`.
- `src/worker/cli.js:45` — SIGINT force `process.exit(0)` après 100ms fixes sans attendre l'exec claude en cours → child orphelin / worktree sale / session non sauvée. **Fix** : attendre `busy` vide (timeout de garde) avant exit.
- `src/server/stores/memoryStore.js:48` — `reply()` ne vérifie pas que `orig` existe → id inconnu = update sauté mais message assistant orphelin inséré quand même (statut incohérent). **Fix** : si `!orig`, ne pas insérer / logger un échec explicite.
