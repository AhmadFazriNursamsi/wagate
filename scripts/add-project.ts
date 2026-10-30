import { clientIdFor, generateKey, hashKey, loadProjects, projectsFile, saveProjects } from "../src/lib/projects";

// Usage: bun run add-project <id> [nama] [--rotate]
//   <id>      huruf kecil/angka/minus, mis. "catu"
//   --rotate  buat API key baru untuk project yang sudah ada (key lama langsung tidak berlaku)
// The API key is printed once; only its hash is stored in data/projects.json.

const args = process.argv.slice(2);
const rotate = args.includes("--rotate");
const [id, name] = args.filter((a) => !a.startsWith("--"));

if (!id) {
  console.error("Usage: bun run add-project <id> [nama] [--rotate]");
  process.exit(1);
}

const projects = loadProjects();
const existing = projects.find((p) => p.id === id);
if (existing && !rotate) {
  console.error(`Project "${id}" sudah ada. Pakai --rotate untuk membuat API key baru.`);
  process.exit(1);
}
if (!existing && rotate) {
  console.error(`Project "${id}" belum ada.`);
  process.exit(1);
}

const key = generateKey();
if (existing) existing.keyHash = hashKey(key);
else projects.push({ id, name: name || id, keyHash: hashKey(key) });
saveProjects(projects);

console.log(`Project "${id}" ${existing ? "dirotasi" : "ditambahkan"} → ${projectsFile()}`);
console.log("");
console.log("API key (hanya ditampilkan sekali — simpan sekarang):");
console.log(key);
console.log("");
console.log(`Sesi WhatsApp: .wwebjs_auth/session-${clientIdFor(id)}`);
console.log("Restart WAGate lalu scan QR project ini di /qr?key=<SECRET_KEY>");
