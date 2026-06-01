// ============================================================
// auth.js – Pakora Automations – Zentrale Nutzerverwaltung
// ============================================================
// Login läuft jetzt über Firebase Authentication.
// Passwörter stehen NICHT mehr im Code. Neue Mitarbeiter werden
// über das Seed-Skript (functions/tools/seed-auth-users.js) bzw.
// in der Firebase-Konsole angelegt.
//
// Hier wird nur noch festgelegt:
//   - welche Benutzernamen es gibt (für Anzeige-Namen & Rollen)
//   - wer Admin ist
//
// Rollen: "admin" = voller Zugriff (inkl. WhatsApp-Bot)
//         "staff" = normaler Mitarbeiter-Zugriff

window.PAKORA_ACCOUNTS = {
    "m.pak":       { label: "Mert Kaan", role: "admin" },
    "k.guemuesok": { label: "Kaan",      role: "staff" },
    "l.wenzel":    { label: "Leon",      role: "staff" },
    "oe.pak":      { label: "Ömer", role: "staff" },
    "ö.pak":  { label: "Ömer", role: "staff" }
};

window.PAKORA_AUTH_KEY   = "pakora_auth_user";
window.PAKORA_ADMIN_USER = "m.pak";

// Synthetische E-Mail-Domain – Mitarbeiter loggen sich weiterhin mit
// ihrem Benutzernamen ein, intern wird daraus username@pakora.local.
window.PAKORA_EMAIL_DOMAIN = "pakora.local";

window.PAKORA_FIREBASE_CONFIG = {
    apiKey: "AIzaSyCjIggzBA4NaMNm1FSfTUzvZLBquvd9P40",
    authDomain: "pakora-automations-chat.firebaseapp.com",
    databaseURL: "https://pakora-automations-chat-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "pakora-automations-chat",
    storageBucket: "pakora-automations-chat.firebasestorage.app",
    messagingSenderId: "281325034328",
    appId: "1:281325034328:web:e05c04bac6b8558560632d"
};

// ============================================================
// Interne Helfer
// ============================================================

// Benutzername -> interne E-Mail. "ö.pak" wird auf "oe.pak" normalisiert.
window.pakoraEmailFor = function (userId) {
    const clean = String(userId || "").trim().toLowerCase().replace(/ö/g, "oe");
    return clean + "@" + window.PAKORA_EMAIL_DOMAIN;
};

// E-Mail -> Benutzername (für wiederkehrende Sitzungen ohne localStorage)
window.pakoraUserFromEmail = function (email) {
    return String(email || "").split("@")[0].toLowerCase();
};

function pakoraEnsureFirebase() {
    if (typeof firebase === "undefined") {
        throw new Error("Firebase-SDK nicht geladen. <script firebase-app> + <script firebase-auth> einbinden.");
    }
    if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(window.PAKORA_FIREBASE_CONFIG);
    }
    return firebase;
}
window.pakoraEnsureFirebase = pakoraEnsureFirebase;

// ============================================================
// Öffentliche Login-API – von allen Seiten nutzbar
// ============================================================

// Loggt ein. Gibt ein Promise zurück (resolve = Benutzername, reject = Fehler).
window.pakoraLogin = function (userId, password) {
    const fb = pakoraEnsureFirebase();
    const email = window.pakoraEmailFor(userId);
    return fb.auth().signInWithEmailAndPassword(email, password).then(function (cred) {
        const uname = window.pakoraUserFromEmail(cred.user.email);
        try { localStorage.setItem(window.PAKORA_AUTH_KEY, uname); } catch (e) {}
        return uname;
    });
};

window.pakoraLogout = function () {
    try { localStorage.removeItem(window.PAKORA_AUTH_KEY); } catch (e) {}
    try {
        const fb = pakoraEnsureFirebase();
        return fb.auth().signOut();
    } catch (e) {
        return Promise.resolve();
    }
};

// Liefert den aktuellen Firebase-ID-Token (für authentifizierte
// Aufrufe der Cloud Functions). Gibt "" zurück, wenn nicht eingeloggt.
window.pakoraIdToken = function () {
    try {
        const fb = pakoraEnsureFirebase();
        const user = fb.auth().currentUser;
        if (!user) return Promise.resolve("");
        return user.getIdToken();
    } catch (e) {
        return Promise.resolve("");
    }
};

// Callback bei jeder Änderung des Login-Status: cb(username | null)
window.pakoraOnAuth = function (cb) {
    const fb = pakoraEnsureFirebase();
    return fb.auth().onAuthStateChanged(function (user) {
        if (user && user.email) {
            const uname = window.pakoraUserFromEmail(user.email);
            try { localStorage.setItem(window.PAKORA_AUTH_KEY, uname); } catch (e) {}
            cb(uname);
        } else {
            try { localStorage.removeItem(window.PAKORA_AUTH_KEY); } catch (e) {}
            cb(null);
        }
    });
};

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

document.addEventListener("DOMContentLoaded", function () {
    const user = window.pakoraGetCurrentUser();
    if (window.PAKORA_ACCOUNTS[user]) {
        window.pakoraApplyRoles();
    }
});
