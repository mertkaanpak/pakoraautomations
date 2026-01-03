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
    "Du bist ein erfahrener Kaelteanlagenbauer mit Spezialwissen ueber kaeltetechnische Komponenten.",
    "Ich gebe dir eine Kompressormodellnummer.",
    "Prioritaet: Herstellerdaten oder offizielle technische Datenblaetter.",
    "Gib die Kaelteleistung fuer:",
    "Normalkuehlung: -10 C VT / +45 C KT",
    "Tiefkuehlung: -25 C VT / +45 C KT (falls zutreffend)",
    "Nutze diese Quellen zuerst (in dieser Reihenfolge), wenn vorhanden:",
    "1) Embraco: https://products.embraco.com/compressors",
    "2) Danfoss Coolselector2 (Berechnungs- und Auswahlsoftware)",
    "3) Tecumseh tselect: https://tselect.tecumseh.com/de/",
    "4) Bitzer Websoftware: https://www.bitzer.de/websoftware/",
    "Wenn die Quellen nicht direkt zugaenglich sind, suche nach offiziellen Hersteller-Datenblaettern oder PDFs.",
    "Nutze keine Haendler-Shops, Foren oder aggregierte Drittseiten.",
    "Erlaubte Hersteller-Domains: *.embraco.com, *.danfoss.com, *.tecumseh.com, *.bitzer.de, *.bitzer.com.",
    "Wenn keine Hersteller-Domains gefunden werden, darfst du PDFs von anderen Domains verwenden,",
    "sofern es sich um technische Datenblaetter handelt (PDF).",
    "Pruefe Modellvarianten (z.B. Leerzeichen/Bindestriche): VNEU213U, VNEU 213 U, VNEU-213U.",
    "Suche explizit mit 'model pdf datasheet' und 'filetype:pdf', wenn noetig.",
    "Nutze mehrere Suchanfragen mit Varianten des Modells (Gross/Klein, Leerzeichen, Bindestrich).",
    "Gib nur JSON zurueck mit folgendem Format:",
    "{",
    "  \"summary\": \"kurze Zusammenfassung in Deutsch\",",
    "  \"specs\": {",
    "    \"manufacturer\": \"...\",",
    "    \"refrigerant\": \"R134a|R404A|R290|unbekannt\",",
    "    \"supply_voltage\": \"230V/50Hz oder 400V/50Hz\",",
    "    \"power_hp\": \"...\",",
    "    \"current_a\": \"...\",",
    "    \"type\": \"hermetisch|halbhermetisch|scroll|hubkolben|...\",",
    "    \"suction_connection\": \"...\",",
    "    \"discharge_connection\": \"...\"",
    "  },",
    "  \"en12900\": [",
    "    { \"te_c\": \"...\", \"tc_c\": \"...\", \"capacity_w\": \"...\", \"power_w\": \"...\", \"cop\": \"...\" },",
    "    { \"te_c\": \"...\", \"tc_c\": \"...\", \"capacity_w\": \"...\", \"power_w\": \"...\", \"cop\": \"...\" }",
    "  ],",
    "  \"sources\": [ { \"title\": \"...\", \"url\": \"...\" }, ... ]",
    "}",
    "Wichtig: Nur Kompressoren mit deutscher Netzspannung beruecksichtigen: 230V/50Hz oder 400V/50Hz.",
    "Fuege in specs einen Eintrag \"supply_voltage\" hinzu (z.B. \"230V/50Hz\" oder \"400V/50Hz\").",
    "Alle technischen Daten, die du findest, bitte in specs aufnehmen.",
    "Wenn ein Wert nicht zu finden ist, schreibe \"unbekannt\".",
    "Wenn keine offiziellen Herstellerquellen gefunden werden, nutze PDF-Datenblaetter als Fallback.",
    "Wenn gar nichts passt, fuelle alle Felder mit \"unbekannt\" und setze summary entsprechend.",
    "Wenn eine EN12900 Tabelle vorhanden ist, gib nur Zeilen fuer -10/45 und -25/45 zurueck.",
    "Wenn keine EN12900 Tabelle vorhanden ist, setze en12900 auf [].",
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
        text: {
          format: {
            type: "json_schema",
            name: "compressor_lookup",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["summary", "specs", "en12900", "sources"],
              properties: {
                summary: { type: "string" },
                specs: {
                  type: "object",
                  additionalProperties: true,
                  required: [
                    "manufacturer",
                    "refrigerant",
                    "supply_voltage",
                    "power_hp",
                    "current_a",
                    "type",
                    "suction_connection",
                    "discharge_connection"
                  ],
                  properties: {
                    manufacturer: { type: "string" },
                    refrigerant: { type: "string" },
                    supply_voltage: { type: "string" },
                    power_hp: { type: "string" },
                    current_a: { type: "string" },
                    type: { type: "string" },
                    suction_connection: { type: "string" },
                    discharge_connection: { type: "string" }
                  }
                },
                en12900: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["te_c", "tc_c", "capacity_w", "power_w", "cop"],
                    properties: {
                      te_c: { type: "string" },
                      tc_c: { type: "string" },
                      capacity_w: { type: "string" },
                      power_w: { type: "string" },
                      cop: { type: "string" }
                    }
                  }
                },
                sources: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title", "url"],
                    properties: {
                      title: { type: "string" },
                      url: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        },
        temperature: 0.2,
        max_output_tokens: 3000
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
      const jsonChunk = data.output
        .flatMap((item) => item.content || [])
        .find((content) => content.type === "output_json" || content.type === "json");
      if (jsonChunk && jsonChunk.json) {
        try {
          res.status(200).json(jsonChunk.json);
          return;
        } catch (error) {
          // fall through to text parsing
        }
      }

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
      "secop.com",
      "tecumseh.com",
      "bitzer.de",
      "bitzer.com",
      "copeland.com",
      "emerson.com"
    ];

    const normalizeToken = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");

    const normalizedQuery = normalizeToken(query);

    const isAllowedSource = (urlValue) => {
      try {
        const hostname = new URL(urlValue).hostname.toLowerCase();
        return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
      } catch (error) {
        return false;
      }
    };

    const isPdfSource = (urlValue) => /\.pdf($|\?)/i.test(String(urlValue || ""));

    const isLikelyRelevantPdf = (urlValue, titleValue) => {
      const haystack = `${urlValue || ""} ${titleValue || ""}`;
      const normalized = normalizeToken(haystack);
      return !normalizedQuery || normalized.includes(normalizedQuery);
    };

    const rawSources = Array.isArray(payload.sources) ? payload.sources : [];
    const officialSources = rawSources.filter((source) => source && isAllowedSource(source.url));
    const pdfSources = rawSources.filter(
      (source) =>
        source &&
        isPdfSource(source.url) &&
        !isAllowedSource(source.url) &&
        isLikelyRelevantPdf(source.url, source.title)
    );
    const hasOfficialSources = officialSources.length > 0;
    const hasPdfSources = pdfSources.length > 0;

    if (!hasOfficialSources && !hasPdfSources) {
      res.status(200).json({
        summary: "Keine offiziellen Herstellerquellen oder passende PDF-Datenblaetter gefunden.",
        specs: {},
        en12900: [],
        sources: []
      });
      return;
    }

    const specs = payload.specs || {};
    const normalizedSupply = normalizeToken(
      specs.supply_voltage || specs.spannung || specs.spannungversorgung || specs.voltage || ""
    );
    const has230 = normalizedSupply.includes("230") || normalizedSupply.includes("220240");
    const has400 = normalizedSupply.includes("400");
    const has50 = normalizedSupply.includes("50");
    const isAllowedSupply = has50 && (has230 || has400);

    if (!isAllowedSupply) {
      res.status(200).json({
        summary: "Nicht passende Netzspannung (nur 230V/50Hz oder 400V/50Hz erlaubt).",
        specs: {},
        en12900: [],
        sources: officialSources.length ? officialSources : pdfSources
      });
      return;
    }

    const enRows = Array.isArray(payload.en12900) ? payload.en12900 : [];
    const filteredEnRows = enRows.filter((row) => {
      const te = Number(row && row.te_c);
      const tc = Number(row && row.tc_c);
      if (Number.isNaN(te) || Number.isNaN(tc)) return false;
      return tc === 45 && (te === -10 || te === -25);
    });

    res.status(200).json({
      summary: payload.summary || "KI Recherche abgeschlossen.",
      specs,
      en12900: filteredEnRows,
      sources: officialSources.length ? officialSources : pdfSources
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
