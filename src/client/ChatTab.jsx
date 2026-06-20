/**
 * ChatTab — wrapper React. Réutilise chatClient (même boucle 2s que la version vanilla).
 * Style minimal inline ; brandez via `brand.accent`. Pour un look 100% maison, copiez ce
 * fichier dans votre design system — la logique reste dans chatClient (rien à dupliquer).
 *
 *   import { ChatTab } from "remote-claude-chat/client/react";
 *   <ChatTab projectId="mecene" accessToken={token} apiBase="/api/chat"
 *            brand={{ projectName: "Julia · Mecene", accent: "#1f6feb" }} />
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createChatClient } from "./chatClient.js";

export function ChatTab({ projectId, accessToken, apiBase, convId, pollMs, brand = {} }) {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const logRef = useRef(null);
  const accent = brand.accent || "#1f6feb";

  const client = useMemo(
    () => createChatClient({ apiBase, accessToken, convId, projectId, pollMs,
      onMessages: setMessages, onError: (e) => setError(e.message) }),
    [apiBase, accessToken, convId, projectId, pollMs]
  );

  useEffect(() => { client.start(); return () => client.stop(); }, [client]);

  useEffect(() => {
    const pending = messages.some((m) => m.role === "user" && (m.status === "queued" || m.status === "delivered"));
    setStatus(pending ? "l'agent réfléchit…" : "");
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  async function onSubmit(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft(""); setError(""); setStatus("envoi…");
    try { await client.send(text); } catch (err) { setError(err.message); setDraft(text); }
  }

  const S = styles(accent);
  return (
    <div style={S.root}>
      <div style={S.head}>
        {brand.logo ? <img src={brand.logo} alt="" style={S.logo} /> : null}
        <span style={S.title}>{brand.projectName || "Chat"}</span>
      </div>
      <div ref={logRef} style={S.log}>
        {messages.filter((m) => m.role !== "system").map((m) => (
          <div key={m.id} style={{ ...S.msg, ...(m.role === "user" ? S.user : S.assistant) }}>{m.content}</div>
        ))}
      </div>
      <div style={{ ...S.status, ...(error ? S.err : null) }}>{error || status}</div>
      <form style={S.form} onSubmit={onSubmit}>
        <input style={S.input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Écris un message…" autoComplete="off" />
        <button style={S.send} type="submit">Envoyer</button>
      </form>
    </div>
  );
}

function styles(accent) {
  return {
    root: { display: "flex", flexDirection: "column", height: "100%", minHeight: 320, fontFamily: "system-ui,sans-serif", color: "#e6e6e6" },
    head: { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid #2a2a2a", fontWeight: 600 },
    logo: { height: 20, width: "auto" },
    title: { color: accent },
    log: { flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 },
    msg: { maxWidth: "80%", padding: "8px 11px", borderRadius: 12, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 14 },
    user: { alignSelf: "flex-end", background: accent, color: "#fff" },
    assistant: { alignSelf: "flex-start", background: "#1e1e1e", border: "1px solid #2c2c2c" },
    status: { minHeight: 18, padding: "0 12px", fontSize: 12, color: "#8a8a8a" },
    err: { color: "#e5534b" },
    form: { display: "flex", gap: 8, padding: "10px 12px", borderTop: "1px solid #2a2a2a" },
    input: { flex: 1, background: "#161616", border: "1px solid #2c2c2c", borderRadius: 8, padding: "9px 11px", color: "#e6e6e6", fontSize: 14 },
    send: { background: accent, color: "#fff", border: 0, borderRadius: 8, padding: "0 16px", fontWeight: 600, cursor: "pointer" },
  };
}
