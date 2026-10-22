import { existsSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import env from "../../../env";
import { expandPlaceholders } from "../../helper/greeting";
import logger from "../../helper/logger";
import {
    generateWarmupMessage,
    randomDelay,
    randomInt,
} from "../../helper/organic";
import type { WagateClient } from "../../lib/wwebjs";

// ─── Orchestrator ────────────────────────────────────────────────
// Anti-ban pipeline: warm-up conversation between WA1 ↔ WA2
// before delivering the actual payload from WA1 to the destination.
//
// Phase 1: WA2 → WA1  (warm-up messages)
// Phase 2: WA1 → WA2  (reply messages)
// Phase 3: WA1 → Dest (actual payload)
//
// Messages are queued sequentially — only one orchestration
// runs at a time to avoid overlapping warm-up patterns.
// ─────────────────────────────────────────────────────────────────

interface OrchestratorPayload {
  content: string;
  number: string;
  file?: File;
  /** Return false to skip this delivery (e.g. cancelled while waiting in the queue). */
  isActive?: () => boolean;
  /** Called right before the payload is sent to the destination. */
  onSending?: () => void;
  /** Called once with the final outcome of the payload delivery. */
  onDone?: (ok: boolean, error?: string) => void;
}

function cleanupTempFile(filePath: string) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // ignore cleanup errors
  }
}

/**
 * Weighted random message count:
 *   0 messages = 40% (skip warm-up — more organic)
 *   1 message  = 60%
 */
function weightedMessageCount(): number {
  const roll = Math.random() * 100;
  if (roll < 40) return 0; // 40% skip
  return 1;                 // 60% send 1 message
}

// ─── Sequential Queue ────────────────────────────────────────────
// Ensures only one orchestration runs at a time.

let queue: Promise<void> = Promise.resolve();
let deliveryCount = 0;
let lastActivity = 0; // last warm-up session or delivery (ms)

/** Read by the status endpoint so the dashboard can show warm-up activity. */
export const orchestratorState = { warming: false, waitingForClients: false };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sessionDue(): boolean {
  if (env.WARMUP_SESSION_MAX <= 0) return false;
  return Date.now() - lastActivity > env.WARMUP_IDLE_MINUTES * 60_000;
}

/**
 * Hold the queue until both accounts are connected, so a warm-up
 * conversation can happen before anything is sent.
 */
async function waitForClients(wa1: WagateClient, wa2: WagateClient, traceId: string) {
  if (env.DRY_RUN || !env.WARMUP_REQUIRED) return;
  let waited = 0;
  while (!(wa1.phoneNumber && wa2.phoneNumber)) {
    orchestratorState.waitingForClients = true;
    if (waited % 60 === 0) {
      logger.warn(
        `[${traceId}] ⏸️ Waiting for both WhatsApp accounts before warm-up ` +
          `(Client 1: ${wa1.phoneNumber ? "ok" : "not ready"}, Client 2: ${wa2.phoneNumber ? "ok" : "not ready"})`,
      );
    }
    await sleep(5000);
    waited += 5;
  }
  orchestratorState.waitingForClients = false;
}

/**
 * A short, human-paced conversation between our two accounts:
 * WA2 opens, they alternate, each side reads before replying.
 */
async function warmupSession(wa1: WagateClient, wa2: WagateClient, traceId: string) {
  const min = Math.min(env.WARMUP_SESSION_MIN, env.WARMUP_SESSION_MAX);
  const total = randomInt(min, env.WARMUP_SESSION_MAX);
  if (total <= 0) return;

  orchestratorState.warming = true;
  logger.info(`[${traceId}] 💬 Warm-up session: ${total} messages between Client 2 ↔ Client 1`);
  try {
    if (!env.DRY_RUN) {
      await wa1.saveContact(wa2.phoneNumber).catch(() => {});
      await wa2.saveContact(wa1.phoneNumber).catch(() => {});
    }

    let from = wa2;
    let to = wa1;
    for (let i = 0; i < total; i++) {
      const msg = generateWarmupMessage();
      logger.info(
        `[${traceId}] 💬 Warm-up [${i + 1}/${total}] ${from.clientId} → ${to.clientId}: "${msg}"`,
      );
      await from.sendMsg(msg, to.phoneNumber, true);
      await to.markAsRead(from.phoneNumber);
      if (i < total - 1) {
        await randomDelay(
          env.WARMUP_GAP_MIN_MS,
          Math.max(env.WARMUP_GAP_MIN_MS, env.WARMUP_GAP_MAX_MS),
        );
      }
      [from, to] = [to, from];
    }
    logger.info(`[${traceId}] 💬 Warm-up session complete`);
  } catch (e: any) {
    logger.warn(`[${traceId}] Warm-up session stopped: ${e?.message?.split("\n")[0]}`);
  } finally {
    orchestratorState.warming = false;
    lastActivity = Date.now();
  }
}

