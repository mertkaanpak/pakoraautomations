# Pakora Automations — Setup & Konfiguration

## Firebase Functions Config

Alle API-Keys und Zugangsdaten werden **sicher in Firebase** gespeichert.
Sie stehen nie im Code oder auf GitHub.

### Keys setzen (einmalig nötig):

```bash
# OpenAI API Key (für KI-Verdichtersuche & WhatsApp-Bot)
firebase functions:config:set openai.key="sk-proj-..."

# Microsoft OneDrive (für Excel-Synchronisierung)
firebase functions:config:set onedrive.client_id="..."
firebase functions:config:set onedrive.client_secret="..."
firebase functions:config:set onedrive.refresh_token="..."
firebase functions:config:set onedrive.tenant_id="consumers"
firebase functions:config:set onedrive.excel_path="/Pfad/zur/Datei.xlsx"
firebase functions:config:set onedrive.export_path="/Pfad/zum/Export.xlsx"

# WhatsApp Business API (für Webhook)
firebase functions:config:set whatsapp.token="..."
firebase functions:config:set whatsapp.phone_id="..."
firebase functions:config:set whatsapp.verify_token="..."
```

### Aktuell gesetzte Keys prüfen:
```bash
firebase functions:config:get
```

### Nach Änderungen neu deployen:
```bash
firebase deploy --only functions
```

---

## Lokale Entwicklung

Für lokale Tests (firebase emulators) muss eine `.runtimeconfig.json` erstellt werden:

```bash
firebase functions:config:get > functions/.runtimeconfig.json
```

Diese Datei ist in `.gitignore` — nie committen!

---

## Sicherheitshinweise

| Datei | Status | Aktion |
|---|---|---|
| `serviceAccountKey.json` | Lokal, nicht auf GitHub | Sicher aufbewahren |
| `config.json` | Lokal, nicht auf GitHub | Enthält alten OpenAI Key — ggf. in OpenAI Dashboard widerrufen |
| `auth.js` | Auf GitHub | Passwörter im Code — Firebase Auth als langfristiger Ersatz geplant |
| `.gitignore` | Konfiguriert | Alle kritischen Dateien gesperrt |

### Wichtig: config.json
Die Datei `config.json` enthält einen **anderen OpenAI Key** als der in Firebase.
Falls dieser Key nie genutzt wurde: Bitte im [OpenAI Dashboard](https://platform.openai.com/api-keys) widerrufen.

---

## Mitarbeiter verwalten

Nutzernamen und Passwörter **nur in einer Datei** ändern:

```
public/auth.js  →  window.PAKORA_ACCOUNTS = { ... }
```

Danach `firebase deploy --only hosting` ausführen.
