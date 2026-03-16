const functions = require("firebase-functions");
const admin = require("firebase-admin");
const pdfParse = require("pdf-parse");
const fetch = require("node-fetch");
const xlsx = require("xlsx");

admin.initializeApp({
  databaseURL: "https://pakora-automations-chat-default-rtdb.europe-west1.firebasedatabase.app"
});

// +++ START: OneDrive Excel Sync Function +++

const runtimeConfig = functions.config();
const oneDriveConfig = runtimeConfig.onedrive || {};

const MS_GRAPH_CREDS = {
    auth: {
        clientId: oneDriveConfig.client_id || "",
        clientSecret: oneDriveConfig.client_secret || "",
        tenantId: oneDriveConfig.tenant_id || "consumers",
        refreshToken: oneDriveConfig.refresh_token || ""
    },
    excelFilePath: oneDriveConfig.excel_path || ""
};

function normalizeHeader(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "");
}

function isMeaningfulCell(value) {
    return String(value || "").trim() !== "";
}

function isLikelyHeaderCell(value) {
    const normalized = normalizeHeader(value);
    return [
      "artikelnummer",
      "artikelnr",
      "artnr",
      "typ",
      "marke",
      "farbe",
      "km",
      "hersteller",
      "modell",
      "model",
      "kompressor",
      "kategorie",
      "khltemittel",
      "anwendung",
      "leistung10cwatt",
      "leistung25cwatt",
      "leistung10c",
      "leistung25c",
      "leistung",
      "menge",
      "preis",
      "spannungsversorgung"
    ].some((token) => normalized.includes(token));
}

function rowHasTemperatureHeaders(row = []) {
    return row.some((cell) => {
      const normalized = normalizeHeader(cell);
      return ["te0c", "te10c", "te25c"].includes(normalized);
    });
}

function buildSegmentHeaders(headerRow, subHeaderRow, firstColumn, lastColumn) {
    const headers = {};
    let lastPrimary = "";

    for (let columnIndex = firstColumn; columnIndex <= lastColumn; columnIndex++) {
      const primary = normalizeHeader(headerRow[columnIndex]);
      const secondary = normalizeHeader((subHeaderRow || [])[columnIndex]);

      if (primary) {
        lastPrimary = primary;
      }

      let header = primary || secondary || `col${columnIndex}`;
      if (secondary && lastPrimary === "leistung") {
        header = secondary;
      } else if (secondary && primary && primary !== secondary) {
        header = `${primary}${secondary}`;
      }

      headers[columnIndex] = header;
    }

    return headers;
}

function extractRowsFromWorksheet(worksheet, sheetName) {
    const matrix = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
    const entries = [];

    for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
      const row = matrix[rowIndex] || [];
      const headerColumns = row
        .map((cell, columnIndex) => ({ columnIndex, cell }))
        .filter(({ cell }) => isLikelyHeaderCell(cell));

      if (headerColumns.length < 3) continue;

      const segments = [];
      let currentSegment = [];
      headerColumns.forEach((column, index) => {
        if (!currentSegment.length) {
          currentSegment.push(column);
          return;
        }
        const previous = headerColumns[index - 1];
        if (column.columnIndex - previous.columnIndex <= 1) {
          currentSegment.push(column);
        } else {
          segments.push(currentSegment);
          currentSegment = [column];
        }
      });
      if (currentSegment.length) segments.push(currentSegment);

      const nextRow = matrix[rowIndex + 1] || [];
      const hasSecondaryHeaders = rowHasTemperatureHeaders(nextRow);

      segments
        .filter((segment) => segment.length >= 3)
        .forEach((segment) => {
          const firstColumn = segment[0].columnIndex;
          let lastColumn = segment[segment.length - 1].columnIndex;
          for (let columnIndex = lastColumn + 1; columnIndex < row.length; columnIndex++) {
            if (!isMeaningfulCell(row[columnIndex])) break;
            lastColumn = columnIndex;
          }

          const headers = buildSegmentHeaders(row, hasSecondaryHeaders ? nextRow : null, firstColumn, lastColumn);

          const sectionTitle = rowIndex > 0
            ? String((matrix[rowIndex - 1] || []).slice(firstColumn, lastColumn + 1).find(isMeaningfulCell) || "")
            : "";

          const dataStartIndex = rowIndex + (hasSecondaryHeaders ? 2 : 1);
          for (let dataRowIndex = dataStartIndex; dataRowIndex < matrix.length; dataRowIndex++) {
            const dataRow = matrix[dataRowIndex] || [];
            const values = dataRow.slice(firstColumn, lastColumn + 1);
            const nonEmptyCount = values.filter(isMeaningfulCell).length;
            if (!nonEmptyCount) break;
            if (values.filter(isLikelyHeaderCell).length >= 3) break;

            const entry = { __sheet: sheetName, __section: sectionTitle };
            Object.entries(headers).forEach(([columnIndex, header]) => {
              entry[header] = dataRow[Number(columnIndex)];
            });

            const hasIdentity = [
              entry.artikelnummer,
              entry.artikelnr,
              entry.artnr,
              entry.modell,
              entry.model,
              entry.kompressor,
              entry.name,
              entry.bezeichnung,
              entry.preis,
              entry.menge
            ].some(isMeaningfulCell);

            if (hasIdentity && Object.values(entry).filter(isMeaningfulCell).length >= 2) {
              entries.push(entry);
            }
          }
        });
    }

    return entries;
}

