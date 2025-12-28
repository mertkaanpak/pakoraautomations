const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

exports.notifyOnMessage = functions.firestore
  .document("messages/{messageId}")
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    const senderLabel = data.userLabel || "Unbekannt";
    const senderId = data.userId || "";
    const text = data.text || "Neue Nachricht";

    const tokensSnap = await admin.firestore().collection("pushTokens").get();
    if (tokensSnap.empty) return null;

    const tokens = [];
    tokensSnap.forEach((doc) => {
      if (doc.id) tokens.push(doc.id);
    });

    if (!tokens.length) return null;

    const response = await admin.messaging().sendMulticast({
      tokens,
      notification: {
        title: `Neue Nachricht von ${senderLabel}`,
        body: text
      },
      data: {
        senderId,
        senderLabel,
        messageId: snap.id
      },
      webpush: {
        fcmOptions: {
          link: "https://pakora-automations-chat.web.app/kommunikation.html"
        }
      }
    });

    const deletes = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error) {
        const code = resp.error.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
          deletes.push(admin.firestore().collection("pushTokens").doc(tokens[idx]).delete());
        }
      }
    });

    return Promise.all(deletes);
  });
