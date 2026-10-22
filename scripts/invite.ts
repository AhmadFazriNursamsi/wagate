// Send the group invite link to every number in broadcast/numbers.txt.
//
//   bun run invite             -> dry run (shows what would be sent)
//   bun run invite --send      -> actually queue the invitations
//   bun run invite --file=path -> use another numbers file
//   bun run invite --status    -> show sent/queued/failed counts from the server
//   bun run invite --send --force -> also resend to numbers already sent
//
// Env: API_URL (default http://localhost:3000), INVITE_GROUP_ID, INVITE_LINK (from .env)

import { readFileSync } from "node:fs";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
// Defaults come from .env (INVITE_GROUP_ID / INVITE_LINK) so no group link is
// ever committed to the repository.
const GROUP_ID = process.env.GROUP_ID ?? process.env.INVITE_GROUP_ID;
const RAW_LINK = process.env.INVITE_LINK ?? "";
if (!GROUP_ID) {
  console.error("Set INVITE_GROUP_ID di .env (atau GROUP_ID=... saat menjalankan).");
  process.exit(1);
}
const fileArg = process.argv.find((a) => a.startsWith("--file="))?.slice(7);
const FILE = fileArg
  ? new URL(fileArg, `file://${process.cwd()}/`)
  : new URL("../broadcast/numbers.txt", import.meta.url);
const send = process.argv.includes("--send");
const force = process.argv.includes("--force");
const statusOnly = process.argv.includes("--status");

// Keep only https://chat.whatsapp.com/<code> (drop tracking params)
const inviteLink = RAW_LINK.replace(/[?#].*$/, "");

if (statusOnly) {
  const key = process.env.SECRET_KEY;
  if (!key) {
    console.error("SECRET_KEY tidak ditemukan (cek .env).");
    process.exit(1);
  }
  const r = await fetch(
    `${API_URL}/api/v1/groups/invite/status?groupId=${encodeURIComponent(GROUP_ID)}`,
    { headers: { "x-api-key": key } },
  );
  const j: any = await r.json();
  console.log(`Group: ${GROUP_ID}`);
  console.log(JSON.stringify(j.data?.summary ?? j, null, 2));
  for (const f of j.data?.failed ?? []) {
    console.log(`  gagal: ${f.number} — ${f.error} (percobaan: ${f.attempts})`);
  }
  process.exit(0);
}

function normalize(raw: string): string | null {
  let n = raw.replace(/\D/g, "");
  if (n.startsWith("0")) n = "62" + n.slice(1);
  else if (n.startsWith("8")) n = "62" + n;
  return /^[0-9]{10,15}$/.test(n) ? n : null;
}

const valid = new Set<string>();
const invalid: string[] = [];
let lines = 0;
for (const line of readFileSync(FILE, "utf8").split(/\r?\n/)) {
  const text = line.replace(/#.*/, "").trim();
  if (!text) continue;
  lines++;
  const n = normalize(text);
  if (n) valid.add(n);
  else invalid.push(text);
}
const numbers = [...valid];

console.log(`Group      : ${GROUP_ID}`);
console.log(`Link       : ${inviteLink || "(dari server / INVITE_LINK)"}`);
console.log(`Baris nomor: ${lines}`);
console.log(`Valid unik : ${numbers.length} (dobel dibuang: ${lines - invalid.length - numbers.length})`);
if (invalid.length) {
  console.log(`Tidak valid (${invalid.length}), dilewati:`);
  for (const x of invalid.slice(0, 20)) console.log(`  - ${x}`);
  if (invalid.length > 20) console.log(`  ... dan ${invalid.length - 20} lainnya`);
}

if (!numbers.length) {
  console.log("\nTidak ada nomor. Isi broadcast/numbers.txt dulu.");
  process.exit(1);
}
if (!send) {
  console.log("\nDRY RUN — belum ada yang dikirim. Jalankan dengan --send untuk mengirim.");
  process.exit(0);
}

const key = process.env.SECRET_KEY;
if (!key) {
  console.error("SECRET_KEY tidak ditemukan (cek .env).");
  process.exit(1);
}

const res = await fetch(`${API_URL}/api/v1/groups/invite`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": key },
  body: JSON.stringify({
    groupId: GROUP_ID,
    ...(inviteLink ? { inviteLink } : {}),
    numbers,
    force,
  }),
});
console.log(`\nHTTP ${res.status}`);
console.log(JSON.stringify(await res.json(), null, 2));
