> Hiérarchie : hérite de C:\dev\claude\CLAUDE.md et C:\dev\claude\oscardcstudio\CLAUDE.md

# remote-claude-chat

Package partagé (relais Express + worker local + widget). Consommé uniquement en `github:oscardcstudio-cell/remote-claude-chat#<tag>`, jamais copié (anti-vendoring, cf. [VENDORED.md](VENDORED.md)).

- Test : `npm install && npm test` (smoke + suites `node:test`, tout doit passer).
- Tout changement de `src/` = bump de version dans `package.json` + tag `vX.Y.Z` poussé, sinon aucun consommateur ne le reçoit.
- Un consommateur qui bump doit forcer le tag explicite (`npm i github:...#vX.Y.Z`) et vérifier la ligne `resolved` du lockfile : sinon il garde l'ancien SHA.
- Le confinement (`confine: true`) est léger, pas un sandbox : ne jamais exposer une URL publique sans confinement externe (cf. README §Sécurité).
- Backlog sécurité ouvert : [SECURITY-BACKLOG.md](SECURITY-BACKLOG.md). Carte des fichiers : [llms.txt](llms.txt).
