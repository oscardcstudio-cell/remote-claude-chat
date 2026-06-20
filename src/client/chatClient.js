/**
 * chatClient.js — logique de chat headless (zéro dépendance, zéro DOM).
 * SOURCE DE VÉRITÉ du polling : réutilisée par mountChatTab (vanilla) ET ChatTab (React)
 * → la boucle 2s n'est écrite qu'une fois (ban vendoring : pas de copie de logique par projet).
 *
 * @param {Object} opts
 * @param {string} [opts.apiBase]      base de l'API relais (défaut '/api/chat')
 * @param {string} [opts.accessToken]  ACCESS_TOKEN du pote (envoyé en header x-access-token)
 * @param {string} [opts.convId]       id de conversation (défaut : généré + persisté en localStorage par projet)
 * @param {string} [opts.projectId]    pour la clé localStorage du convId (défaut 'default')
 * @param {number} [opts.pollMs]       intervalle de poll (défaut 2000)
 * @param {(msgs:object[])=>void} [opts.onMessages]  callback à chaque rafraîchissement
 * @param {(err:Error)=>void} [opts.onError]
 */
export function createChatClient(opts = {}) {
  const apiBase = (opts.apiBase || "/api/chat").replace(/\/$/, "");
  const pollMs = opts.pollMs || 2000;
  const headers = opts.accessToken ? { "x-access-token": opts.accessToken } : {};
  const convId = opts.convId || ensureConvId(opts.projectId || "default");
  let timer = null, stopped = false, lastJson = "";

  async function refresh() {
    const r = await fetch(`${apiBase}/${encodeURIComponent(convId)}`, { headers });
    if (!r.ok) throw new Error(`GET ${apiBase}/${convId} → ${r.status}`);
    const { messages } = await r.json();
    const json = JSON.stringify(messages);
    if (json !== lastJson) { lastJson = json; opts.onMessages?.(messages || []); }   // ne notifie que si ça change
    return messages || [];
  }

  async function send(content) {
    const text = String(content || "").trim();
    if (!text) return;
    const r = await fetch(`${apiBase}/${encodeURIComponent(convId)}/message`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `POST message → ${r.status}`);
    }
    await refresh();
  }

  function start() {
    stopped = false;
    const loop = async () => {
      if (stopped) return;
      try { await refresh(); } catch (e) { opts.onError?.(e); }
      if (!stopped) timer = setTimeout(loop, pollMs);
    };
    loop();
  }

  function stop() { stopped = true; if (timer) clearTimeout(timer); }

  return { convId, send, refresh, start, stop };
}

function ensureConvId(projectId) {
  const key = `rcc:convId:${projectId}`;
  try {
    const ex = localStorage.getItem(key);
    if (ex) return ex;
    const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(key, id);
    return id;
  } catch {
    return `c-${Date.now().toString(36)}`;   // pas de localStorage (SSR) : éphémère
  }
}
