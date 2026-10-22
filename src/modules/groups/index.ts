import { Elysia } from "elysia";

import env from "../../../env";
import { randomInt } from "../../helper/organic";
import { Orchestrator } from "../messaging/orchestrator";
import { wagatePlugin } from "../../plugins/wagate";
import { inviteBody } from "./model";

// ─── Groups Controller ───────────────────────────────────────────
// GET  /groups         — groups of WA1 (to find the groupId)
// POST /groups/invite  — send the group invite link to many numbers
//
// Each recipient gets a normal text message through the Orchestrator,
// so the same anti-ban pacing/queue applies. Numbers already in the
// group are skipped. WA1 must be an admin of the group.
// ─────────────────────────────────────────────────────────────────

const TEMPLATES = [
  "Halo, kami undang kamu bergabung di grup kami: {link}",
  "Hai! Ini link untuk masuk ke grup kami {link}",
  "Silakan gabung grup kami lewat link ini ya: {link}",
  "Halo, kalau berminat bergabung, ini link grupnya: {link}",
  "Kami mengundang kamu ke grup. Klik untuk bergabung: {link}",
];

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
  .post(
    "/invite",
    async ({ body, wa1, wa2, set }) => {
      if (!wa1.phoneNumber) {
        set.status = 503;
        return { status: "error", code: 503, message: "Client 1 is not ready" };
      }

      let info;
      try {
        info = await wa1.getGroupInvite(body.groupId, body.inviteLink);
      } catch (e: any) {
        set.status = 400;
        return {
          status: "error",
          code: 400,
          message: e?.message ?? "Could not get invite link",
        };
      }

      const unique = [...new Set(body.numbers)];
      const targets = unique.filter((n) => !info.members.has(n));

      for (const number of targets) {
        const template = body.message
          ? body.message.includes("{link}")
            ? body.message
            : `${body.message} {link}`
          : TEMPLATES[randomInt(0, TEMPLATES.length - 1)];

        Orchestrator.dispatch(wa1, wa2, {
          content: template.replaceAll("{link}", info.link),
          number,
        });
      }

      // Rough ETA: fixed delay + typing + overhead per message
      const perMsgMs =
        env.SEND_DELAY_MIN_MS +
        env.SEND_DELAY_RANGE_MS / 2 +
        (env.TYPING_MIN_MS + env.TYPING_MAX_MS) / 2 +
        1500;

      return {
        status: "success",
        code: 200,
        message: "Invitations queued for delivery",
        data: {
          group: info.name,
          requested: body.numbers.length,
          duplicates: body.numbers.length - unique.length,
          alreadyInGroup: unique.length - targets.length,
          queued: targets.length,
          estimatedMinutes: Math.ceil((targets.length * perMsgMs) / 60000),
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