function workbookToObjects(workbook) {
    return workbook.SheetNames.flatMap((sheetName) => {
      const worksheet = workbook.Sheets[sheetName];
      return extractRowsFromWorksheet(worksheet, sheetName);
    });
}

function buildProductId(row, manufacturer, model) {
    const explicitId = String(pickValue(row, ["id", "artnr", "artikelnummer", "artikelnr", "artikelnummerid"])).trim();
    if (explicitId) return explicitId;

    const fallback = [
      row.__sheet,
      row.__section,
      manufacturer,
      model,
      pickValue(row, ["typ", "kompressor", "modell", "model"]),
      pickValue(row, ["te10c", "leistung10c", "leistung25c", "leistung"])
    ]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ");

    return fallback || "";
}

function pickValue(row, candidates) {
    for (const key of candidates) {
      const value = row[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return value;
      }
    }
    return "";
}

function parseNumber(value) {
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    const normalized = String(value || "")
      .replace(",", ".")
      .match(/-?\d+(?:\.\d+)?/);
    return normalized ? Number(normalized[0]) : 0;
}

function inferCategory(rawCategory, productName) {
    const haystack = `${rawCategory || ""} ${productName || ""}`.toLowerCase();
    if (haystack.includes("verdampfer")) return "evaporator";
    if (haystack.includes("cp-box") || haystack.includes("cp box")) return "cp_box";
    if (haystack.includes("verfl") || haystack.includes("condensing")) return "condensing_unit";
    if (haystack.includes("kompressor") || haystack.includes("compressor")) return "compressor";
    return "accessory";
}

function inferCategoryFromSheet(sheetName, sectionTitle, rawCategory, productName) {
    const sheet = String(sheetName || "").toLowerCase();
    const section = String(sectionTitle || "").toLowerCase();
    const combined = `${sheet} ${section} ${rawCategory || ""} ${productName || ""}`;

    if (combined.includes("cp-box") || combined.includes("cp box") || combined.includes("frigo")) {
        return "cp_box";
    }
    if (combined.includes("verfl")) {
        return "condensing_unit";
    }
    if (combined.includes("kompressor") || combined.includes("embraco scroll") || combined.includes("tecumseh") || combined.includes("dorin") || combined.includes("danfoss")) {
        return "compressor";
    }
    if (combined.includes("verdampfer") || combined.includes("evacond") || combined.includes("sonkar") || combined.includes("gunay") || combined.includes("günay")) {
        return "evaporator";
    }

    return inferCategory(rawCategory, productName);
}

