import { Elysia, t } from "elysia";

import env from "../../../env";
import { randomInt } from "../../helper/organic";
import { orchestratorState } from "../messaging/orchestrator";
import { wagatePlugin } from "../../plugins/wagate";
import { inviteBody } from "./model";
import { enqueueInvite } from "./service";
import { inviteEvents, inviteStore, type InviteRow } from "./store";

// ─── Groups Controller ───────────────────────────────────────────
// GET  /groups         — groups of WA1 (to find the groupId)
// POST /groups/invite  — send the group invite link to many numbers
//
// Each recipient gets a normal text message through the Orchestrator,
// so the same anti-ban pacing/queue applies. Numbers already in the
// group are skipped. WA1 must be an admin of the group.
// ─────────────────────────────────────────────────────────────────

const TEMPLATES = [
  "Salam sejahtera, Bapak/Ibu 🙏\n\nKami dari Admin PUKAT (Profesional dan Usahawan Katolik) dengan hormat mengundang Anda untuk bergabung di grup komunitas PUKAT. Jika berkenan, silakan masuk melalui tautan berikut:\n{link}\n\nTerima kasih, Tuhan memberkati.",
  "Selamat siang, semoga Bapak/Ibu dalam keadaan baik. Kami dari Admin PUKAT (Profesional dan Usahawan Katolik) ingin mengundang Anda bergabung ke grup komunitas kami untuk berbagi informasi dan saling terhubung. Berikut tautannya: {link}\n\nJika kurang berkenan, mohon abaikan pesan ini. Terima kasih 🙏",
  "Halo, mohon maaf mengganggu waktunya. Kami Admin PUKAT, komunitas Profesional dan Usahawan Katolik, dengan hormat mengundang Anda untuk bergabung di grup kami: {link}\n\nTerima kasih atas perhatiannya.",
  "Salam dari Admin PUKAT 👋\n\nKami mengundang Anda masuk ke grup komunitas Profesional dan Usahawan Katolik (PUKAT). Silakan bergabung lewat tautan ini bila berminat: {link}\n\nTuhan memberkati.",
  "Halo, semoga harinya menyenangkan. Kami Admin PUKAT (Profesional dan Usahawan Katolik) dengan senang hati mengundang Anda bergabung di grup komunitas kami: {link}\n\nBila ada pertanyaan, silakan balas pesan ini. Terima kasih 🙏",
];

// Rough per-message time: fixed delay + typing + orchestration overhead
function perMessageMs() {
  return (
    env.SEND_DELAY_MIN_MS +
    env.SEND_DELAY_RANGE_MS / 2 +
    (env.TYPING_MIN_MS + env.TYPING_MAX_MS) / 2 +
    1500
  );
}

const publicRow = (r: InviteRow) => ({
  number: r.number,
  status: r.status,
  error: r.error,
  attempts: r.attempts,
  queuedAt: r.queued_at,
  updatedAt: r.updated_at,
});

function resolveGroupId(groupId?: string) {
  return groupId ?? env.INVITE_GROUP_ID;
}

