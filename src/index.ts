import { cron } from "@elysiajs/cron";
import { Elysia } from "elysia";
import QRCode from "qrcode";

import env from "../env";
import logger from "./helper/logger";
import { extractKey, isAdminKey, resolveCaller } from "./lib/auth";
import { dashboard } from "./modules/dashboard";
import { groups } from "./modules/groups";
import { resumeInvites } from "./modules/groups/service";
import { messaging } from "./modules/messaging";
import { loggerPlugin } from "./plugins/logger";
import { client1, client2, projectSenders, wagatePlugin } from "./plugins/wagate";

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
        for (const sender of projectSenders.clients.values()) {
          await sender.clearChat(client2.phoneNumber);
          await client2.clearChat(sender.phoneNumber);
        }
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
              method: "POST",
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
  .use(dashboard)
  .get("/qr", async ({ request, set }) => {
    if (!isAdminKey(extractKey(request, true))) {
      set.status = 401;
      set.headers["cache-control"] = "no-store";
      return { status: "error", code: 401, message: "Unauthorized" };
    }
    set.headers["content-type"] = "text/html; charset=utf-8";
    set.headers["cache-control"] = "no-store";
    const slots = [
      { label: "Client 1 (Main Account)", client: client1 },
      { label: "Client 2 (Pendamping Warm-up)", client: client2 },
      ...[...projectSenders.clients].map(([id, client]) => ({ label: `Project: ${id}`, client })),
    ];
    const imgs = await Promise.all(
      slots.map((s) => (s.client.qrCode ? QRCode.toDataURL(s.client.qrCode, { width: 300 }) : null)),
    );

    if (!imgs.some(Boolean)) {
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#eee;">
        <h2>Status QR WhatsApp</h2>
        <p style="color:#aaa;">Belum ada QR Code (mungkin bot sudah terhubung / connected).</p>
      </body></html>`;
    }

    const cards = slots
      .map(
        (s, i) => `<div>
            <h3>${s.label}</h3>
            ${imgs[i] ? `<img src="${imgs[i]}" style="border:10px solid white;border-radius:10px;" />` : `<p style="color:#4CAF50;font-weight:bold;">✅ Terhubung (${s.client.phoneNumber || "connected"})</p>`}
          </div>`,
      )
      .join("");

    return `<!DOCTYPE html><html>
      <head>
        <title>Scan QR WhatsApp Gateway</title>
        <meta http-equiv="refresh" content="5">
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:30px;background:#111;color:#eee;">
        <h2>Scan QR Code WhatsApp Gateway</h2>
        <p style="color:#aaa;font-size:14px;">Halaman ini akan diperbarui otomatis setiap 5 detik.</p>
        <div style="display:flex;justify-content:center;gap:40px;flex-wrap:wrap;margin-top:20px;">${cards}</div>
      </body>
    </html>`;
  })
  .onBeforeHandle({ as: "global" }, ({ set }) => {
    // Cache-control header (replaces Express CacheMiddleware)
    set.headers["cache-control"] = "no-store";
  })
  .group("/api/v1", (app) =>
    app
      .onBeforeHandle(({ request, set }) => {
        const caller = resolveCaller(extractKey(request));
        if (!caller) {
          set.status = 401;
          return { status: "error", code: 401, message: "Unauthorized" };
        }
        // A project key may only send; groups/invites stay admin-only.
        if (!caller.admin && !/\/api\/v1\/send(\/|$)/.test(new URL(request.url).pathname)) {
          set.status = 403;
          return { status: "error", code: 403, message: "Forbidden" };
        }
      })
      .get("/", () => ({ message: "REST API is working" }))
      .use(messaging)
      .use(groups),
  )
  .listen(env.PORT);

// ─── Startup ─────────────────────────────────────────────────────
logger.info(`🚀 Server running on port ${env.PORT}`);
if (env.DRY_RUN) logger.warn("🧪 DRY_RUN=true — NO messages will be sent to WhatsApp");

(async () => {
  try {
    logger.info("═══════════════════════════════════════════════");
    logger.info("[startup] Initializing Client 1 & Client 2 concurrently...");
    logger.info("═══════════════════════════════════════════════");
    const init1 = client1
      .init()
      .catch((e) => logger.error(`[startup] Client 1 init error: ${e}`));
    const init2 = client2
      .init()
      .catch((e) => logger.error(`[startup] Client 2 init error: ${e}`));

    // Resume queued invitations as soon as the sender (Client 1) is ready —
    // don't wait for Client 2, which may be sitting on a QR scan.
    void init1.then(() => {
      if (client1.phoneNumber) resumeInvites(client1, client2);
    });

    await Promise.allSettled([init1, init2]);

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

    // Project senders start after the default pair (one Chromium each — avoids a CPU/RAM spike).
    for (const [id, sender] of projectSenders.clients) {
      logger.info(`[startup] Initializing project sender "${id}"...`);
      await sender.init().catch((e) => logger.error(`[startup] Project "${id}" init error: ${e}`));
      if (client2.phoneNumber) sender.partnerNumber = client2.phoneNumber;
      if (sender.partnerNumber) await sender.saveContact(sender.partnerNumber);
    }

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

// ─── Graceful shutdown ───────────────────────────────────────────
// Close both browsers cleanly so LocalAuth flushes the WhatsApp
// sessions to disk (a hard kill during a redeploy can lose them).
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[shutdown] ${signal} received — closing WhatsApp clients...`);

  const timeout = new Promise((resolve) => setTimeout(resolve, 20_000));
  await Promise.race([
    Promise.allSettled([client1, client2, ...projectSenders.clients.values()].map((c) => c.client.destroy())),
    timeout,
  ]);

  logger.info("[shutdown] ✅ Done");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
