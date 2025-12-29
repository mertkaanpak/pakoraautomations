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
    const dedupeDeletes = [];
    const tokenIndex = new Map();
    tokensSnap.forEach((doc) => {
      if (!doc.id) return;
      const data = doc.data() || {};
      const deviceId = data.deviceId || "";
      const updatedAt = data.updatedAt && data.updatedAt.toMillis ? data.updatedAt.toMillis() : 0;
      const userId = data.userId || "";
      const platform = data.platform || "";
      const userAgent = data.userAgent || "";
      const dedupeKey = deviceId
        ? `device:${deviceId}`
        : `ua:${userId}|${platform}|${userAgent}`;

      const existing = tokenIndex.get(dedupeKey);
      if (!existing || updatedAt > existing.updatedAt) {
        if (existing) {
          dedupeDeletes.push(admin.firestore().collection("pushTokens").doc(existing.token).delete());
        }
        tokenIndex.set(dedupeKey, { token: doc.id, updatedAt });
      } else {
        dedupeDeletes.push(admin.firestore().collection("pushTokens").doc(doc.id).delete());
      }
    });

    tokenIndex.forEach((value) => tokens.push(value.token));

    if (!tokens.length) return null;

    let response;
    try {
      response = await admin.messaging().sendEachForMulticast({
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
    } catch (error) {
      await admin.firestore().collection("pushLogs").add({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        messageId: snap.id,
        senderId,
        senderLabel,
        text,
        tokensCount: tokens.length,
        successCount: 0,
        failureCount: tokens.length,
        errorCode: error && error.code ? error.code : null,
        errorMessage: error && error.message ? error.message : String(error)
      });
      return null;
    }

    const deletes = [...dedupeDeletes];
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

exports.notifyOnImportantNote = functions.firestore
  .document("importantNotes/{noteId}")
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    const senderLabel = data.userLabel || "Unbekannt";
    const senderId = data.userId || "";
    const text = data.text || "Wichtiger Hinweis";

    const tokensSnap = await admin.firestore().collection("pushTokens").get();
    if (tokensSnap.empty) {
      await admin.firestore().collection("pushLogs").add({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        type: "note",
        noteId: snap.id,
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
    const dedupeDeletes = [];
    const tokenIndex = new Map();
    tokensSnap.forEach((doc) => {
      if (!doc.id) return;
      const tokenData = doc.data() || {};
      const deviceId = tokenData.deviceId || "";
      const updatedAt = tokenData.updatedAt && tokenData.updatedAt.toMillis ? tokenData.updatedAt.toMillis() : 0;
      const userId = tokenData.userId || "";
      const platform = tokenData.platform || "";
      const userAgent = tokenData.userAgent || "";
      const dedupeKey = deviceId
        ? `device:${deviceId}`
        : `ua:${userId}|${platform}|${userAgent}`;

      const existing = tokenIndex.get(dedupeKey);
      if (!existing || updatedAt > existing.updatedAt) {
        if (existing) {
          dedupeDeletes.push(admin.firestore().collection("pushTokens").doc(existing.token).delete());
        }
        tokenIndex.set(dedupeKey, { token: doc.id, updatedAt });
      } else {
        dedupeDeletes.push(admin.firestore().collection("pushTokens").doc(doc.id).delete());
      }
    });

    tokenIndex.forEach((value) => tokens.push(value.token));

    if (!tokens.length) return null;

    let response;
    try {
      response = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: {
          title: `Wichtiger Hinweis von ${senderLabel}`,
          body: text
        },
        data: {
          senderId,
          senderLabel,
          noteId: snap.id
        },
        webpush: {
          fcmOptions: {
            link: "https://pakora-automations-chat.web.app/kommunikation.html"
          }
        }
      });
    } catch (error) {
      await admin.firestore().collection("pushLogs").add({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        type: "note",
        noteId: snap.id,
        senderId,
        senderLabel,
        text,
        tokensCount: tokens.length,
        successCount: 0,
        failureCount: tokens.length,
        errorCode: error && error.code ? error.code : null,
        errorMessage: error && error.message ? error.message : String(error)
      });
      return null;
    }

    const deletes = [...dedupeDeletes];
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
      type: "note",
      noteId: snap.id,
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
