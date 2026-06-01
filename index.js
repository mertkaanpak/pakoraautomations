const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./config.json');

// --- KONFIGURATION ---

// 1. OpenAI API Key wird aus der config.json geladen
const openai = new OpenAI({
    apiKey: config.openaiApiKey,
});

// 2. Firebase Setup
// Jetzt holen wir uns die Datei, die du gerade umbenannt hast
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    console.error("FEHLER: 'serviceAccountKey.json' fehlt oder ist kaputt.");
    process.exit(1);
}

const db = admin.firestore();

// --- WHATSAPP CLIENT SETUP ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('QR CODE WIRD GENERIERT...');
    qrcode.generate(qr, { small: false });
    console.log('--> Bitte jetzt mit WhatsApp Business (m.pak) scannen!');
});

client.on('ready', () => {
    console.log('Pakora Bot ist ONLINE und bereit!');
});

// --- HAUPTLOGIK ---

// Antwort-Bremse: mehrere schnell hintereinander gesendete Nachrichten pro Chat
// werden gesammelt und gebuendelt EINMAL beantwortet (statt 3x einzeln).
const DEBOUNCE_MS = 7000;
const pendingByChat = new Map();

// Schluesselwoerter, bei denen der Bot an Mert uebergibt statt selbst zu antworten.
const HANDOVER_KEYWORDS = [
    'echte person', 'echten menschen', 'mit jemandem sprechen', 'mit jemanden sprechen',
    'mit dir sprechen', 'mit mert', 'mert sprechen', 'persoenlich', 'persönlich',
    'anrufen', 'rückruf', 'rueckruf', 'ruf mich', 'ruft mich', 'telefon', 'telefonisch',
    'kein bot', 'echter mensch', 'mitarbeiter', 'real person', 'call me',
    'speak to a human', 'talk to a human'
];

client.on('message', async msg => {
    // Filter: keine eigenen Nachrichten, keine Status-Updates.
    if (msg.fromMe || msg.isStatus) return;
    // Nur unterstuetzte Typen: Text, Sprachnachricht, Bild.
    if (!['chat', 'ptt', 'audio', 'image'].includes(msg.type)) return;

    const chatId = msg.from;
    let entry = pendingByChat.get(chatId);
    if (!entry) {
        entry = { messages: [], timer: null };
        pendingByChat.set(chatId, entry);
    }
    entry.messages.push(msg);

    // Timer zuruecksetzen: erst wenn fuer DEBOUNCE_MS Ruhe herrscht, wird geantwortet.
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { handleBatch(chatId); }, DEBOUNCE_MS);
});

