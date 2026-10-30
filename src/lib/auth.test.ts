import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKey, hashKey, saveProjects } from "./projects";

// Env and the projects file must be in place before the plugin module is first loaded.
const dir = mkdtempSync(join(tmpdir(), "wagate-auth-"));
const catuKey = generateKey();
const pukatKey = generateKey();
saveProjects(
  [
    { id: "catu", keyHash: hashKey(catuKey) },
    { id: "pukat", keyHash: hashKey(pukatKey) },
  ],
  join(dir, "projects.json"),
);
process.env.PROJECTS_FILE = join(dir, "projects.json");
process.env.NODE_ENV = "development"; // bun test sets "test", which env.ts rejects
process.env.SECRET_KEY = "s".repeat(40);

const { resolveCaller } = await import("./auth");
const { client1 } = await import("../plugins/wagate");

test("admin key → nomor default; key project → nomor project masing-masing", () => {
  const admin = resolveCaller("s".repeat(40))!;
  expect(admin).toMatchObject({ admin: true, projectId: "default" });
  expect(admin.sender).toBe(client1);

  const catu = resolveCaller(catuKey)!;
  const pukat = resolveCaller(pukatKey)!;
  expect(catu).toMatchObject({ admin: false, projectId: "catu" });
  expect(catu.sender.clientId).toBe("project-catu");
  expect(pukat.sender.clientId).toBe("project-pukat");
  expect(catu.sender).not.toBe(pukat.sender);
  expect(catu.sender).not.toBe(client1);
});

test("key asing, kosong, atau null ditolak", () => {
  expect(resolveCaller(generateKey())).toBeNull();
  expect(resolveCaller("")).toBeNull();
  expect(resolveCaller(null)).toBeNull();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
