import { existsSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

    try {
      const isWa2Ready = wa2.client && (wa2.client as any).info;

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
            const msg = generateWarmupMessage(payload.content);
            logger.info(
              `[${traceId}] Phase 1 [${i + 1}/${warmup1Count}]: "${msg}"`,
            );
            await wa2.sendMsg(msg, wa2.partnerNumber);
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
        logger.info(`[${traceId}] Phase 1: Skipped (${isWa2Ready ? "organic variance" : "WA2 not ready"})`);
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
            const msg = generateWarmupMessage(payload.content);
            logger.info(
              `[${traceId}] Phase 2 [${i + 1}/${warmup2Count}]: "${msg}"`,
            );
            await wa1.sendMsg(msg, wa1.partnerNumber);
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
        logger.info(`[${traceId}] Phase 2: Skipped (${isWa2Ready ? "organic variance" : "WA2 not ready"})`);
      }


      // ── Phase 3: WA1 → Destination (actual payload) ──
      await randomDelay(800, 2000);
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
            payload.content,
            payload.number,
            tempFilePath,
          );
        } finally {
          cleanupTempFile(tempFilePath);
        }
      } else {
        await wa1.sendMsg(payload.content, payload.number);
      }

      logger.info(`[${traceId}] ✅ Orchestration complete`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error(
        `[${traceId}] ❌ Orchestration failed: ${message}`,
        { error: message, stack, destination: payload.number },
      );
    }
  }
}