// Verarbeitet alle gepufferten Nachrichten eines Chats gebuendelt.
async function handleBatch(chatId) {
    const entry = pendingByChat.get(chatId);
    pendingByChat.delete(chatId);
    if (!entry || entry.messages.length === 0) return;

    const messages = entry.messages;
    const lastMsg = messages[messages.length - 1];
    const senderNumber = chatId.replace('@c.us', '');

    try {
        // 1. Einstellungen lesen (VOR allen kostenpflichtigen OpenAI-Aufrufen).
        const settingsDoc = await db.collection('whatsappBotSettings').doc('global').get();
        const settings = settingsDoc.exists ? settingsDoc.data() : { enabled: false };

        // CHECK: Ist Bot an?
        if (!settings.enabled) return;

        // CHECK: Ist Nummer blockiert?
        if (settings.excludedNumbers && settings.excludedNumbers.includes('+' + senderNumber)) {
            console.log(`Blockierte Nummer: ${senderNumber}`);
            return;
        }

        // 2. "Tippt..." anzeigen
        const chat = await lastMsg.getChat();
        await chat.sendStateTyping();

        // 3. Eingehende Nachrichten aufbereiten:
        //    Text direkt, Sprachnachricht -> Whisper-Transkript, Bild -> Vision-Anhang.
        let combinedText = '';
        const imageParts = [];
        for (const m of messages) {
            if (m.type === 'chat') {
                if (m.body) combinedText += (combinedText ? '\n' : '') + m.body;
            } else if (m.type === 'ptt' || m.type === 'audio') {
                const transcript = await transcribeVoice(m);
                if (transcript) combinedText += (combinedText ? '\n' : '') + transcript;
            } else if (m.type === 'image') {
                try {
                    const media = await m.downloadMedia();
                    if (media && media.data) {
                        imageParts.push({
                            type: 'image_url',
                            image_url: { url: `data:${media.mimetype};base64,${media.data}` }
                        });
                    }
                } catch (e) {
                    console.error('Konnte Bild nicht laden:', e.message);
                }
                if (m.body) combinedText += (combinedText ? '\n' : '') + m.body; // Bildunterschrift
            }
        }

        // Nichts Verwertbares (z.B. Transkription fehlgeschlagen, kein Bild): abbrechen.
        if (!combinedText && imageParts.length === 0) {
            console.log(`Keine verwertbare Nachricht von ${senderNumber}`);
            return;
        }

        // 4. Uebergabe an Mensch: bei Schluesselwoertern nicht selbst antworten.
        const lower = combinedText.toLowerCase();
        if (combinedText && HANDOVER_KEYWORDS.some(w => lower.includes(w))) {
            await markForHuman(lastMsg, senderNumber, combinedText);
            return;
        }

        // 5. Chat-Verlauf lesen (Kontext + Merts Stil aus genau diesem Chat).
        let history = [];
        const bufferedIds = new Set(messages.map(m => m.id.id));
        try {
            const fetched = await chat.fetchMessages({ limit: 30 });
            history = fetched
                .filter(m => m.type === 'chat' && m.body && !bufferedIds.has(m.id.id))
                .map(m => ({ role: m.fromMe ? 'assistant' : 'user', content: m.body }));
        } catch (e) {
            console.error('Konnte Chat-Verlauf nicht laden:', e.message);
        }

        // 6. Stilprofil: Merts Nachrichten chat-uebergreifend sammeln, damit auch
        //    Neukontakte ohne Verlauf in seinem Stil beantwortet werden.
        const styleProfile = Array.isArray(settings.styleProfile) ? settings.styleProfile : [];
        const myFromThisChat = history.filter(h => h.role === 'assistant').map(h => h.content);
        const mergedProfile = Array.from(new Set([...styleProfile, ...myFromThisChat]))
            .filter(s => s && s.length <= 200)
            .slice(-40);
        if (mergedProfile.length !== styleProfile.length) {
            db.collection('whatsappBotSettings').doc('global')
                .update({ styleProfile: mergedProfile })
                .catch(e => console.error('styleProfile-Update fehlgeschlagen:', e.message));
        }

        // 7. KI Logik
        // Bevorzugt den in der Oberflaeche (whatsapp_bot.html) gepflegten
        // customPrompt. Faellt nur zurueck, wenn keiner gesetzt ist.
        const customPrompt = (settings.customPrompt || "").trim();
        const style = settings.styleSamples || "Freundlich, kurz, professionell.";

        const basePrompt = customPrompt || `
      Du bist der freundliche Kollege/Assistent von Mert bei Pakora Automations
      und antwortest dem Kunden auf WhatsApp.

      DEIN SPRACHSTIL: "${style}"

      REGELN:
      1. Erkenne die Sprache (DE/EN/TR) und antworte in derselben Sprache.
      2. Sei kurz, menschlich und hilfsbereit.
      3. Bei verbindlichen Angeboten/Preisen: zusagen, dass du es mit Mert anschaust
         und ihr euch meldet. Fachfragen darfst du aber direkt beantworten.
    `;

        // Rolle: gilt IMMER, auch wenn in der Oberflaeche ein eigener customPrompt
        // gesetzt ist. Der Bot tritt als Merts Mitarbeiter auf, nicht als Mert selbst.
        const personaInstruction = `

DEINE ROLLE (immer beachten):
Du bist NICHT Mert selbst, sondern sein freundlicher Kollege/Mitarbeiter bei Pakora Automations.
Mert ist gerade in einem Gespraech und kann nicht direkt antworten. Stelle dich nur beim
ERSTEN Kontakt in diesem Chat kurz so vor: Mert ist gerade im Gespraech, aber du hilfst gerne
weiter - und frage freundlich, worum es geht bzw. welche Fragen es gibt (z.B. "Worum geht's
denn? Womit kann ich helfen?"). Gibt es im Verlauf schon Nachrichten, wiederhole diese
Vorstellung NICHT, sondern beantworte einfach die Frage.

Beantworte die Fragen danach selbst, soweit moeglich:
- Kaeltetechnik (Kuehlraeume, Verdichter, Kaelteanlagen, Auslegung, Geraete): fachlich und hilfreich beantworten.
- Lager-/Verfuegbarkeitsanfragen ("Habt ihr X auf Lager?"): hilfsbereit antworten; wenn du es
  nicht sicher weisst, sag zu, dass du es pruefst bzw. Mert sich dazu meldet.`;

        const profileText = mergedProfile.length
            ? `\n\nSO SCHREIBT MERT TYPISCHERWEISE (echte Beispiele aus Chats, ahme genau diesen Stil/Ton nach):\n- ${mergedProfile.slice(-25).join('\n- ')}`
            : '';

        // Stil-Anweisung: zwingt das Modell, aus dem Verlauf Merts Ton zu lernen.
        const styleInstruction = `

WICHTIG - SCHREIBSTIL NACHAHMEN:
Die bisherigen Nachrichten mit der Rolle "assistant" in diesem Chat stammen aus dem Pakora-Team
(meist von Mert). Lies den gesamten Verlauf und uebernimm genau diesen Ton: Wortwahl, Satzlaenge,
Begruessung/Verabschiedung, Emojis, Dialekt und Stil. Du sprichst aber als Merts Kollege, nicht als
Mert selbst. Gibt es noch keine Beispiele im Verlauf, nutze die Beispiele unten.
Beziehe dich auf den bisherigen Gespraechsverlauf und wiederhole keine Fragen, die schon geklaert sind.
Wenn ein Bild geschickt wurde, gehe konkret darauf ein (z.B. Geraet/Typenschild beschreiben).`;

        const systemPrompt = basePrompt + personaInstruction + styleInstruction + profileText;

        // Bei Bildern muss content ein Array (Text + Bilder) sein, sonst reicht Text.
        const userContent = imageParts.length > 0
            ? [{ type: 'text', text: combinedText || 'Bitte schau dir das Bild an.' }, ...imageParts]
            : combinedText;

        const gptResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemPrompt },
                ...history,
                { role: "user", content: userContent }
            ],
            max_tokens: 300
        });

        const replyText = gptResponse.choices[0].message.content;

        // 8. Antworten
        await lastMsg.reply(replyText);

        // 9. Speichern
        const chatContact = await lastMsg.getContact();
        const senderName = chatContact.pushname || chatContact.name || '';

        await db.collection('whatsappRequests').add({
            phone: '+' + senderNumber,
            name: senderName,
            message: combinedText || '[Bild]',
            reply: replyText,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'open',
            autoReplied: true
        });

        console.log(`[ANTWORT AN ${senderNumber}]: ${replyText}`);

    } catch (error) {
        console.error('Fehler:', error);
    }
}

