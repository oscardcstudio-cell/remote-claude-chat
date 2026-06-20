/**
 * mountChatTab — onglet chat vanilla (zéro dépendance, marche partout : page HTML
 * server-rendered, dashboard, SPA). Brandable via `brand`. Réutilise chatClient (boucle 2s unique).
 *
 *   import { mountChatTab } from "remote-claude-chat/client";
 *   mountChatTab(document.getElementById("chat"), {
 *     projectId: "mecene",
 *     accessToken: "<ACCESS_TOKEN du pote>",
 *     apiBase: "/api/chat",
 *     brand: { projectName: "Julia · Mecene", accent: "#1f6feb", logo: "/logo.svg" },
 *   });
 *
 * @returns {{ destroy: ()=>void, client: object }}
 */
import { createChatClient } from "./chatClient.js";

export function mountChatTab(el, opts = {}) {
  if (!el) throw new Error("mountChatTab: élément cible requis.");
  const brand = opts.brand || {};
  const accent = brand.accent || "#1f6feb";

  el.innerHTML = "";
  el.style.setProperty("--rcc-accent", accent);
  const root = h("div", "rcc-root");
  root.innerHTML = TEMPLATE(brand);
  el.appendChild(root);
  injectStyleOnce();

  const log = root.querySelector(".rcc-log");
  const input = root.querySelector(".rcc-input");
  const form = root.querySelector(".rcc-form");
  const status = root.querySelector(".rcc-status");

  const client = createChatClient({
    apiBase: opts.apiBase,
    accessToken: opts.accessToken,
    convId: opts.convId,
    projectId: opts.projectId,
    pollMs: opts.pollMs,
    onMessages: render,
    onError: (e) => setStatus(`hors-ligne — ${e.message}`, true),
  });

  function render(messages) {
    log.innerHTML = "";
    let pending = false;
    for (const m of messages) {
      if (m.role === "system") continue;
      log.appendChild(bubble(m));
      if (m.role === "user" && (m.status === "queued" || m.status === "delivered")) pending = true;
    }
    setStatus(pending ? "l'agent réfléchit…" : "", false);
    log.scrollTop = log.scrollHeight;
  }

  function bubble(m) {
    const b = h("div", `rcc-msg rcc-${m.role}`);
    b.textContent = m.content;
    return b;
  }

  function setStatus(txt, isError) {
    status.textContent = txt;
    status.classList.toggle("rcc-err", !!isError);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    setStatus("envoi…", false);
    try { await client.send(text); } catch (err) { setStatus(err.message, true); input.value = text; }
  });

  client.start();
  return { destroy: () => { client.stop(); el.innerHTML = ""; }, client };
}

function h(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function TEMPLATE(brand) {
  const name = brand.projectName || "Chat";
  const logo = brand.logo ? `<img class="rcc-logo" src="${brand.logo}" alt="">` : "";
  return `
    <div class="rcc-head">${logo}<span class="rcc-title">${escapeHtml(name)}</span></div>
    <div class="rcc-log"></div>
    <div class="rcc-status"></div>
    <form class="rcc-form">
      <input class="rcc-input" type="text" placeholder="Écris un message…" autocomplete="off" />
      <button class="rcc-send" type="submit">Envoyer</button>
    </form>`;
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

let styled = false;
function injectStyleOnce() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const css = `
  .rcc-root{display:flex;flex-direction:column;height:100%;min-height:320px;font-family:system-ui,sans-serif;color:#e6e6e6}
  .rcc-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2a2a2a;font-weight:600}
  .rcc-logo{height:20px;width:auto}
  .rcc-title{color:var(--rcc-accent)}
  .rcc-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
  .rcc-msg{max-width:80%;padding:8px 11px;border-radius:12px;line-height:1.4;white-space:pre-wrap;word-break:break-word;font-size:14px}
  .rcc-user{align-self:flex-end;background:var(--rcc-accent);color:#fff}
  .rcc-assistant{align-self:flex-start;background:#1e1e1e;border:1px solid #2c2c2c}
  .rcc-status{min-height:18px;padding:0 12px;font-size:12px;color:#8a8a8a}
  .rcc-status.rcc-err{color:#e5534b}
  .rcc-form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #2a2a2a}
  .rcc-input{flex:1;background:#161616;border:1px solid #2c2c2c;border-radius:8px;padding:9px 11px;color:#e6e6e6;font-size:14px}
  .rcc-input:focus{outline:none;border-color:var(--rcc-accent)}
  .rcc-send{background:var(--rcc-accent);color:#fff;border:0;border-radius:8px;padding:0 16px;font-weight:600;cursor:pointer}`;
  const tag = document.createElement("style");
  tag.textContent = css;
  document.head.appendChild(tag);
}
