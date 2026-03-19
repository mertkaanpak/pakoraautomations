const admin = require("../node_modules/firebase-admin");
const serviceAccount = require("../../serviceAccountKey.json");

const databaseURL = "https://pakora-automations-chat-default-rtdb.europe-west1.firebasedatabase.app";

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL
    });
  }

  await admin.database().ref().update({
    "/products": null,
    "/catalog": null,
    "/stock": null
  });

  console.log("Cleared /products, /catalog and /stock.");
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
