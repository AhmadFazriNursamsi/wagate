import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// ─── Project registry ────────────────────────────────────────────
// Every project that uses the gateway gets its own WhatsApp sender number
// and its own API key. Only the SHA-256 of a key is stored on disk, so the
// file never holds a usable secret. Edit it with `bun run add-project`.
// ─────────────────────────────────────────────────────────────────

const ProjectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,24}$/, "id: huruf kecil, angka, tanda minus (2-24 karakter)"),
  name: z.string().optional(),
  displayName: z.string().optional(),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type Project = z.infer<typeof ProjectSchema>;

export const projectsFile = () => process.env.PROJECTS_FILE || "data/projects.json";

/** LocalAuth client id; the session lives in .wwebjs_auth/session-<clientId>. */
export const clientIdFor = (projectId: string) => `project-${projectId}`;

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function generateKey(): string {
  return randomBytes(32).toString("hex");
}

export function loadProjects(file = projectsFile()): Project[] {
  if (!existsSync(file)) return [];
  const parsed = z.array(ProjectSchema).safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} tidak valid: ${parsed.error.message}`);
  const ids = new Set<string>();
  for (const p of parsed.data) {
    if (ids.has(p.id)) throw new Error(`${file}: id project ganda "${p.id}"`);
    ids.add(p.id);
  }
  return parsed.data;
}

export function saveProjects(projects: Project[], file = projectsFile()) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(projects, null, 2) + "\n", { mode: 0o600 });
}

/** Constant-time lookup: compares hashes, so the comparison leaks nothing about the key. */
export function findProjectByKey(key: string, projects: Project[]): Project | null {
  const candidate = Buffer.from(hashKey(key));
  let found: Project | null = null;
  for (const p of projects) {
    if (timingSafeEqual(candidate, Buffer.from(p.keyHash))) found = p;
  }
  return found;
}
