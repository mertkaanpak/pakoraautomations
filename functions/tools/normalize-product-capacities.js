const admin = require("../node_modules/firebase-admin");
const serviceAccount = require("../../serviceAccountKey.json");

const databaseURL = "https://pakora-automations-chat-default-rtdb.europe-west1.firebasedatabase.app";
const shouldWrite = process.argv.includes("--write");

function normalizeCapacity(value) {
  const numeric = Number(value || 0);
  if (!numeric) return 0;
  return numeric > 0 && numeric < 100 ? Math.round(numeric * 1000) : Math.round(numeric);
}

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL
    });
  }

  const snapshot = await admin.database().ref("/products").get();
  const products = snapshot.exists() ? snapshot.val() : {};
  const updates = {};
  let changed = 0;

  Object.entries(products).forEach(([key, product]) => {
    const nextNK = normalizeCapacity(product.capacityNK);
    const nextTK = normalizeCapacity(product.capacityTK);
    if (nextNK === Number(product.capacityNK || 0) && nextTK === Number(product.capacityTK || 0)) {
      return;
    }
    updates[`/products/${key}/capacityNK`] = nextNK;
    updates[`/products/${key}/capacityTK`] = nextTK;
    changed++;
  });

  console.log(JSON.stringify({
    total: Object.keys(products).length,
    changed,
    mode: shouldWrite ? "write" : "dry-run"
  }, null, 2));

  if (shouldWrite && changed) {
    await admin.database().ref().update(updates);
    console.log(`Normalized capacities for ${changed} products.`);
  }
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
