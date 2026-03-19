const fs = require("fs");
const path = require("path");
const admin = require("../node_modules/firebase-admin");
const serviceAccount = require("../../serviceAccountKey.json");

const databaseURL = "https://pakora-automations-chat-default-rtdb.europe-west1.firebasedatabase.app";
const seedArg = process.argv[2];

if (!seedArg) {
  console.error("Usage: node functions/tools/import-catalog-seed.js <seed-file>");
  process.exit(1);
}

function sanitizeKey(value) {
  return String(value || "").trim().replace(/[.#$/\[\]]/g, "_");
}

async function main() {
  const seedPath = path.resolve(process.cwd(), seedArg);
  const rows = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("Seed file is empty or invalid.");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL
    });
  }

  const updates = {};
  rows.forEach((row) => {
    const key = sanitizeKey(row.id || row.name);
    updates[key] = {
      id: String(row.id || "").trim(),
      name: String(row.name || "").trim(),
      manufacturer: String(row.manufacturer || "").trim(),
      refrigerant: String(row.refrigerant || "").trim(),
      color: String(row.color || "").trim(),
      category: String(row.category || "accessory").trim() || "accessory",
      price: Number(row.price || 0),
      capacityZero: Number(row.capacityZero || 0),
      capacityNK: Number(row.capacityNK || 0),
      capacityTK: Number(row.capacityTK || 0)
    };
  });

  await admin.database().ref("/catalog").update(updates);
  console.log(`Imported ${Object.keys(updates).length} catalog items from ${path.basename(seedPath)}.`);
}

main()
  .then(async () => {
    await Promise.all(admin.apps.map((app) => app.delete().catch(() => null)));
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await Promise.all(admin.apps.map((app) => app.delete().catch(() => null)));
    process.exit(1);
  });