// Wandelt eine WhatsApp-Sprachnachricht per OpenAI Whisper in Text um.
async function transcribeVoice(m) {
    let tmpFile = null;
    try {
        const media = await m.downloadMedia();
        if (!media || !media.data) return '';
        const ext = (media.mimetype && media.mimetype.includes('ogg')) ? 'ogg' : 'mp3';
        tmpFile = path.join(os.tmpdir(), `wa-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        fs.writeFileSync(tmpFile, Buffer.from(media.data, 'base64'));
        const result = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tmpFile),
            model: 'whisper-1'
        });
        return (result && result.text) ? result.text.trim() : '';
    } catch (e) {
        console.error('Sprachnachricht-Transkription fehlgeschlagen:', e.message);
        return '';
    } finally {
        if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (e) {} }
    }
}

// Markiert einen Chat zur persoenlichen Bearbeitung durch Mert (keine KI-Antwort).
async function markForHuman(lastMsg, senderNumber, combinedText) {
    try {
        const contact = await lastMsg.getContact();
        const senderName = contact.pushname || contact.name || '';
        await lastMsg.reply('Alles klar, ich gebe das direkt an Mert weiter - er meldet sich persoenlich bei dir. 🙏');
        await db.collection('whatsappRequests').add({
            phone: '+' + senderNumber,
            name: senderName,
            message: combinedText,
            reply: '',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'open',
            needsHuman: true,
            autoReplied: false
        });
        console.log(`[UEBERGABE AN MENSCH] ${senderNumber}`);
    } catch (e) {
        console.error('Uebergabe fehlgeschlagen:', e.message);
    }
}

client.initialize();

// Sauberes Herunterfahren: schliesst Chromium, damit bei pm2 restart/stop
// keine verwaisten Browser-Prozesse die WhatsApp-Session blockieren.
let shuttingDown = false;
async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Bot wird beendet, schliesse WhatsApp-Client ...');
    try { await client.destroy(); } catch (e) {}
    process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('message', (m) => { if (m === 'shutdown') gracefulShutdown(); });
