# Copies vendorisées — remote-claude-chat

Registre des projets qui consomment ce package et **comment**. Règle d'or meta : vendoring
**interdit** — consommer en `github:oscardcstudio-cell/remote-claude-chat#<tag>` (Docker/Railway + clone-seul)
ou `file:../../packages/remote-claude-chat` (local). Toute copie de code = dette à éliminer, listée ici.

| Projet | Mode de consommation | Statut |
|---|---|---|
| subvention_match (brique D) | proto natif `server/modules/julia-chat.ts` + `tools/julia-worker/` | **dette transitoire** — débrancher vers `github:#v0.1.0` (cf. `DEBRANCH-subvention_match.md`) |

Aucune copie vendorisée du package lui-même n'existe à ce jour (package neuf). La brique D de
subvention_match est l'**ancêtre** (le proto dont ce package est extrait), pas une copie du package —
elle devient un consumer une fois le débranchement fait.
