-- remote-claude-chat — migration idempotente (Postgres).
-- Source de vérité du schéma. À jouer une fois côté Railway/Supabase (le relais = seul writer).
-- Idempotente : rejouable sans risque (IF NOT EXISTS partout). Jamais de DROP.

-- File de messages : une conversation = une session CLI claude (--resume <sessionId>).
-- status : queued (posté par le pote) → delivered (pris par le worker) → done|error.
CREATE TABLE IF NOT EXISTS remote_chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      text NOT NULL,                       -- namespace projet (un même worker sert N projets)
  conv_id         text NOT NULL,                       -- une conversation = une session claude --resume
  access_token_id uuid,                                -- quel pote a posté (null pour assistant/system)
  role            text NOT NULL,                       -- user|assistant|system
  content         text NOT NULL,
  status          text NOT NULL DEFAULT 'queued',      -- queued|delivered|done|error
  error           text,                                -- message d'erreur si exec a échoué
  cost_usd        numeric,                             -- coût réel remonté par le worker (claude -p json), info/audit
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rcc_msg_proj_conv ON remote_chat_messages (project_id, conv_id);
CREATE INDEX IF NOT EXISTS idx_rcc_msg_status    ON remote_chat_messages (status);

-- Tokens d'accès : 1 pote = 1 token, scopé à 1 projet, révocable. Le token EST l'accès (pas de compte).
-- daily_cap : kill-switch optionnel (msgs/jour) contre un token fuité. NULL = illimité.
CREATE TABLE IF NOT EXISTS remote_chat_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token        text NOT NULL UNIQUE,                   -- secret long aléatoire, porté par le pote
  project_id   text NOT NULL,                          -- scope : ce token ne voit QUE ce projet
  label        text,                                   -- ex "julia", "marc" (lisible dans l'audit)
  disabled     boolean NOT NULL DEFAULT false,         -- révocation instantanée
  daily_cap    integer,                                -- msgs/jour max (NULL = illimité)
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_rcc_tok_project ON remote_chat_tokens (project_id);

-- Audit : chaque exec distant tracé (garde-fou n°3 du wedge). Optionnel — un consumer peut
-- router l'audit vers SA propre table d'events via le store ; sinon celle-ci sert de défaut.
CREATE TABLE IF NOT EXISTS remote_chat_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text,
  conv_id    text,
  action     text NOT NULL,                            -- ex "chat.message", "chat.exec"
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rcc_evt_project ON remote_chat_events (project_id);

-- ── Ajouts additifs (idempotents, jamais de DROP) ──────────────────────────────
-- delivered_at : horodatage de prise par le worker → redelivery (re-queue d'un message
-- "delivered" trop vieux si le worker meurt ou si POST /reply échoue côté réseau).
ALTER TABLE remote_chat_messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_rcc_msg_delivered ON remote_chat_messages (status, delivered_at);

-- allow_list : restriction opt-in d'un token "personne" (project_id = '*') à un sous-ensemble
-- d'agents joignables. NULL/absente = tous projets permis (rétro-compat).
ALTER TABLE remote_chat_tokens ADD COLUMN IF NOT EXISTS allow_list jsonb;