function buildProductName(row) {
    const manufacturer = String(pickValue(row, ["hersteller", "manufacturer", "marke"])).trim();
    const model = String(pickValue(row, ["modell", "model", "kompressor", "typ", "bezeichnung", "produkt", "artikel"])).trim();
    const explicitName = String(pickValue(row, ["name", "produktname"])).trim();
    return explicitName || [manufacturer, model].filter(Boolean).join(" ").trim() || model;
}

function inferStructuredCategory(sheetName, sectionTitle, rawCategory, productName, row = {}) {
    const sheet = String(sheetName || "").toLowerCase();
    const section = String(sectionTitle || "").toLowerCase();
    const combined = `${sheet} ${section} ${rawCategory || ""} ${productName || ""}`;
    const hasEvaporatorTemps = [row.te0c, row.te10c, row.te25c].some(isMeaningfulCell);
    const hasTypeColumn = [row.typ, row.marke].some(isMeaningfulCell);

    if (combined.includes("cp-box") || combined.includes("cp box") || combined.includes("frigo")) return "cp_box";
    if (combined.includes("verfl")) return "condensing_unit";
    if (combined.includes("kompressor") || combined.includes("embraco scroll") || combined.includes("tecumseh") || combined.includes("dorin") || combined.includes("danfoss")) return "compressor";
    if (combined.includes("verdampfer") || combined.includes("evacond") || combined.includes("sonkar") || combined.includes("gunay") || hasEvaporatorTemps || hasTypeColumn) return "evaporator";

    return inferCategory(rawCategory, productName);
}

function deriveStructuredCapacities(row) {
    const directNK = parseNumber(pickValue(row, ["leistungnk10c", "leistungnk", "leistung10cwatt", "leistung10c", "te10c", "f"]));
    const directTK = parseNumber(pickValue(row, ["leistungtk25c", "leistungtk", "leistung25cwatt", "leistung25c", "te25c", "g"]));
    const directZero = parseNumber(pickValue(row, ["te0c", "leistung0c"]));
    const generic = String(pickValue(row, ["leistung"])).trim();

    let capacityNK = directNK;
    let capacityTK = directTK;
    const context = `${row.__sheet || ""} ${row.__section || ""}`.toLowerCase();

    if (!capacityNK && generic && generic.includes("-10")) capacityNK = parseNumber(generic);
    if (!capacityTK && generic && generic.includes("-25")) capacityTK = parseNumber(generic);
    if (!capacityNK && !capacityTK && generic) {
        if (context.includes("-10") || context.includes("normalk")) capacityNK = parseNumber(generic);
        if (context.includes("-25") || context.includes("tiefk")) capacityTK = parseNumber(generic);
    }

    return {
        capacityNK,
        capacityTK,
        capacityZero: directZero
    };
}

function normalizeNameKey(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
}

function shouldSkipProduct(product) {
    const name = normalizeNameKey(product.name);
    if (!name) return true;
    const blocked = [
      "tk gesamt",
      "nk gesamt",
      "gesamt",
      "weiss",
      "weiß",
      "anthrazith",
      "grau beige"
    ];
    if (blocked.includes(name)) return true;
    if (!product.price && !product.qty && !product.capacityNK && !product.capacityTK) return true;
    return false;
}

function deriveCapacities(row) {
    const directNK = parseNumber(pickValue(row, ["leistungnk10c", "leistungnk", "leistung10cwatt", "leistung10c", "te10c", "f"]));
    const directTK = parseNumber(pickValue(row, ["leistungtk25c", "leistungtk", "leistung25cwatt", "leistung25c", "te25c", "g"]));
    const directZero = parseNumber(pickValue(row, ["te0c", "leistung0c"]));
    const generic = String(pickValue(row, ["leistung"])).trim();

    let capacityNK = directNK;
    let capacityTK = directTK;

    if (!capacityNK && generic && generic.includes("-10")) capacityNK = parseNumber(generic);
    if (!capacityTK && generic && generic.includes("-25")) capacityTK = parseNumber(generic);

    return {
        capacityNK,
        capacityTK,
        capacityZero: directZero
    };
}

