const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const OpenAI = require('openai');

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
    qrcode.generate(qr, { small: true });
    console.log('--> Bitte jetzt mit WhatsApp Business (m.pak) scannen!');
});

client.on('ready', () => {
    console.log('Pakora Bot ist ONLINE und bereit!');
});

// --- HAUPTLOGIK ---
client.on('message', async msg => {
    // Filter: Nur echte Chat-Nachrichten von anderen
    if (msg.fromMe || msg.isStatus || msg.type !== 'chat') return;

    const senderNumber = msg.from.replace('@c.us', '');

    // 1. Einstellungen aus Firebase lesen
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
    const chat = await msg.getChat();
    await chat.sendStateTyping();

    try {
        // 3. KI Logik
        const style = settings.styleSamples || "Freundlich, kurz, professionell.";

        const systemPrompt = `
      Du bist Mert (m.pak) von Pakora Automations.
      Antworte dem Kunden auf WhatsApp.
      
      DEIN SPRACHSTIL: "${style}"
      
      REGELN:
      1. Erkenne die Sprache (DE/EN/TR) und antworte in derselben Sprache.
      2. Wenn es um Angebote/Technik geht: "Wir kümmern uns und melden uns."
      3. Sei kurz und menschlich.
    `;

        const gptResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: msg.body }
            ],
            max_tokens: 150
        });

        const replyText = gptResponse.choices[0].message.content;

        // 4. Antworten
        await msg.reply(replyText);

        // 5. Speichern
        const chatContact = await msg.getContact();
        const senderName = chatContact.pushname || chatContact.name || '';
        
        await db.collection('whatsappRequests').add({
            phone: '+' + senderNumber,
            name: senderName,
            message: msg.body,
            reply: replyText,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'open',
            autoReplied: true
        });

        console.log(`[ANTWORT AN ${senderNumber}]: ${replyText}`);

    } catch (error) {
        console.error('Fehler:', error);
    }
});

client.initialize();
