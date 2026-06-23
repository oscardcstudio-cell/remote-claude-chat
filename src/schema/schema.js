/**
 * schema.js — définitions Drizzle (pg) des tables remote-claude-chat.
 *
 * OPTIONNEL : n'importez ceci que si vous consommez le store drizzle-pg ou voulez
 * un accès typé. La source de vérité du schéma reste `migration.sql` (jouée côté Railway).
 * `drizzle-orm` est une peer dependency optionnelle.
 *
 * Un consumer qui a déjà ses propres tables (ex : subvention_match avec julia_chat_messages)
 * peut ignorer ce fichier et fournir son propre store qui implémente l'interface Store.
 */
import { pgTable, uuid, text, boolean, integer, numeric, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const remoteChatMessages = pgTable("remote_chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: text("project_id").notNull(),
  convId: text("conv_id").notNull(),
  accessTokenId: uuid("access_token_id"),
  role: text("role").notNull(),                 // user|assistant|system
  content: text("content").notNull(),
  status: text("status").notNull().default("queued"), // queued|delivered|done|error
  error: text("error"),
  costUsd: numeric("cost_usd"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }), // prise par le worker → redelivery
}, (t) => ({
  projConvIdx: index("idx_rcc_msg_proj_conv").on(t.projectId, t.convId),
  statusIdx: index("idx_rcc_msg_status").on(t.status),
}));

export const remoteChatTokens = pgTable("remote_chat_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: text("token").notNull().unique(),
  projectId: text("project_id").notNull(),
  label: text("label"),
  disabled: boolean("disabled").notNull().default(false),
  dailyCap: integer("daily_cap"),
  allowList: jsonb("allow_list"),               // token "*" : restriction opt-in aux projets listés
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (t) => ({
  projectIdx: index("idx_rcc_tok_project").on(t.projectId),
}));

export const remoteChatEvents = pgTable("remote_chat_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: text("project_id"),
  convId: text("conv_id"),
  action: text("action").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  projectIdx: index("idx_rcc_evt_project").on(t.projectId),
}));
