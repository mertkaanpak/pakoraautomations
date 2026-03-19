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

// ============================================================
// Rollen-Hilfsfunktionen — von allen Seiten nutzbar
// ============================================================

window.pakoraGetCurrentUser = function () {
    try {
        return (localStorage.getItem(window.PAKORA_AUTH_KEY) || "").toLowerCase();
    } catch (e) { return ""; }
};

window.pakoraIsAdmin = function () {
    const user = window.pakoraGetCurrentUser();
    return (window.PAKORA_ACCOUNTS[user] || {}).role === "admin";
};

// Blendet/zeigt .only-mpak Elemente je nach Rolle
window.pakoraApplyRoles = function () {
    const isAdmin = window.pakoraIsAdmin();
    document.querySelectorAll(".only-mpak").forEach(function (el) {
        el.style.display = isAdmin ? "" : "none";
    });
};

// Automatisch nach dem DOM-Laden anwenden (für Seiten-Neuladen)
document.addEventListener("DOMContentLoaded", function () {
    const user = window.pakoraGetCurrentUser();
    if (window.PAKORA_ACCOUNTS[user]) {
        window.pakoraApplyRoles();
    }
});
