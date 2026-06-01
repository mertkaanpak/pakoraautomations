// Einmal-Helfer zum (Neu-)Verknuepfen von WhatsApp mit dem Bot.
// Zeigt den QR-Code als Bilddatei (whatsapp-qr.png) an und oeffnet sie.
// Nach erfolgreichem Scan wird die Session in .wwebjs_auth gespeichert –
// danach laeuft index.js (der eigentliche Bot) ohne erneuten Scan.
//
// Start:  node link-whatsapp.js
// Danach: mit WhatsApp Business (m.pak) -> Verknuepfte Geraete -> scannen.

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { exec } = require('child_process');
const path = require('path');

const QR_FILE = path.join(__dirname, 'whatsapp-qr.png');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox'] }
});

client.on('qr', async (qr) => {
    try {
        await QRCode.toFile(QR_FILE, qr, { width: 600, margin: 2 });
        console.log('\n==> QR-Code gespeichert als: ' + QR_FILE);
        console.log('==> Oeffne das Bild und scanne es mit WhatsApp Business (m.pak):');
        console.log('    WhatsApp -> Einstellungen -> Verknuepfte Geraete -> Geraet verknuepfen\n');
        exec('start "" "' + QR_FILE + '"', { shell: 'cmd.exe' });
    } catch (e) {
        console.error('Konnte QR-Bild nicht erstellen:', e.message);
    }
});

client.on('authenticated', () => {
    console.log('==> Authentifiziert! Session wird gespeichert ...');
});

client.on('ready', () => {
    console.log('\n*** ERFOLG: WhatsApp ist verknuepft und der Bot ist bereit! ***');
    console.log('Du kannst dieses Fenster jetzt mit STRG+C schliessen.');
    console.log('Danach uebernimmt PM2 den Dauerbetrieb.\n');
});

client.on('auth_failure', (msg) => {
    console.error('Authentifizierung fehlgeschlagen:', msg);
});

client.initialize();
