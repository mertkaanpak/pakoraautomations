// ============================================================
// auth.js – Pakora Automations – Zentrale Nutzerverwaltung
// ============================================================
// Neuen Mitarbeiter hinzufügen oder Passwort ändern?
// NUR DIESE DATEI bearbeiten – gilt automatisch für alle Seiten.
//
// Rollen: "admin" = voller Zugriff (inkl. WhatsApp-Bot)
//         "staff" = normaler Mitarbeiter-Zugriff

window.PAKORA_ACCOUNTS = {
    "m.pak":           { pass: "admin",  label: "Mert Kaan", role: "admin" },
    "k.guemuesok":     { pass: "pakora", label: "Kaan",      role: "staff" },
    "l.wenzel":        { pass: "pakora", label: "Leon",      role: "staff" },
    "\u00f6.pak":      { pass: "pakora", label: "\u00d6mer", role: "staff" },
    "oe.pak":          { pass: "pakora", label: "\u00d6mer", role: "staff" }
};

window.PAKORA_AUTH_KEY   = "pakora_auth_user";
window.PAKORA_ADMIN_USER = "m.pak";
