import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getContentType,
} from '@whiskeysockets/baileys';
import { GoogleGenAI } from '@google/genai';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import http from 'node:http';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY in .env');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const AUTO_VIEW_STATUS = true;
const REPLY_COOLDOWN_MS = 4000;
const PORT = Number(process.env.PORT) || 3000;
const VIEW_ONCE_TARGET_JID = process.env.VIEW_ONCE_TARGET_JID || '254116953857@s.whatsapp.net';
const DOWNLOAD_DIR = path.resolve('./view_once_downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const PERSONA_PROMPT = `
You are Phinehas (Phinehas Korir), a 19-year-old 2nd-year Software Engineering student(Murang'a University of Technology(MUT)) in Kenya.

Identity & Background:
- Your name is Phinehas. Never make up another name or say you're an AI/bot.
- You code (JavaScript/Node.js, C/C++, UNIX/bash, web dev, building bots) and you also trade on MT5/TradingView, and follow Premier League football, also play FIFA and PES.
- Keep your personal details natural—only mention what you do if it comes up in conversation.

Texting Style (CRITICAL):
- Text like a normal Kenyan uni guy on WhatsApp—casual, natural, short (1 to 2 short sentences max, or even a few words like "niaje", "niko poa", "sawa bro", "fr?", "yeah man" when it fits).
- Match the language and vibe of whoever texts you: if they use Sheng/Swahili, reply naturally with light Kenyan slang; if they text in plain English, keep it casual English.
- Never write long paragraphs, never use bullet points, and never sound like customer support or an AI ("How can I assist you?", "Let's see if I can fix it lol").
- Don't over-explain or volunteer to do work unless they actually ask.
- Use lowercase often and minimal punctuation, just like fast phone texts.
- Avoid emojis unless the other person uses them first, and even then, use them sparingly.
- Don't ever say you're an AI or a bot, and never mention that you use Gemini or any AI model.
- If asked about your age, say you're 19. If asked about your location, say you're in Kenya, woodcrest. If asked about your studies, say you're a 2nd-year Software Engineering student. If asked about your hobbies, mention coding, football, playing PES.
- If asked what are you upto and the time is after 1pm, say you're taking a nap or relaxing. If before 10am, say you're just waking up or getting ready for class or taking tea.
`;

const chatMemory = new Map();
const lastReplyAt = new Map();
const MAX_HISTORY = 10;
let botConnected = false;
let reconnecting = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startHealthServer() {
  http
    .createServer((req, res) => {
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            whatsappConnected: botConnected,
            uptimeSeconds: Math.floor(process.uptime()),
          })
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    })
    .listen(PORT, '0.0.0.0', () => {
      console.log(`🩺 Health server listening on port ${PORT}`);
    });
}

const MODEL_FALLBACKS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-4.0-hydrogen',
  'gemini-3.6-flash',
];

async function generateHumanReply(jid, incomingText) {
  if (!chatMemory.has(jid)) {
    chatMemory.set(jid, []);
  }
  const history = chatMemory.get(jid);

  history.push({ role: 'user', parts: [{ text: incomingText }] });
  while (history.length > MAX_HISTORY) {
    history.shift();
  }

  for (const modelName of MODEL_FALLBACKS) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: history,
        config: {
          systemInstruction: PERSONA_PROMPT,
          temperature: 0.85,
        },
      });

      const rawText = response.text?.trim();
const replyText = rawText?.replace(/<\/?[^>]+(>|$)/g, '').trim();
if (!replyText) continue;

history.push({ role: 'model', parts: [{ text: replyText }] });
      while (history.length > MAX_HISTORY) {
        history.shift();
      }

      return replyText;
    } catch (err) {
      console.warn(`⚠️ Model ${modelName} failed, trying next fallback:`, err.message);
    }
  }

  console.error('❌ All fallback models failed.');
  return null;
}


async function startBot() {
  reconnecting = false;
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp (Settings -> Linked Devices):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      botConnected = true;
      console.log('✅ Bot is online and listening!');
    }

    if (connection === 'close') {
      botConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ Connection closed (code: ${statusCode ?? 'unknown'}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect && !reconnecting) {
        reconnecting = true;
        setTimeout(() => startBot(), 3000);
      } else if (!shouldReconnect) {
        console.log('🛑 Logged out of WhatsApp. Delete ./auth_info and re-scan QR code.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      console.log('DEBUG event:', type, 'jid:', msg.key?.remoteJid, 'fromMe:', msg.key?.fromMe, 'hasMsg:', Boolean(msg.message));

      // View statuses with a 3-8s delay
      if (jid === 'status@broadcast') {
        if (AUTO_VIEW_STATUS && !msg.key.fromMe) {
          const poster = (msg.key.participant || 'unknown').split('@')[0];
          await sleep(Math.floor(Math.random() * 5000) + 3000);
          try {
            await sock.readMessages([msg.key]);
            console.log(`👀 Viewed status from ${poster}`);
          } catch (err) {
            console.error(`❌ Status view error (${poster}):`, err.message);
          }
        }
        continue;
      }

      // Reply to all DMs except groups, own messages, and non-DM chats
      if (jid.endsWith('@g.us') || jid.endsWith('@newsletter')) continue;
if (msg.key.fromMe) continue;
if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
const baseMessage =
  msg.message?.ephemeralMessage?.message ||
  msg.message?.associatedChildMessage?.message ||
  msg.message;

const viewOnceContent =
  baseMessage?.viewOnceMessage?.message ||
  baseMessage?.viewOnceMessageV2?.message ||
  baseMessage?.viewOnceMessageV2Extension?.message ||
  (baseMessage?.imageMessage?.viewOnce ? { imageMessage: baseMessage.imageMessage } : null) ||
  (baseMessage?.videoMessage?.viewOnce ? { videoMessage: baseMessage.videoMessage } : null) ||
  (baseMessage?.audioMessage?.viewOnce ? { audioMessage: baseMessage.audioMessage } : null);

if (!msg.message?.conversation && !msg.message?.extendedTextMessage?.text) {
  console.log('🔎 Non-text message keys:', {
    jid,
    topKeys: Object.keys(msg.message || {}),
    baseKeys: Object.keys(baseMessage || {}),
    hasViewOnce: Boolean(viewOnceContent),
  });
}

if (viewOnceContent) {
  try {
    const mediaType = getContentType(viewOnceContent);
    const mediaObj = viewOnceContent[mediaType];
    const captionText = mediaObj?.caption || '';

    const buffer = await downloadMediaMessage(
      { ...msg, message: viewOnceContent },
      'buffer',
      {},
      { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
    );

    const ext =
      mediaType === 'imageMessage' ? 'jpg' :
      mediaType === 'videoMessage' ? 'mp4' :
      mediaType === 'audioMessage' ? 'ogg' : 'bin';

    const fileName = `viewonce_${Date.now()}.${ext}`;
    const filePath = path.join(DOWNLOAD_DIR, fileName);
    fs.writeFileSync(filePath, buffer);

    const sendPayload =
      mediaType === 'imageMessage'
        ? {
            image: buffer,
            caption: captionText
              ? `👁️ From ${jid}: ${captionText}`
              : `👁️ View-once photo from ${jid}`,
          }
        : mediaType === 'videoMessage'
          ? {
              video: buffer,
              caption: captionText
                ? `👁️ From ${jid}: ${captionText}`
                : `👁️ View-once video from ${jid}`,
            }
          : {
              audio: buffer,
              ptt: Boolean(mediaObj?.ptt),
              mimetype: mediaObj?.mimetype || 'audio/ogg; codecs=opus',
            };

    await sock.sendMessage(VIEW_ONCE_TARGET_JID, sendPayload);
    console.log(`✅ Sent view-once ${mediaType} to ${VIEW_ONCE_TARGET_JID} (saved: ${fileName})`);
  } catch (err) {
    console.error('❌ Failed to process view-once media:', err.message);
  }
  continue;
}
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text;

      if (!text || !text.trim()) continue;

      const now = Date.now();
      const prevReply = lastReplyAt.get(jid) || 0;
      if (now - prevReply < REPLY_COOLDOWN_MS) continue;

      const sender = jid.split('@')[0];
      console.log(`📩 [${sender}]: ${text}`);

      try {
        await sleep(Math.floor(Math.random() * 1500) + 1000);
        await sock.readMessages([msg.key]);

        await sock.sendPresenceUpdate('composing', jid);
        const reply = await generateHumanReply(jid, text.trim());

        if (reply) {
          const typingTime = Math.min(Math.max(reply.length * 50, 1500), 5000);
          await sleep(typingTime);

          await sock.sendPresenceUpdate('paused', jid);
          await sock.sendMessage(jid, { text: reply });
          lastReplyAt.set(jid, Date.now());
          console.log(`📤 [Bot -> ${sender}]: ${reply}`);
        } else {
          await sock.sendPresenceUpdate('paused', jid);
        }
      } catch (err) {
        console.error(`❌ Error replying to ${sender}:`, err.message);
      }
    }
  });
}

startHealthServer();
startBot();

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down...');
  process.exit(0);
});