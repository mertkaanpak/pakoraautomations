const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

exports.notifyOnMessage = functions.firestore
  .document("messages/{messageId}")
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    const senderLabel = data.userLabel || "Unbekannt";
    const senderId = data.userId || data.user || "";
    const recipients = Array.isArray(data.recipients) ? data.recipients.filter(Boolean) : [];
    const hasRecipients = recipients.length > 0;
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

    const tokenEntries = [];
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
        tokenIndex.set(dedupeKey, { token: doc.id, updatedAt, userId });
      } else {
        dedupeDeletes.push(admin.firestore().collection("pushTokens").doc(doc.id).delete());
      }
    });

    tokenIndex.forEach((value) => tokenEntries.push(value));

    const filteredEntries = tokenEntries.filter((entry) => {
      if (!entry.userId) return false;
      if (senderId && entry.userId === senderId) return false;
      if (hasRecipients && !recipients.includes(entry.userId)) return false;
      return true;
    });
    const tokens = filteredEntries.map((entry) => entry.token);

    if (!tokens.length) {
      await admin.firestore().collection("pushLogs").add({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        messageId: snap.id,
        senderId,
        senderLabel,
        text,
        tokensCount: 0,
        successCount: 0,
        failureCount: 0,
        note: "no tokens after sender filter"
      });
      return null;
    }

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

