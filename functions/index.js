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
    if (tokensSnap.empty) {
      await admin.firestore().collection("pushLogs").add({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        messageId: snap.id,
        senderId,
        senderLabel,
        text,
        tokensCount: 0,
        successCount: 0,
        failureCount: 0,
        note: "no tokens"
      });
      return null;
    }

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
    const results = response.responses.map((resp, idx) => {
      if (!resp.success && resp.error) {
        const code = resp.error.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
          deletes.push(admin.firestore().collection("pushTokens").doc(tokens[idx]).delete());
        }
      }
      return {
        token: tokens[idx],
        success: resp.success,
        errorCode: resp.error ? resp.error.code : null,
        errorMessage: resp.error ? resp.error.message : null
      };
    });

    await admin.firestore().collection("pushLogs").add({
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      messageId: snap.id,
      senderId,
      senderLabel,
      text,
      tokensCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      results
    });

    return Promise.all(deletes);
  });
