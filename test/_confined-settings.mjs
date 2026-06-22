/**
 * Helper de test : génère le settings durci à partir du TEMPLATE `confined-settings.json`
 * en substituant {{HOME}} par le home réel (comme le fait worker.js au runtime). Sans ça,
 * les tests passeraient le template brut → deny `Read({{HOME}}/...)` ne matche RIEN = faux-vert.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// os.homedir() → préfixe POSIX-normalisé attendu par les deny claude (cf. worker.js).
export function homePosix(home = os.homedir()) {
  const win = /^([A-Za-z]):[\\/]?(.*)$/.exec(home);
  const p = win ? `//${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}` : home;
  return p.replace(/\/+$/, "");
}

// Lit le template, substitue {{HOME}}, écrit un fichier éphémère (tmp OS, jamais commité) et
// retourne son chemin — prêt à passer à `claude --settings`.
export function buildConfinedSettings() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tpl = fs.readFileSync(path.join(here, "..", "src", "worker", "confined-settings.json"), "utf8");
  const out = path.join(os.tmpdir(), "rcc-test-confined-settings.json");
  fs.writeFileSync(out, tpl.split("{{HOME}}").join(homePosix()));
  return out;
}