exports.aiCompressorLookup = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const openAiKey = functions.config().openai && functions.config().openai.key;
  if (!openAiKey) {
    res.status(500).json({ error: "OpenAI key fehlt. Setze functions config openai.key." });
    return;
  }

  const body = req.body || {};
  const query = String(body.query || "").trim();
  const brand = String(body.brand || "").trim();
  const refrigerant = String(body.refrigerant || "").trim();
  const notes = String(body.notes || "").trim();

  if (!query) {
    res.status(400).json({ error: "Query fehlt." });
    return;
  }

  const promptParts = [
    "Du bist ein technischer Rechercheassistent fuer Verdichter.",
    "Suche im Web nach technischen Daten zum angegebenen Modell/Typ.",
    "Prioritaet: EN12900 Leistungsdaten bei Tc 45 C und Te -10 C sowie Te -25 C.",
    "Nutze diese Quellen zuerst (in dieser Reihenfolge), wenn vorhanden:",
    "1) Embraco: https://products.embraco.com/compressors",
    "2) Danfoss Coolselector2 (Berechnungs- und Auswahlsoftware)",
    "3) Tecumseh tselect: https://tselect.tecumseh.com/de/",
    "4) Bitzer Websoftware: https://www.bitzer.de/websoftware/",
    "Wenn die Quellen nicht direkt zugaenglich sind, suche nur nach offiziellen Hersteller-Datenblaettern oder PDFs.",
    "Nutze keine Haendler-Shops, Foren oder aggregierte Drittseiten.",
    "Erlaube nur Hersteller-Domains: *.embraco.com, *.danfoss.com, *.tecumseh.com, *.bitzer.de, *.bitzer.com.",
    "Wenn keine offiziellen Herstellerquellen gefunden werden, gib nur \"unbekannt\" zurueck.",
    "Pruefe Modellvarianten (z.B. Leerzeichen/Bindestriche): VNEU213U, VNEU 213 U, VNEU-213U.",
    "Gib nur JSON zurueck mit folgendem Format:",
    "{",
    "  \"summary\": \"kurze Zusammenfassung in Deutsch\",",
    "  \"specs\": { \"parameter\": \"wert\", ... },",
    "  \"en12900\": [",
    "    { \"te_c\": -10, \"tc_c\": 45, \"capacity_w\": \"...\", \"power_w\": \"...\", \"cop\": \"...\" },",
    "    { \"te_c\": -25, \"tc_c\": 45, \"capacity_w\": \"...\", \"power_w\": \"...\", \"cop\": \"...\" }",
    "  ],",
    "  \"sources\": [ { \"title\": \"...\", \"url\": \"...\" }, ... ]",
    "}",
    "Alle technischen Daten, die du findest, bitte in specs aufnehmen.",
    "Wenn ein Wert nicht zu finden ist, schreibe \"unbekannt\".",
    "Wenn keine offiziellen Herstellerquellen gefunden werden, fuelle alle Felder mit \"unbekannt\" und setze summary entsprechend.",
    "Gib immer beide EN12900 Zeilen aus; wenn keine Daten gefunden, nutze \"unbekannt\".",
    "",
    `Anfrage: ${query}`,
    brand ? `Hersteller: ${brand}` : "",
    refrigerant ? `Kaeltemittel: ${refrigerant}` : "",
    notes ? `Zusatzinfo: ${notes}` : ""
  ].filter(Boolean).join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: promptParts,
        tools: [{ type: "web_search" }],
        temperature: 0.2,
        max_output_tokens: 1200
      })
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({
        error: data && data.error && data.error.message ? data.error.message : "OpenAI Anfrage fehlgeschlagen."
      });
      return;
    }

    let text = data.output_text || "";
    if (!text && Array.isArray(data.output)) {
      text = data.output
        .flatMap((item) => item.content || [])
        .filter((content) => content.type === "output_text")
        .map((content) => content.text)
        .join("\n");
    }

    if (text.includes("```")) {
      text = text.replace(/```(?:json)?/g, "").trim();
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      res.status(200).json({
        summary: "Antwort konnte nicht geparst werden.",
        specs: {},
        en12900: [],
        sources: [],
        raw: text
      });
      return;
    }

    const allowedDomains = [
      "embraco.com",
      "danfoss.com",
      "tecumseh.com",
      "bitzer.de",
      "bitzer.com"
    ];

    const isAllowedSource = (urlValue) => {
      try {
        const hostname = new URL(urlValue).hostname.toLowerCase();
        return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
      } catch (error) {
        return false;
      }
    };

    const rawSources = Array.isArray(payload.sources) ? payload.sources : [];
    const officialSources = rawSources.filter((source) => source && isAllowedSource(source.url));
    const hasOfficialSources = officialSources.length > 0;

    if (!hasOfficialSources) {
      res.status(200).json({
        summary: "Keine offiziellen Herstellerquellen gefunden.",
        specs: {},
        en12900: [
          { te_c: -10, tc_c: 45, capacity_w: "unbekannt", power_w: "unbekannt", cop: "unbekannt" },
          { te_c: -25, tc_c: 45, capacity_w: "unbekannt", power_w: "unbekannt", cop: "unbekannt" }
        ],
        sources: []
      });
      return;
    }

    res.status(200).json({
      summary: payload.summary || "KI Recherche abgeschlossen.",
      specs: payload.specs || {},
      en12900: Array.isArray(payload.en12900) ? payload.en12900 : [],
      sources: officialSources
    });
  } catch (error) {
    res.status(500).json({ error: error && error.message ? error.message : String(error) });
  }
});

exports.notifyOnImportantNote = functions.firestore
  .document("importantNotes/{noteId}")
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    const senderLabel = data.userLabel || "Unbekannt";
    const senderId = data.userId || data.user || "";
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

    const tokenEntries = [];
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
        tokenIndex.set(dedupeKey, { token: doc.id, updatedAt, userId });
      } else {
        dedupeDeletes.push(admin.firestore().collection("pushTokens").doc(doc.id).delete());
      }
    });

    tokenIndex.forEach((value) => tokenEntries.push(value));

    const filteredEntries = senderId
      ? tokenEntries.filter((entry) => entry.userId !== senderId)
      : tokenEntries;
    const tokens = filteredEntries.map((entry) => entry.token);

    if (!tokens.length) {
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
        note: "no tokens after sender filter"
      });
      return null;
    }

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