export const groups = new Elysia({ prefix: "/groups" })
  .use(wagatePlugin)
  .get(
    "/",
    async ({ wa1, set }) => {
      if (!wa1.phoneNumber) {
        set.status = 503;
        return { status: "error", code: 503, message: "Client 1 is not ready" };
      }
      return { status: "success", code: 200, data: await wa1.listGroups() };
    },
    { detail: { summary: "List groups of Client 1", tags: ["Groups"] } },
  )
  .get(
    "/invite/status",
    ({ query, set }) => {
      const groupId = resolveGroupId(query.groupId);
      if (!groupId) {
        set.status = 400;
        return { status: "error", code: 400, message: "groupId is required" };
      }
      return {
        status: "success",
        code: 200,
        data: {
          groupId,
          summary: inviteStore.summary(groupId),
          failed: inviteStore
            .failed(groupId)
            .map((r) => ({ number: r.number, error: r.error, attempts: r.attempts })),
        },
      };
    },
    {
      query: t.Object({ groupId: t.Optional(t.String()) }),
      detail: { summary: "Invitation ledger summary for a group", tags: ["Groups"] },
    },
  )
  // Realtime feed (Server-Sent Events): a full snapshot on connect, then one
  // "row" event per change and a "status" heartbeat every 5 s.
  .get(
    "/invite/stream",
    ({ query, wa1, wa2, set }) => {
      const groupId = resolveGroupId(query.groupId);
      if (!groupId) {
        set.status = 400;
        return { status: "error", code: 400, message: "groupId is required" };
      }

      const enc = new TextEncoder();
      let cleanup = () => {};

      const stream = new ReadableStream({
        start(controller) {
          const send = (event: string, data: unknown) => {
            try {
              controller.enqueue(
                enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              );
            } catch {
              cleanup();
            }
          };
          const status = () => ({
            dryRun: env.DRY_RUN,
            groupId,
            perMessageSeconds: Math.round(perMessageMs() / 1000),
            client1: wa1.phoneNumber || null,
            client2: wa2.phoneNumber || null,
            warming: orchestratorState.warming,
            waitingForClients: orchestratorState.waitingForClients,
          });

          send("snapshot", {
            ...status(),
            summary: inviteStore.summary(groupId),
            rows: inviteStore.all(groupId).map(publicRow),
          });

          const onChange = (row: InviteRow | null) => {
            if (!row || row.group_id !== groupId) return;
            send("row", {
              row: publicRow(row),
              summary: inviteStore.summary(groupId),
            });
          };
          const onRemove = (r: { group_id: string; number: string }) => {
            if (r.group_id !== groupId) return;
            send("removed", {
              number: r.number,
              summary: inviteStore.summary(groupId),
            });
          };
          inviteEvents.on("change", onChange);
          inviteEvents.on("remove", onRemove);
          const heartbeat = setInterval(() => send("status", status()), 5_000);

          cleanup = () => {
            clearInterval(heartbeat);
            inviteEvents.off("change", onChange);
            inviteEvents.off("remove", onRemove);
          };
        },
        cancel() {
          cleanup();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    },
    {
      query: t.Object({ groupId: t.Optional(t.String()) }),
      detail: { summary: "Realtime invitation ledger (SSE)", tags: ["Groups"] },
    },
  )
  // The built-in message templates ({link} is replaced when sending)
  .get(
    "/invite/templates",
    () => ({
      status: "success",
      code: 200,
      data: { templates: TEMPLATES, link: env.INVITE_LINK ?? null },
    }),
    { detail: { summary: "Built-in invite message templates", tags: ["Groups"] } },
  )
  // Remove numbers from the ledger. Queued numbers are cancelled; numbers
  // being sent right now are left alone.
  .post(
    "/invite/remove",
    ({ body, set }) => {
      const groupId = resolveGroupId(body.groupId);
      if (!groupId) {
        set.status = 400;
        return { status: "error", code: 400, message: "groupId is required" };
      }
      let removed = 0;
      let skippedSending = 0;
      let notFound = 0;
      for (const number of new Set(body.numbers)) {
        const row = inviteStore.get(groupId, number);
        if (!row) notFound++;
        else if (row.status === "sending") skippedSending++;
        else if (inviteStore.remove(groupId, number)) removed++;
      }
      return {
        status: "success",
        code: 200,
        data: { removed, skippedSending, notFound },
      };
    },
    {
      body: t.Object({
        groupId: t.Optional(t.String()),
        numbers: t.Array(t.String({ pattern: "^[0-9]{10,15}$" }), {
          minItems: 1,
          maxItems: 5000,
        }),
      }),
      detail: { summary: "Remove / cancel numbers", tags: ["Groups"] },
    },
  )
  .post(
    "/invite",
    async ({ body, wa1, wa2, set }) => {
      const groupId = resolveGroupId(body.groupId);
      const inviteLink = body.inviteLink ?? env.INVITE_LINK;
      if (!groupId) {
        set.status = 400;
        return {
          status: "error",
          code: 400,
          message: "groupId is required (or set INVITE_GROUP_ID)",
        };
      }
      if (!env.DRY_RUN && !wa1.phoneNumber) {
        set.status = 503;
        return { status: "error", code: 503, message: "Client 1 is not ready" };
      }

      let info;
      try {
        info = env.DRY_RUN
          ? {
              name: "(dry run)",
              link: inviteLink ?? "https://chat.whatsapp.com/DRYRUN",
              members: new Set<string>(),
            }
          : await wa1.getGroupInvite(groupId, inviteLink);
      } catch (e: any) {
        set.status = 400;
        return {
          status: "error",
          code: 400,
          message: e?.message ?? "Could not get invite link",
        };
      }

      const custom = (body.messages ?? (body.message ? [body.message] : []))
        .map((m) => m.trim())
        .filter(Boolean);
      const customPool = custom.length ? custom : null;

      const unique = [...new Set(body.numbers)];
      let alreadyInGroup = 0;
      let alreadySent = 0;
      let alreadyQueued = 0;
      let retriedFailed = 0;
      let resent = 0;
      let queued = 0;

      for (const number of unique) {
        if (info.members.has(number)) {
          alreadyInGroup++;
          continue;
        }

        // Anti double-send: skip anything already sent or still queued
        const prev = inviteStore.get(groupId, number);
        if (prev) {
          // Never double-queue something already waiting, even with force
          if (prev.status === "queued" || prev.status === "sending") {
            alreadyQueued++;
            continue;
          }
          if (prev.status === "sent") {
            if (!body.force) {
              alreadySent++;
              continue;
            }
            resent++; // explicit resend of a delivered invite
          } else {
            retriedFailed++; // previously failed -> try again
          }
        }

        // Custom variants if given, otherwise the built-in templates
        const pool = customPool ?? TEMPLATES;
        const template = pool[randomInt(0, pool.length - 1)];
        // Custom messages are sent as written: the link only appears where
        // the author put {link}. Built-in templates all contain it.
        const content = template.replaceAll("{link}", info.link);

        inviteStore.queue(groupId, number, content);
        enqueueInvite(wa1, wa2, groupId, number, content);
        queued++;
      }

      return {
        status: "success",
        code: 200,
        message: "Invitations queued for delivery",
        data: {
          group: info.name,
          requested: body.numbers.length,
          duplicates: body.numbers.length - unique.length,
          alreadyInGroup,
          alreadySent,
          alreadyQueued,
          retriedFailed,
          resent,
          queued,
          customMessage: customPool ? customPool.length : 0,
          estimatedMinutes: Math.ceil((queued * perMessageMs()) / 60000),
        },
      };
    },
    {
      body: inviteBody,
      detail: {
        summary: "Send group invite link to many numbers",
        tags: ["Groups"],
      },
    },
  );
