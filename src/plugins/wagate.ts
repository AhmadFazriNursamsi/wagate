import { Elysia } from "elysia";

import env from "../../env";
import { clientIdFor, loadProjects } from "../lib/projects";
import { WagateClient } from "../lib/wwebjs";

// ─── WagateClient Plugin ─────────────────────────────────────────
// Named plugin with two WhatsApp instances (anti-ban strategy).
//
// - wa1 (client-1): Main account — sends payload to destination
// - wa2 (client-2): Secondary — sends warm-up messages to wa1
//
// Each instance uses its own LocalAuth session (session-client-1/2).
// Partner numbers are cross-referenced for warm-up messaging.
// Projects (data/projects.json) add one sender each, warmed up via wa2.
// ─────────────────────────────────────────────────────────────────

const client1 = new WagateClient("client-1", env.WA2_NUMBER);
const client2 = new WagateClient("client-2", env.WA1_NUMBER);

export const wagatePlugin = new Elysia({ name: "wagate" })
  .decorate("wa1", client1)
  .decorate("wa2", client2);

// One extra sender per project (own number, own QR session). WA2 stays the
// shared warm-up partner for all of them.
const projects = loadProjects();
const clients = new Map<string, WagateClient>(
  projects.map((p) => {
    const c = new WagateClient(clientIdFor(p.id), "");
    c.displayName = p.displayName ?? p.name;
    return [p.id, c];
  }),
);
export const projectSenders = { projects, clients };

export { client1, client2 };
