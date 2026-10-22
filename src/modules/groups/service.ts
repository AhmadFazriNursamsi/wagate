import logger from "../../helper/logger";
import type { WagateClient } from "../../lib/wwebjs";
import { Orchestrator } from "../messaging/orchestrator";
import { inviteStore } from "./store";

// Queue one invitation through the anti-ban orchestrator and keep the
// ledger in sync with its progress.
export function enqueueInvite(
  wa1: WagateClient,
  wa2: WagateClient,
  groupId: string,
  number: string,
  content: string,
) {
  // A task only runs while its row is still the same queued entry. If the row
  // was deleted (cancelled) or re-queued later, the old task skips itself.
  const token = inviteStore.get(groupId, number)?.queued_at;
  Orchestrator.dispatch(wa1, wa2, {
    content,
    number,
    isActive: () => {
      const row = inviteStore.get(groupId, number);
      return row?.status === "queued" && row.queued_at === token;
    },
    onSending: () => inviteStore.mark(groupId, number, "sending"),
    onDone: (ok, error) =>
      inviteStore.mark(groupId, number, ok ? "sent" : "failed", error ?? null),
  });
}

// Re-queue invitations that were still waiting when the server stopped.
export function resumeInvites(wa1: WagateClient, wa2: WagateClient) {
  const interrupted = inviteStore.recoverInterrupted();
  const pending = inviteStore.pending();
  if (interrupted > 0) {
    logger.warn(
      `[invites] ${interrupted} invitation(s) were interrupted mid-send — marked failed (delivery unknown, not resent automatically)`,
    );
  }
  if (pending.length > 0) {
    logger.info(`[invites] Resuming ${pending.length} queued invitation(s)`);
    for (const r of pending) {
      enqueueInvite(wa1, wa2, r.group_id, r.number, r.content);
    }
  }
}
