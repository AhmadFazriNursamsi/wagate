import { cron } from "@elysiajs/cron";
import { Elysia } from "elysia";

import env from "../env";
import logger from "./helper/logger";
import { messaging } from "./modules/messaging";
import { loggerPlugin } from "./plugins/logger";
import { client1, client2, wagatePlugin } from "./plugins/wagate";

// ─── Main Application ───────────────────────────────────────────
const app = new Elysia()
  .use(loggerPlugin)
  .use(wagatePlugin)
  .use(
    cron({
      name: "monthly-chat-cleanup",
      pattern: "0 0 1 * *", // 1st of every month at midnight
      async run() {
        logger.info("[cleanup] 🧹 Monthly cleanup: clearing WA1↔WA2 chats...");
        await client1.clearChat(env.WA2_NUMBER);
        await client2.clearChat(env.WA1_NUMBER);
        logger.info("[cleanup] ✅ Monthly cleanup complete");
      },
    }),
  )
  .use(() => {
    let isCatuCronRunning = false;
    return new Elysia().use(
      cron({
        name: "catu-cron-params-romo",
        pattern: "*/1 * * * *", // Every 1 minute
        async run() {
          if (isCatuCronRunning) {
            logger.warn("[cron-catu] ⚠️ Previous CATU cron task still running, skipping execution.");
            return;
          }
          isCatuCronRunning = true;
          const url = env.CATU_CRON_URL;
          logger.info(`[cron-catu] 🔄 Triggering CATU cron: ${url}`);
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

            const res = await fetch(url, {
              method: "GET",
              headers: { "User-Agent": "Wagate-Cron/1.0" },
              signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (res.ok) {
              const text = await res.text();
              logger.info(`[cron-catu] ✅ CATU cron trigger success [${res.status}]: ${text.substring(0, 150)}`);
            } else {
              logger.error(`[cron-catu] ❌ CATU cron trigger failed with status [${res.status}]`);
            }
          } catch (err: any) {
            logger.error(`[cron-catu] ❌ Error triggering CATU cron: ${err?.message || err}`);
          } finally {
            isCatuCronRunning = false;
          }
        },
      }),
    );
  })
  .onError({ as: "global" }, ({ code, error, set }) => {
    const statusCode = (error as any).status || 500;
    const message =
      "message" in error ? (error as Error).message : "Internal server error";
    const stack =
      "stack" in error ? (error as Error).stack : undefined;

    logger.error(`[http] ${code} — ${message}`, {
      code,
      statusCode,
      stack,
    });

    set.status = statusCode;
    return {
      status: "error",
      code: statusCode,
      message,
    };
  })
  .get("/qr", ({ set }) => {
    set.headers["content-type"] = "text/html; charset=utf-8";
    const qr1 = client1.qrCode;
    const qr2 = client2.qrCode;
    
    if (!qr1 && !qr2) {
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#eee;">
        <h2>Status QR WhatsApp</h2>
        <p style="color:#aaa;">Belum ada QR Code (mungkin bot sudah terhubung / connected).</p>
      </body></html>`;
    }
    
    return `<!DOCTYPE html><html>
      <head>
        <title>Scan QR WhatsApp Gateway</title>
        <meta http-equiv="refresh" content="5">
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:30px;background:#111;color:#eee;">
        <h2>Scan QR Code WhatsApp Gateway (Dual-Client Anti-Ban)</h2>
        <p style="color:#aaa;font-size:14px;">Halaman ini akan diperbarui otomatis setiap 5 detik.</p>
        <div style="display:flex;justify-content:center;gap:40px;flex-wrap:wrap;margin-top:20px;">
          <div>
            <h3>Client 1 (Main Account)</h3>
            ${qr1 ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr1)}" style="border:10px solid white;border-radius:10px;" />` : '<p style="color:#4CAF50;font-weight:bold;">✅ Client 1 Terhubung (Connected)</p>'}
          </div>
          <div>
            <h3>Client 2 (Secondary Account)</h3>
            ${qr2 ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr2)}" style="border:10px solid white;border-radius:10px;" />` : '<p style="color:#4CAF50;font-weight:bold;">✅ Client 2 Terhubung (Connected)</p>'}
          </div>
        </div>
      </body>
    </html>`;
  })
  .onBeforeHandle({ as: "global" }, ({ request, set }) => {
    // Cache-control header (replaces Express CacheMiddleware)
    const period = 60 * 60; // 1 hour
    if (request.method === "GET") {
      set.headers["cache-control"] = `public, max-age=${period}`;
    } else {
      set.headers["cache-control"] = "no-store";
    }
  })
  .group("/api/v1", (app) =>
    app
      .onBeforeHandle(({ request, set }) => {
        const apiKey =
          request.headers.get("x-api-key") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

        if (apiKey !== env.SECRET_KEY) {
          set.status = 401;
          return { status: "error", code: 401, message: "Unauthorized" };
        }
      })
      .get("/", () => ({ message: "REST API is working" }))
      .use(messaging),
  )
  .listen(env.PORT);

// ─── Startup ─────────────────────────────────────────────────────
logger.info(`🚀 Server running on port ${env.PORT}`);

(async () => {
  try {
    logger.info("═══════════════════════════════════════════════");
    logger.info("[startup] Initializing Client 1 & Client 2 concurrently...");
    logger.info("═══════════════════════════════════════════════");
    await Promise.allSettled([
      client1.init().catch((e) => logger.error(`[startup] Client 1 init error: ${e}`)),
      client2.init().catch((e) => logger.error(`[startup] Client 2 init error: ${e}`)),
    ]);

    logger.info("");
    logger.info("[startup] Verifying and linking partner contacts...");
    if (client1.phoneNumber) {
      client2.partnerNumber = client1.phoneNumber;
      logger.info(`[startup] 📱 Client 2 partner set to Client 1 number: ${client1.phoneNumber}`);
    }
    if (client2.phoneNumber) {
      client1.partnerNumber = client2.phoneNumber;
      logger.info(`[startup] 📱 Client 1 partner set to Client 2 number: ${client2.phoneNumber}`);
    }

    if (client1.partnerNumber) await client1.saveContact(client1.partnerNumber);
    if (client2.partnerNumber) await client2.saveContact(client2.partnerNumber);

    logger.info("═══════════════════════════════════════════════");
    logger.info("[startup] ✅ Both clients ready — WA-GATE is live");
    logger.info("[startup] 📅 Monthly chat cleanup: 1st of every month");
    logger.info("═══════════════════════════════════════════════");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[startup] ❌ Failed to initialize: ${message}`, {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
})();


// ─── Global Error Handlers ───────────────────────────────────────
process.once("unhandledRejection", async (reason) => {
  logger.error("[process] Unhandled rejection", {
    reason: String(reason),
    stack:
      reason instanceof Error ? reason.stack : undefined,
  });
});

process.once("uncaughtException", async (err) => {
  logger.error("[process] Uncaught exception", {
    error: err.message,
    stack: err.stack,
  });
});

export { app };
