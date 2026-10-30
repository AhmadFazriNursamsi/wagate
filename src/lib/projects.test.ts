import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findProjectByKey, generateKey, hashKey, loadProjects, saveProjects } from "./projects";

const dirs: string[] = [];
const tmpFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "wagate-projects-"));
  dirs.push(dir);
  return join(dir, "data", "projects.json");
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("project registry", () => {
  test("file yang belum ada berarti tanpa project", () => {
    expect(loadProjects(tmpFile())).toEqual([]);
  });

  test("simpan lalu muat; file hanya berisi hash, bukan key, dan hanya pemilik yang bisa baca", async () => {
    const file = tmpFile();
    const key = generateKey();
    saveProjects([{ id: "catu", name: "CATU", keyHash: hashKey(key) }], file);
    expect(loadProjects(file)).toEqual([{ id: "catu", name: "CATU", keyHash: hashKey(key) }]);
    expect(Bun.file(file).size).toBeGreaterThan(0);
    expect(await Bun.file(file).text()).not.toContain(key);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  test("key dicocokkan ke project yang benar, key lain ditolak", () => {
    const [k1, k2] = [generateKey(), generateKey()];
    const projects = [
      { id: "catu", keyHash: hashKey(k1) },
      { id: "pukat", keyHash: hashKey(k2) },
    ];
    expect(findProjectByKey(k1, projects)?.id).toBe("catu");
    expect(findProjectByKey(k2, projects)?.id).toBe("pukat");
    expect(findProjectByKey(generateKey(), projects)).toBeNull();
    expect(findProjectByKey("", projects)).toBeNull();
  });

  test("id ganda dan id tidak valid ditolak", () => {
    const file = tmpFile();
    const h = hashKey("x");
    saveProjects([], file);
    writeFileSync(file, JSON.stringify([{ id: "catu", keyHash: h }, { id: "catu", keyHash: h }]));
    expect(() => loadProjects(file)).toThrow(/ganda/);
    writeFileSync(file, JSON.stringify([{ id: "Catu!", keyHash: h }]));
    expect(() => loadProjects(file)).toThrow();
  });
});