async function getGraphToken() {
    if (!MS_GRAPH_CREDS.auth.clientId) {
        throw new Error("Missing OneDrive client ID. Set functions config onedrive.client_id.");
    }
    if (!MS_GRAPH_CREDS.auth.refreshToken) {
        throw new Error("Missing OneDrive refresh token. Set functions config onedrive.refresh_token.");
    }
    if (!MS_GRAPH_CREDS.excelFilePath) {
        throw new Error("Missing OneDrive Excel path. Set functions config onedrive.excel_path.");
    }

    const url = `https://login.microsoftonline.com/${MS_GRAPH_CREDS.auth.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams();
    body.append("client_id", MS_GRAPH_CREDS.auth.clientId);
    if (MS_GRAPH_CREDS.auth.clientSecret) {
        body.append("client_secret", MS_GRAPH_CREDS.auth.clientSecret);
    }
    body.append("grant_type", "refresh_token");
    body.append("refresh_token", MS_GRAPH_CREDS.auth.refreshToken);
    body.append("scope", "Files.Read offline_access");

    const response = await fetch(url, { method: "POST", body });
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token Error: ${error}`);
    }
    const data = await response.json();
    return data.access_token;
}

exports.syncOneDriveExcel = functions.https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }

    if (!["GET", "POST"].includes(req.method)) {
        res.status(405).json({ error: "Use GET, POST or OPTIONS." });
        return;
    }

    try {
        const token = await getGraphToken();
        const driveItemUrl = `https://graph.microsoft.com/v1.0/me/drive/root:${MS_GRAPH_CREDS.excelFilePath}:/content`;
        
        const fileResponse = await fetch(driveItemUrl, {
            headers: { "Authorization": `Bearer ${token}` }
        });

        if (!fileResponse.ok) {
            const error = await fileResponse.text();
            throw new Error(`OneDrive Error: ${error}`);
        }

        const arrayBuffer = await fileResponse.arrayBuffer();
        const workbook = xlsx.read(Buffer.from(arrayBuffer), { type: "buffer" });
        const jsonData = workbookToObjects(workbook);
        const existingSnapshot = await admin.database().ref("/products").get();
        const existingProducts = existingSnapshot.exists() ? existingSnapshot.val() : {};

        const importedProducts = new Map();
        let count = 0;
        let created = 0;
        let updated = 0;
        jsonData.forEach(row => {
            const manufacturer = String(pickValue(row, ["hersteller", "manufacturer", "marke"])).trim();
            const model = String(pickValue(row, ["modell", "model", "kompressor", "typ", "bezeichnung", "produkt", "artikel"])).trim();
            const id = buildProductId(row, manufacturer, model);
            if (!id) return;

            const safeId = String(id).replace(/[.#$/\[\]]/g, "_");
            const existing = existingProducts[safeId] || {};
            const explicitName = buildProductName(row);
            const rawCategory = String(pickValue(row, ["kategorie", "category", "anwendung", "application"])).trim() || `${row.__sheet || ""} ${row.__section || ""}`;
            const qtyRaw = pickValue(row, ["menge", "bestand", "anzahl", "qty", "lagerbestand", "stuck", "stueck"]);
            const hasQty = String(qtyRaw || "").trim() !== "";
            const qty = hasQty ? Math.max(0, Math.round(parseNumber(qtyRaw))) : (existing.qty || 0);
            const price = parseNumber(pickValue(row, ["preis", "price"]));
            const capacities = deriveStructuredCapacities(row);
            const productName = explicitName || existing.name || model || id;
            const category = inferStructuredCategory(row.__sheet, row.__section, rawCategory || existing.category, productName, row);
            const productData = {
                id,
                name: productName,
                qty,
                price: price || existing.price || 0,
                category,
                capacityNK: capacities.capacityNK || existing.capacityNK || 0,
                capacityTK: capacities.capacityTK || existing.capacityTK || 0
            };

            if (shouldSkipProduct(productData)) return;

            const mergeKey = `${category}:${normalizeNameKey(productData.name)}`;
            const merged = importedProducts.get(mergeKey);
            if (merged) {
                merged.id = merged.id || productData.id;
                merged.qty = Math.max(merged.qty || 0, productData.qty || 0);
                merged.price = merged.price || productData.price || 0;
                merged.capacityNK = merged.capacityNK || productData.capacityNK || 0;
                merged.capacityTK = merged.capacityTK || productData.capacityTK || 0;
            } else {
                importedProducts.set(mergeKey, { ...productData });
            }
            count++;
        });

        const updates = {};
        importedProducts.forEach((productData) => {
            const safeId = String(productData.id || productData.name).replace(/[.#$/\[\]]/g, "_");
            const existing = existingProducts[safeId] || {};
            updates[`/products/${safeId}`] = productData;
            if (existing && Object.keys(existing).length) updated++;
            else created++;
        });

        if (!importedProducts.size) {
            res.status(400).json({ error: "Keine gueltigen Artikelzeilen in der OneDrive-Datei gefunden." });
            return;
        }

        await admin.database().ref().update(updates);
        console.log(`OK: ${importedProducts.size} products synced.`);
        res.status(200).json({
            ok: true,
            total: importedProducts.size,
            created,
            updated,
            sheets: workbook.SheetNames
        });

    } catch (error) {
        console.error("Sync failed:", error);
        res.status(500).json({ error: error.message });
    }
});

// +++ END: OneDrive Excel Sync Function +++

function sanitizeInventoryKey(value) {
    return String(value || "").trim().replace(/[.#$/\[\]]/g, "_");
}

function normalizeInventoryProduct(payload, existing = {}) {
    const id = String(payload.id || existing.id || "").trim();
    const name = String(payload.name || existing.name || id).trim();
    return {
      id,
      name,
      qty: Math.max(0, Math.round(parseNumber(payload.qty !== undefined ? payload.qty : existing.qty || 0))),
      price: parseNumber(payload.price !== undefined ? payload.price : existing.price || 0),
      category: String(payload.category || existing.category || "accessory").trim() || "accessory",
      capacityNK: parseNumber(payload.capacityNK !== undefined ? payload.capacityNK : existing.capacityNK || 0),
      capacityTK: parseNumber(payload.capacityTK !== undefined ? payload.capacityTK : existing.capacityTK || 0)
    };
}

exports.inventoryApi = functions.https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }

    try {
        const productsRef = admin.database().ref("/products");

        if (req.method === "GET") {
            const snapshot = await productsRef.get();
            res.status(200).json({ products: snapshot.exists() ? snapshot.val() : {} });
            return;
        }

        if (req.method !== "POST") {
            res.status(405).json({ error: "Use GET, POST or OPTIONS." });
            return;
        }

        const body = req.body || {};
        const action = String(body.action || "").trim();

        if (action === "update_qty") {
            const key = sanitizeInventoryKey(body.key);
            if (!key) {
                res.status(400).json({ error: "Key fehlt." });
                return;
            }
            const itemRef = productsRef.child(key);
            const snapshot = await itemRef.get();
            const existing = snapshot.exists() ? snapshot.val() : null;
            if (!existing) {
                res.status(404).json({ error: "Artikel nicht gefunden." });
                return;
            }
            const nextQty = Math.max(0, Math.round(parseNumber(existing.qty || 0) + parseNumber(body.delta || 0)));
            await itemRef.child("qty").set(nextQty);
            res.status(200).json({ ok: true, qty: nextQty });
            return;
        }

        if (action === "upsert") {
            const product = body.product || {};
            const key = sanitizeInventoryKey(body.key || product.id);
            if (!key) {
                res.status(400).json({ error: "Artikel-ID fehlt." });
                return;
            }
            const itemRef = productsRef.child(key);
            const snapshot = await itemRef.get();
            const existing = snapshot.exists() ? snapshot.val() : {};
            const normalized = normalizeInventoryProduct(product, existing);
            if (!normalized.id) normalized.id = key;
            await itemRef.set(normalized);
            res.status(200).json({ ok: true, key, product: normalized });
            return;
        }

        if (action === "delete") {
            const key = sanitizeInventoryKey(body.key);
            if (!key) {
                res.status(400).json({ error: "Key fehlt." });
                return;
            }
            await productsRef.child(key).remove();
            res.status(200).json({ ok: true, key });
            return;
        }

        if (action === "batch_upsert") {
            const items = Array.isArray(body.items) ? body.items : [];
            if (!items.length) {
                res.status(400).json({ error: "Keine Artikel uebergeben." });
                return;
            }

            const snapshot = await productsRef.get();
            const existingProducts = snapshot.exists() ? snapshot.val() : {};
            const updates = {};
            let count = 0;

            items.forEach((item) => {
                const key = sanitizeInventoryKey(item.key || item.id);
                if (!key) return;
                const existing = existingProducts[key] || {};
                const normalized = normalizeInventoryProduct(item, existing);
                if (!normalized.id) normalized.id = key;
                updates[key] = normalized;
                count++;
            });

            await productsRef.update(updates);
            res.status(200).json({ ok: true, count });
            return;
        }

        res.status(400).json({ error: "Unbekannte action." });
    } catch (error) {
        console.error("inventoryApi failed:", error);
        res.status(500).json({ error: error.message });
    }
});


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
  const datasheetText = String(body.datasheet_text || "").trim();

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
    "Wenn du ein offizielles PDF-Datenblatt findest, fuehre es in sources auf.",
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
    "    \"discharge_connection\": \"...\",",
    "    \"notes\": \"...\"",
    "  },",
    "  \"en12900\": [",
    "    { \"te_c\": \"...\", \"tc_c\": \"...\", \"capacity_w\": \"...\", \"power_w\": \"...\", \"cop\": \"...\" },",
    "    { \"te_c\": \"...\", \"tc_c\": \"...\", \"capacity_w\": \"...\", \"power_w\": \"...\", \"cop\": \"...\" }",
    "  ],",
    "  \"sources\": [ { \"title\": \"...\", \"url\": \"...\" }, ... ]",
    "}",
    "Wichtig: Nur Kompressoren mit deutscher Netzspannung beruecksichtigen: 230V/50Hz oder 400V/50Hz.",
    "Fuege in specs einen Eintrag \"supply_voltage\" hinzu (z.B. \"230V/50Hz\" oder \"400V/50Hz\").",
    "Leistung in PS (hp) ist Pflicht: falls nicht direkt angegeben, berechne aus kW (1 kW = 1.341 hp) und kennzeichne es in notes.",
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
    notes ? `Zusatzinfo: ${notes}` : "",
    datasheetText ? "Nutze ausschliesslich den folgenden Datenblatt-Text und keine Websuche:" : "",
    datasheetText ? datasheetText : ""
  ].filter(Boolean).join("\n");

  const tools = datasheetText ? [] : [{ type: "web_search" }];

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
        ...(tools.length ? { tools } : {}),
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
                  additionalProperties: false,
                  required: [
                    "manufacturer",
                    "refrigerant",
                    "supply_voltage",
                    "power_hp",
                    "current_a",
                    "type",
                    "suction_connection",
                    "discharge_connection",
                    "notes"
                  ],
                  properties: {
                    manufacturer: { type: "string" },
                    refrigerant: { type: "string" },
                    supply_voltage: { type: "string" },
                    power_hp: { type: "string" },
                    current_a: { type: "string" },
                    type: { type: "string" },
                    suction_connection: { type: "string" },
                    discharge_connection: { type: "string" },
                    notes: { type: "string" }
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
    const hasInlineDatasheet = datasheetText.length > 0;

    if (!hasInlineDatasheet && !hasOfficialSources && !hasPdfSources) {
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

    const extractEn12900FromText = (pdfText) => {
      if (!pdfText) return [];
      const normalized = String(pdfText).replace(/\r/g, "");
      const matchIndex = normalized.search(/Condensing Temperature\s*45/i);
      if (matchIndex === -1) return [];
      const segment = normalized.slice(matchIndex);
      const endIndex = segment.search(/Condensing Temperature\s*55|ENVELOPE|EXTERNAL DIMENSIONS/i);
      const section = endIndex === -1 ? segment : segment.slice(0, endIndex);
      const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
      const rowRegex = /^\s*(-?\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\b/;
      const rows = [];
      lines.forEach((line) => {
        const match = line.match(rowRegex);
        if (!match) return;
        const te = Number(match[1]);
        if (te !== -10 && te !== -25) return;
        rows.push({
          te_c: String(te),
          tc_c: "45",
          capacity_w: match[2],
          cop: match[3],
          power_w: match[4]
        });
      });
      return rows;
    };

    const pdfUrl = rawSources
      .map((source) => source && source.url)
      .filter((urlValue) => isPdfSource(urlValue || ""))[0];

    let parsedEnRows = [];
    if (pdfUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const pdfResponse = await fetch(pdfUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (pdfResponse.ok) {
          const buffer = Buffer.from(await pdfResponse.arrayBuffer());
          const parsed = await pdfParse(buffer);
          parsedEnRows = extractEn12900FromText(parsed.text || "");
        }
      } catch (error) {
        parsedEnRows = [];
      }
    }

    const enRows = Array.isArray(payload.en12900) ? payload.en12900 : [];
    const filteredEnRows = enRows.filter((row) => {
      const te = Number(row && row.te_c);
      const tc = Number(row && row.tc_c);
      if (Number.isNaN(te) || Number.isNaN(tc)) return false;
      return tc === 45 && (te === -10 || te === -25);
    });

    const finalEnRows = parsedEnRows.length ? parsedEnRows : filteredEnRows;

    res.status(200).json({
      summary: payload.summary || "KI Recherche abgeschlossen.",
      specs,
      en12900: finalEnRows,
      sources: hasInlineDatasheet ? (Array.isArray(payload.sources) ? payload.sources : []) : (officialSources.length ? officialSources : pdfSources)
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


function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

async function sendWhatsappText(token, phoneNumberId, to, text) {
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`WhatsApp API Fehler ${response.status}: ${body}`);
  }
}

async function buildAiReply({ apiKey, styleSamples, customPrompt, history, messageText }) {
  const systemPrompt = [
    "Du bist der WhatsApp Assistent von Mert Kaan (Pakora Automations).",
    "Antworte freundlich, kurz und professionell, so als wuerdest du selbst schreiben.",
    "Klinge menschlich und natuerlich, keine Roboter-Floskeln.",
    "Sprache der Antwort muss der Sprache der Kundenanfrage entsprechen (Deutsch, Englisch oder Tuerkisch).",
    "Wenn Informationen fehlen, stelle 1-3 kurze Rueckfragen.",
    "Bei Kuehlzellen-Anfragen frage nach Innenmass (LxBxH), Solltemperatur, Standort und Zeitrahmen.",
    "Nutze keine Markdown-Listen oder Ueberschriften.",
    "Gib deine Ausgabe nur als JSON im Format: {\"language\":\"de|en|tr\",\"reply\":\"...\"}"
  ]
    .concat(customPrompt ? ["Zusatzregeln von Mert: " + customPrompt] : [])
    .join("\n");

  const historyLines = history
    .map((item) => `${item.role === "assistant" ? "Mert" : "Kunde"}: ${item.text}`)
    .join("\n");

  const userPrompt = [
    styleSamples ? `Stilbeispiele von Mert:
${styleSamples}` : "",
    historyLines ? `Letzte Nachrichten:
${historyLines}` : "",
    `Neue Nachricht vom Kunden: ${messageText}`,
    "Antwort als JSON:"
  ].filter(Boolean).join("\n\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 180,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI Fehler ${response.status}: ${body}`);
  }

  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";

  if (!content) {
    return { reply: "", language: "" };
  }

  try {
    const parsed = JSON.parse(content);
    return {
      reply: String(parsed.reply || "").trim(),
      language: String(parsed.language || "").trim()
    };
  } catch (error) {
    return { reply: String(content).trim(), language: "" };
  }
}

exports.whatsappWebhook = functions.https.onRequest(async (req, res) => {
  const config = functions.config();
  const verifyToken = config.whatsapp && config.whatsapp.verify_token;

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token && token === verifyToken) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send("Verification failed");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Use POST");
    return;
  }

  try {
    const payload = req.body || {};
    const entry = payload.entry && payload.entry[0];
    const change = entry && entry.changes && entry.changes[0] && entry.changes[0].value;
    const messages = change && change.messages ? change.messages : [];
    const contacts = change && change.contacts ? change.contacts : [];

    if (!messages.length) {
      res.status(200).send("No messages");
      return;
    }

    const message = messages[0];
    const messageId = message.id || "";
    const from = message.from || "";
    const timestamp = message.timestamp ? Number(message.timestamp) * 1000 : Date.now();
    const name = contacts[0] && contacts[0].profile ? contacts[0].profile.name : "";
    const text = message.text && message.text.body ? message.text.body.trim() : "";
    const normalizedFrom = normalizePhone(from);

    const isText = message.type === "text" && text;

    if (messageId) {
      const dedupeRef = admin.firestore().collection("whatsappMessageIds").doc(messageId);
      const dedupeSnap = await dedupeRef.get();
      if (dedupeSnap.exists) {
        res.status(200).send("Duplicate");
        return;
      }
      await dedupeRef.set({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        from: normalizedFrom,
        messageId
      });
    }

    const requestRef = await admin.firestore().collection("whatsappRequests").add({
      phone: normalizedFrom || from,
      name: name || "Unbekannt",
      message: text || "(kein Text)",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "open",
      source: "whatsapp",
      messageId
    });

    const convoRef = admin.firestore().collection("whatsappConversations").doc(normalizedFrom || from);
    await convoRef.set({
      phone: normalizedFrom || from,
      name: name || "Unbekannt",
      lastMessage: text || "(kein Text)",
      lastTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await convoRef.collection("messages").add({
      direction: "inbound",
      text: text || "(kein Text)",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      rawTimestamp: timestamp,
      messageId
    });

    if (!isText) {
      res.status(200).send("Non-text");
      return;
    }

    const settingsSnap = await admin.firestore().collection("whatsappBotSettings").doc("global").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const enabled = !!settings.enabled;
    const excluded = Array.isArray(settings.excludedNumbers) ? settings.excludedNumbers : [];
    const excludedSet = new Set(excluded.map((item) => normalizePhone(item)).filter(Boolean));

    if (!enabled || excludedSet.has(normalizedFrom)) {
      res.status(200).send("Bot disabled or excluded");
      return;
    }

    const apiKey = config.openai && config.openai.key;
    const waToken = config.whatsapp && config.whatsapp.token;
    const waPhoneId = config.whatsapp && config.whatsapp.phone_number_id;

    if (!apiKey || !waToken || !waPhoneId) {
      res.status(200).send("Missing config");
      return;
    }

    const historySnap = await convoRef.collection("messages")
      .orderBy("timestamp", "desc")
      .limit(8)
      .get();
    const history = [];
    historySnap.forEach((doc) => {
      const data = doc.data() || {};
      history.push({
        role: data.direction === "outbound" ? "assistant" : "user",
        text: data.text || ""
      });
    });
    history.reverse();

    const aiResult = await buildAiReply({
      apiKey,
      styleSamples: settings.styleSamples || "",
      customPrompt: settings.customPrompt || "",
      history,
      messageText: text || ""
    });

    const reply = (aiResult.reply || "").trim();
    if (!reply) {
      res.status(200).send("No reply");
      return;
    }

    await sendWhatsappText(waToken, waPhoneId, from, reply);

    await convoRef.collection("messages").add({
      direction: "outbound",
      text: reply,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      rawTimestamp: Date.now(),
      messageId: `${messageId}_reply`
    });

    await requestRef.set({
      reply,
      language: aiResult.language || "",
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "open",
      autoReplied: true
    }, { merge: true });

    res.status(200).send("OK");
  } catch (error) {
    console.error("WhatsApp webhook error:", error);
    res.status(200).send("Error");
  }
});

