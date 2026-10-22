import { t } from "elysia";

export const inviteBody = t.Object({
  // Optional: defaults to INVITE_GROUP_ID from the environment.
  groupId: t.Optional(
    t.String({
      pattern: "^[0-9-]+@g\\.us$",
      error: "groupId must look like 1203630xxxxxxxx@g.us — see GET /api/v1/groups",
    }),
  ),
  numbers: t.Array(
    t.String({
      minLength: 10,
      maxLength: 15,
      pattern: "^[0-9]+$",
      error: "Phone number is not valid! Format: 62...",
    }),
    { minItems: 1, maxItems: 5000 },
  ),
  // Group invite link. Optional: defaults to INVITE_LINK, else the server tries to fetch it.
  inviteLink: t.Optional(
    t.String({
      pattern: "^https://chat\\.whatsapp\\.com/[A-Za-z0-9]+$",
      error: "inviteLink must look like https://chat.whatsapp.com/XXXX",
    }),
  ),
  // Resend to numbers already marked sent. Never overrides queued/sending.
  force: t.Optional(t.Boolean()),
  // Several custom variants; one is picked at random per recipient.
  // Takes priority over `message`.
  messages: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 4000 }), { minItems: 1, maxItems: 20 }),
  ),
  // Optional single custom message. Sent exactly as written; `{link}` (if present)
  // is replaced with the invite link, otherwise no link is added.
  // If omitted, a random built-in variant is used per recipient.
  message: t.Optional(t.String({ minLength: 1 })),
});

export type InviteBody = typeof inviteBody.static;
