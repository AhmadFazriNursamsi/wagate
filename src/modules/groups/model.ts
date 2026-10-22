import { t } from "elysia";

export const inviteBody = t.Object({
  groupId: t.String({
    pattern: "^[0-9-]+@g\\.us$",
    error: "groupId must look like 1203630xxxxxxxx@g.us — see GET /api/v1/groups",
  }),
  numbers: t.Array(
    t.String({
      minLength: 10,
      maxLength: 15,
      pattern: "^[0-9]+$",
      error: "Phone number is not valid! Format: 62...",
    }),
    { minItems: 1, maxItems: 5000 },
  ),
  // Group invite link. Optional: if omitted the server tries to fetch it.
  inviteLink: t.Optional(
    t.String({
      pattern: "^https://chat\\.whatsapp\\.com/[A-Za-z0-9]+$",
      error: "inviteLink must look like https://chat.whatsapp.com/XXXX",
    }),
  ),
  // Optional template; `{link}` is replaced with the invite link.
  // If omitted, a random built-in variant is used per recipient.
  message: t.Optional(t.String({ minLength: 1 })),
});

export type InviteBody = typeof inviteBody.static;
