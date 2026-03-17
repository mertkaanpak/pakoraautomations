const path = require("path");
const admin = require("../node_modules/firebase-admin");
const xlsx = require("../node_modules/xlsx");

const serviceAccount = require("../../serviceAccountKey.json");

const workbookPath = path.resolve(__dirname, "..", "..", "Artikelliste.xlsx");
const databaseURL = "https://pakora-automations-chat-default-rtdb.europe-west1.firebasedatabase.app";
const shouldWrite = process.argv.includes("--write");

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

    if (primary) lastPrimary = primary;

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

function pickValue(row, candidates) {
  for (const key of candidates) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function parseNumber(value) {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  const normalized = String(value || "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return normalized ? Number(normalized[0]) : 0;
}

function normalizeCapacityValue(value) {
  const numeric = parseNumber(value);
  if (!numeric) return 0;
  return numeric > 0 && numeric < 100 ? Math.round(numeric * 1000) : Math.round(numeric);
}

function buildProductId(row, manufacturer, model) {
  const explicitId = String(pickValue(row, ["id", "artnr", "artikelnummer", "artikelnr", "artikelnummerid"])).trim();
  if (explicitId) return explicitId;

  return [
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
}

function buildProductName(row) {
  const manufacturer = String(pickValue(row, ["hersteller", "manufacturer", "marke"])).trim();
  const model = String(pickValue(row, ["modell", "model", "kompressor", "typ", "bezeichnung", "produkt", "artikel"])).trim();
  const explicitName = String(pickValue(row, ["name", "produktname"])).trim();
  return explicitName || [manufacturer, model].filter(Boolean).join(" ").trim() || model;
}

function inferCategory(rawCategory, productName) {
  const haystack = `${rawCategory || ""} ${productName || ""}`.toLowerCase();
  if (haystack.includes("verdampfer")) return "evaporator";
  if (haystack.includes("cp-box") || haystack.includes("cp box")) return "cp_box";
  if (haystack.includes("verfl") || haystack.includes("condensing")) return "condensing_unit";
  if (haystack.includes("kompressor") || haystack.includes("compressor")) return "compressor";
  return "accessory";
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
  const directNK = normalizeCapacityValue(pickValue(row, ["leistungnk10c", "leistungnk", "leistung10cwatt", "leistung10c", "te10c", "f"]));
  const directTK = normalizeCapacityValue(pickValue(row, ["leistungtk25c", "leistungtk", "leistung25cwatt", "leistung25c", "te25c", "g"]));
  const generic = String(pickValue(row, ["leistung"])).trim();

  let capacityNK = directNK;
  let capacityTK = directTK;
  const context = `${row.__sheet || ""} ${row.__section || ""}`.toLowerCase();

  if (!capacityNK && generic && generic.includes("-10")) capacityNK = normalizeCapacityValue(generic);
  if (!capacityTK && generic && generic.includes("-25")) capacityTK = normalizeCapacityValue(generic);
  if (!capacityNK && !capacityTK && generic) {
    if (context.includes("-10") || context.includes("normalk")) capacityNK = normalizeCapacityValue(generic);
    if (context.includes("-25") || context.includes("tiefk")) capacityTK = normalizeCapacityValue(generic);
  }

  return { capacityNK, capacityTK };
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
  const blocked = ["tk gesamt", "nk gesamt", "gesamt", "weiss", "weiß", "anthrazith", "grau beige"];
  if (blocked.includes(name)) return true;
  return !product.price && !product.qty && !product.capacityNK && !product.capacityTK;
}

async function main() {
  const workbook = xlsx.readFile(workbookPath);
  const rows = workbookToObjects(workbook);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL
    });
  }

  const existingSnapshot = await admin.database().ref("/products").get();
  const existingProducts = existingSnapshot.exists() ? existingSnapshot.val() : {};
  const existingKeysByMergeKey = new Map();
  Object.entries(existingProducts).forEach(([key, product]) => {
    const mergeKey = `${product.category || "accessory"}:${normalizeNameKey(product.name)}`;
    if (!normalizeNameKey(product.name)) return;
    if (!existingKeysByMergeKey.has(mergeKey)) existingKeysByMergeKey.set(mergeKey, key);
  });
  const importedProducts = new Map();

  rows.forEach((row) => {
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
  });

  const updates = {};
  let created = 0;
  let updated = 0;
  importedProducts.forEach((productData) => {
    const mergeKey = `${productData.category || "accessory"}:${normalizeNameKey(productData.name)}`;
    const matchedKey = existingKeysByMergeKey.get(mergeKey);
    const safeId = matchedKey || String(productData.id || productData.name).replace(/[.#$/\[\]]/g, "_");
    const existing = existingProducts[safeId] || {};
    updates[`/products/${safeId}`] = { ...existing, ...productData };
    if (existing && Object.keys(existing).length) updated++;
    else created++;
  });

  console.log(JSON.stringify({
    workbook: path.basename(workbookPath),
    sheets: workbook.SheetNames.length,
    parsedRows: rows.length,
    importableProducts: importedProducts.size,
    existingProducts: Object.keys(existingProducts).length,
    created,
    updated,
    mode: shouldWrite ? "write" : "dry-run"
  }, null, 2));

  if (!shouldWrite) return;
  if (!importedProducts.size) throw new Error("No importable products found.");

  await admin.database().ref().update(updates);
  console.log(`Imported ${importedProducts.size} products to /products.`);
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
