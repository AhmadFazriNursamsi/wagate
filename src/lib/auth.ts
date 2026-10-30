import { timingSafeEqual } from "node:crypto";

import env from "../../env";
import { client1, projectSenders } from "../plugins/wagate";
import { findProjectByKey, type Project } from "./projects";
import type { WagateClient } from "./wwebjs";

// ─── Caller identification ───────────────────────────────────────
// SECRET_KEY = admin (default sender + dashboard/groups). A project key
// can only send, and always through that project's own number.
// ─────────────────────────────────────────────────────────────────

const secretBuf = Buffer.from(env.SECRET_KEY);

export function isAdminKey(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const buf = Buffer.from(candidate);
  return buf.length === secretBuf.length && timingSafeEqual(buf, secretBuf);
}

export function extractKey(request: Request, allowQuery = false): string | null {
  const header =
    request.headers.get("x-api-key") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (header) return header;
  return allowQuery ? new URL(request.url).searchParams.get("key") : null;
}

export interface Caller {
  admin: boolean;
  /** "default" for the admin key, otherwise the project id. */
  projectId: string;
  sender: WagateClient;
}

export function resolveCaller(key: string | null | undefined): Caller | null {
  if (!key) return null;
  if (isAdminKey(key)) return { admin: true, projectId: "default", sender: client1 };
  const project: Project | null = findProjectByKey(key, projectSenders.projects);
  const sender = project && projectSenders.clients.get(project.id);
  return project && sender ? { admin: false, projectId: project.id, sender } : null;
}