function enqueue(fn: () => Promise<void>): void {
  queue = queue.then(fn).catch((err) => {
    logger.error("[queue] Task failed, continuing queue", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ─── Orchestrator ────────────────────────────────────────────────

export abstract class Orchestrator {
  /**
   * Queue a message for delivery via the anti-ban pipeline.
   * Orchestrations run sequentially — the next one starts
   * only after the previous one completes.
   */
  static dispatch(
    wa1: WagateClient,
    wa2: WagateClient,
    payload: OrchestratorPayload,
  ) {
    const traceId = `orch-${Date.now()}-${randomInt(1000, 9999)}`;
    logger.info(
      `[${traceId}] 📥 Queued for delivery → ${payload.number}`,
    );

    enqueue(() => Orchestrator.execute(wa1, wa2, payload, traceId));
  }

  /**
   * Execute the full anti-ban pipeline (called by queue).
   */
  private static async execute(
    wa1: WagateClient,
    wa2: WagateClient,
    payload: OrchestratorPayload,
    traceId: string,
  ) {
    logger.info(
      `[${traceId}] 🚀 Starting orchestration → destination: ${payload.number}`,
    );

    const done = (ok: boolean, error?: string) => {
      try {
        payload.onDone?.(ok, error);
      } catch (e) {
        logger.error(`[${traceId}] onDone callback failed`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    if (payload.isActive && !payload.isActive()) {
      logger.info(`[${traceId}] ⏭️ Cancelled before start — skipped (${payload.number})`);
      return;
    }

    try {
      // ── Warm-up session: Client 1 ↔ Client 2 chat before sending ──
      if (sessionDue()) {
        await waitForClients(wa1, wa2, traceId);
        await warmupSession(wa1, wa2, traceId);
      }

      // Warm-up runs on every WARMUP_EVERY-th delivery (1 = every message).
      const warmupDue = deliveryCount++ % env.WARMUP_EVERY === 0;
      const isWa2Ready =
        warmupDue && wa2.client && (wa2.client as any).info;

      // ── Phase 1: WA2 → WA1 warm-up ──
      const warmup1Count = isWa2Ready ? weightedMessageCount() : 0;

      if (warmup1Count > 0) {
        logger.info(
          `[${traceId}] Phase 1: WA2 → WA1 (${warmup1Count} warm-up messages)`,
        );

        let phase1Success = 0;
        for (let i = 0; i < warmup1Count; i++) {
          try {
            await randomDelay(400, 1000);
            const msg = generateWarmupMessage(expandPlaceholders(payload.content));
            logger.info(
              `[${traceId}] Phase 1 [${i + 1}/${warmup1Count}]: "${msg}"`,
            );
            await wa2.sendMsg(msg, wa2.partnerNumber, true);
            phase1Success++;
          } catch (e: any) {
            logger.warn(`[${traceId}] Phase 1 warm-up skipped: ${e?.message?.split('\n')[0]}`);
            break; // stop further warm-up attempts if one fails
          }
        }

        if (phase1Success > 0) {
          // WA1 reads the warm-up messages from WA2
          await wa1.markAsRead(wa2.partnerNumber);
        }
      } else {
        logger.info(`[${traceId}] Phase 1: Skipped (${isWa2Ready ? "organic variance" : "not due / WA2 not ready"})`);
      }

      // ── Phase 2: WA1 → WA2 reply ──
      const warmup2Count = isWa2Ready ? weightedMessageCount() : 0;

      if (warmup2Count > 0) {
        logger.info(
          `[${traceId}] Phase 2: WA1 → WA2 (${warmup2Count} reply messages)`,
        );

        let phase2Success = 0;
        for (let i = 0; i < warmup2Count; i++) {
          try {
            await randomDelay(400, 1000);
            const msg = generateWarmupMessage(expandPlaceholders(payload.content));
            logger.info(
              `[${traceId}] Phase 2 [${i + 1}/${warmup2Count}]: "${msg}"`,
            );
            await wa1.sendMsg(msg, wa1.partnerNumber, true);
            phase2Success++;
          } catch (e: any) {
            logger.warn(`[${traceId}] Phase 2 warm-up skipped: ${e?.message?.split('\n')[0]}`);
            break;
          }
        }

        if (phase2Success > 0) {
          // WA2 reads the reply messages from WA1
          await wa2.markAsRead(wa1.partnerNumber);
        }
      } else {
        logger.info(`[${traceId}] Phase 2: Skipped (${isWa2Ready ? "organic variance" : "not due / WA2 not ready"})`);
      }


      // ── Phase 3: WA1 → Destination (actual payload) ──
      await randomDelay(800, 2000);
      if (payload.isActive && !payload.isActive()) {
        logger.info(`[${traceId}] ⏭️ Cancelled before delivery — skipped (${payload.number})`);
        return;
      }
      payload.onSending?.();
      logger.info(
        `[${traceId}] Phase 3: WA1 → ${payload.number} (PAYLOAD DELIVERY)`,
      );

      if (payload.file) {
        const tempFilePath = join(
          tmpdir(),
          `wagate-${Date.now()}-${payload.file.name}`,
        );
        const buffer = await payload.file.arrayBuffer();
        writeFileSync(tempFilePath, Buffer.from(buffer));

        try {
          await wa1.sendFile(
            expandPlaceholders(payload.content),
            payload.number,
            tempFilePath,
          );
        } finally {
          cleanupTempFile(tempFilePath);
        }
      } else {
        await wa1.sendMsg(expandPlaceholders(payload.content), payload.number);
      }

      lastActivity = Date.now();
      logger.info(`[${traceId}] ✅ Orchestration complete`);
      done(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      done(false, message.split("\n")[0].slice(0, 300));
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error(
        `[${traceId}] ❌ Orchestration failed: ${message}`,
        { error: message, stack, destination: payload.number },
      );
    }
  }
}
