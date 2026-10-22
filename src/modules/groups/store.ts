import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";

import env from "../../../env";

// ─── Invitation ledger ───────────────────────────────────────────
// Persistent record of every group invite so a number is never
// messaged twice and queued work survives restarts/redeploys.
//
//   queued   -> accepted, waiting in the delivery queue
//   sending  -> payload delivery started (outcome unknown if we crash)
//   sent     -> delivered by the gateway
//   failed   -> error, or interrupted while sending (safe to retry)
//
// DRY_RUN uses a separate file so simulations never pollute the
// real ledger.
// ─────────────────────────────────────────────────────────────────

export type InviteStatus = "queued" | "sending" | "sent" | "failed";

export interface InviteRow {
  group_id: string;
  number: string;
  status: InviteStatus;
  content: string;
  attempts: number;
  error: string | null;
  queued_at: number;
  updated_at: number;
}

/** Emits "change" (updated InviteRow) after every write and "remove" ({group_id, number}) on delete. */
export const inviteEvents = new EventEmitter();
inviteEvents.setMaxListeners(0);

mkdirSync("data", { recursive: true });
const db = new Database(env.DRY_RUN ? "data/wagate.dry.db" : "data/wagate.db");
db.run("PRAGMA journal_mode = WAL");
db.run(`
  CREATE TABLE IF NOT EXISTS invitations (
    group_id   TEXT NOT NULL,
    number     TEXT NOT NULL,
    status     TEXT NOT NULL,
    content    TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    queued_at  INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, number)
  )
`);

const qGet = db.query<InviteRow, [string, string]>(
  "SELECT * FROM invitations WHERE group_id = ? AND number = ?",
);
const qUpsertQueued = db.query(
  `INSERT INTO invitations (group_id, number, status, content, attempts, error, queued_at, updated_at)
   VALUES (?1, ?2, 'queued', ?3, 0, NULL, ?4, ?4)
   ON CONFLICT(group_id, number) DO UPDATE SET
     status = 'queued', content = ?3, error = NULL, queued_at = ?4, updated_at = ?4`,
);
const qSetStatus = db.query(
  `UPDATE invitations SET status = ?3, error = ?4, updated_at = ?5,
     attempts = attempts + (CASE WHEN ?3 = 'sending' THEN 1 ELSE 0 END)
   WHERE group_id = ?1 AND number = ?2`,
);
const qByStatus = db.query<InviteRow, [string]>(
  "SELECT * FROM invitations WHERE status = ? ORDER BY queued_at, rowid",
);
const qCounts = db.query<{ status: string; n: number }, [string]>(
  "SELECT status, COUNT(*) AS n FROM invitations WHERE group_id = ? GROUP BY status",
);
const qAll = db.query<InviteRow, [string]>(
  "SELECT * FROM invitations WHERE group_id = ? ORDER BY queued_at, rowid",
);
const qDelete = db.query(
  "DELETE FROM invitations WHERE group_id = ? AND number = ? AND status != 'sending'",
);
const qFailed = db.query<InviteRow, [string]>(
  "SELECT * FROM invitations WHERE group_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 500",
);

export const inviteStore = {
  get: (groupId: string, number: string) => qGet.get(groupId, number),

  queue: (groupId: string, number: string, content: string) => {
    qUpsertQueued.run(groupId, number, content, Date.now());
    inviteEvents.emit("change", qGet.get(groupId, number));
  },

  mark: (
    groupId: string,
    number: string,
    status: InviteStatus,
    error: string | null = null,
  ) => {
    qSetStatus.run(groupId, number, status, error, Date.now());
    inviteEvents.emit("change", qGet.get(groupId, number));
  },

  all: (groupId: string) => qAll.all(groupId),

  /**
   * Delete a record. A `queued` row is thereby cancelled (its queue task sees
   * the row is gone and skips). A `sending` row is never deleted: it is
   * already in flight. Returns whether a row was removed.
   */
  remove: (groupId: string, number: string) => {
    const changed = qDelete.run(groupId, number).changes > 0;
    if (changed) inviteEvents.emit("remove", { group_id: groupId, number });
    return changed;
  },

  /** Rows still waiting in the queue (oldest first). */
  pending: () => qByStatus.all("queued"),

  /**
   * Call once at startup. Rows left in `sending` were interrupted: we
   * cannot know if they were delivered, so they are NOT resent
   * automatically — they become `failed` for the operator to review.
   */
  recoverInterrupted: () => {
    const rows = qByStatus.all("sending");
    for (const r of rows) {
      inviteStore.mark(
        r.group_id,
        r.number,
        "failed",
        "interrupted while sending (delivery unknown)",
      );
    }
    return rows.length;
  },

  summary: (groupId: string) => {
    const out: Record<InviteStatus, number> = {
      queued: 0,
      sending: 0,
      sent: 0,
      failed: 0,
    };
    for (const r of qCounts.all(groupId)) out[r.status as InviteStatus] = r.n;
    return out;
  },

  failed: (groupId: string) => qFailed.all(groupId),
};
