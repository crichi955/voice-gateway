import OpenAI from "openai";
import wavefilePkg from "wavefile";
import alawmulawPkg from "alawmulaw";

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const { WaveFile } = wavefilePkg;
const { mulaw } = alawmulawPkg;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.status(200).send("ok"));

// Keep a small in-memory mapping from CallSid -> From (phone number)
// so that we can send WhatsApp back when the WS 'start' arrives.
const callSidToFrom = new Map();

function parseBool(v) {
  return String(v ?? "").toLowerCase() === "true";
}

const KILL_SWITCH_ENABLED = parseBool(process.env.KILL_SWITCH);
let killNow = false;
if (KILL_SWITCH_ENABLED) {
  console.log("🛑 KILL_SWITCH enabled: will disable everything in 10s...");
  setTimeout(() => {
    killNow = true;
    console.log("🛑 KILL_SWITCH ACTIVE: disabling voice pipeline now.");
  }, 10_000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toWhatsAppTo(fromNumber) {
  if (!fromNumber) return null;
  const n = String(fromNumber).trim();
  if (!n) return null;
  return n.startsWith("whatsapp:") ? n : `whatsapp:${n}`;
}

function buildTwimlConnect(wsUrl) {
  // Twilio will start streaming as soon as the WS handshake is complete.
  // We keep the Twilio transport simple; audio playback is handled by our WS.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" track="both" />
  </Connect>
</Response>`;
}

function twimlSayAndHangup(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${text}</Say>
  <Hangup/>
</Response>`;
}

// Twilio Voice webhook (incoming call) -> TwiML that starts Media Streams
app.post("/twilio/voice", async (req, res) => {
  try {
    const callSid = req.body?.CallSid;
    const from = req.body?.From;
    if (callSid) callSidToFrom.set(callSid, from);

    if (killNow) {
      res.type("text/xml").send(twimlSayAndHangup("Service temporairement indisponible."));
      return;
    }

    // Build WS URL based on the webhook request host.
    // Twilio must reach this WS endpoint publicly (Render/ngrok/etc.).
    const host = req.get("host");
    const forwardedProto = req.get("x-forwarded-proto");
    const isSecure = (forwardedProto && forwardedProto.includes("https")) || req.secure;
    const proto = isSecure ? "wss" : "ws";
    const wsUrl = `${proto}://${host}/twilio`;

    res.type("text/xml").send(buildTwimlConnect(wsUrl));
  } catch (err) {
    console.log("❌ /twilio/voice error:", err?.message || err);
    res.type("text/xml").send(twimlSayAndHangup("Erreur interne."));
  }
});

const server = http.createServer(app);

// WebSocket endpoint for Twilio Media Streams (bidirectional)
const wss = new WebSocketServer({ server, path: "/twilio" });

async function sendWhatsApp({ to, body }) {
  if (!to) {
    console.log("⚠️ WhatsApp skipped: missing recipient number.");
    return;
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.WHATSAPP_FROM;
  if (!accountSid || !authToken || !from) {
    console.log("⚠️ WhatsApp skipped: missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / WHATSAPP_FROM.");
    return;
  }

  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const form = new URLSearchParams({ From: from, To: to, Body: body });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Twilio WhatsApp error: ${resp.status} ${resp.statusText} ${txt}`);
  }
}

async function elevenLabsTextToMuLaw8000(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID.");
  }

  // ulaw_8000 is the native Twilio telephony format (single channel μ-law 8kHz).
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs error: ${resp.status} ${resp.statusText} ${txt}`);
  }

  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function playMuLawToTwilio(ws, streamSid, muLawBuffer) {
  if (!streamSid) return;
  // 20ms @ 8000 Hz => 160 bytes (μ-law is 8-bit/byte).
  const CHUNK_BYTES = 160;

  for (let i = 0; i < muLawBuffer.length; i += CHUNK_BYTES) {
    if (killNow) return;
    const chunk = muLawBuffer.subarray(i, i + CHUNK_BYTES);
    const payload = Buffer.from(chunk).toString("base64");
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload },
      })
    );
    // Throttle so Twilio receives in real-time.
    await sleep(20);
  }
}

async function playText(ws, session, text) {
  const muLaw = await elevenLabsTextToMuLaw8000(text);
  await playMuLawToTwilio(ws, session.streamSid, muLaw);
}

async function callN8nForTurn({ transcript, session }) {
  const brainUrl = process.env.N8N_BRAIN_URL;
  if (!brainUrl) throw new Error("Missing N8N_BRAIN_URL.");

  const controller = new AbortController();
  const timeoutMs = 5_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    call: { provider: "twilio", streamSid: session.streamSid, callSid: session.callSid },
    turn: { text: transcript },
    state: {},
  };

  try {
    const resp = await fetch(brainUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`n8n error: ${resp.status} ${resp.statusText} ${txt}`);
    }
    const data = await resp.json();
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

wss.on("connection", (ws) => {
  console.log("✅ Twilio WS connected");

  const SEGMENT_MS = Number(process.env.STT_SEGMENT_MS || 4000);
  const STREAM_SAMPLE_RATE = 8000; // Twilio μ-law 8kHz
  const MIN_BYTES_TO_TRANSCRIBE = Number(process.env.STT_MIN_BYTES || 800);

  const session = {
    callSid: null,
    streamSid: null,
    fromNumber: null,
    mediaCount: 0,
    audioChunks: [],
    audioBytes: 0,
    lastFlushTs: Date.now(),
    sttPaused: false,
    responded: false,
    n8nInFlight: false,
  };

  async function degradedFallback(wsToUse, sessionToUse, reason) {
    if (sessionToUse.responded) return;
    sessionToUse.responded = true;
    sessionToUse.sttPaused = true;

    console.log("⚠️ Degraded mode:", reason);

    const shortVoice =
      process.env.DEGRADED_VOICE_TEXT ||
      "Désolé, un problème technique est survenu. Pour continuer, veuillez consulter le lien WhatsApp que je vous envoie maintenant.";

    try {
      await playText(wsToUse, sessionToUse, shortVoice);
    } catch (err) {
      console.log("❌ TTS degraded error:", err?.message || err);
    }

    try {
      const to = toWhatsAppTo(sessionToUse.fromNumber);
      const link = process.env.WHATSAPP_FALLBACK_URL;
      if (link) {
        await sendWhatsApp({
          to,
          body: `Voici le lien pour la suite : ${link}`,
        });
      } else {
        console.log("⚠️ WHATSAPP_FALLBACK_URL not set; WhatsApp not sent.");
      }
    } catch (err) {
      console.log("❌ WhatsApp degraded error:", err?.message || err);
    }
  }

  ws.on("message", async (msg) => {
    let evt;
    const text =
      Buffer.isBuffer(msg)
        ? msg.toString("utf8")
        : typeof msg === "string"
          ? msg
          : msg?.toString
            ? msg.toString()
            : String(msg);

    try {
      evt = JSON.parse(text);
    } catch (e) {
      console.log("⚠️ JSON parse failed:", e.message);
      console.log("⚠️ raw (first 200):", text.slice(0, 200));
      return;
    }

    if (killNow) return;

    // START
    if (evt.event === "start") {
      session.callSid = evt.start?.callSid || evt.start?.call_sid || null;
      session.streamSid = evt.streamSid || evt.start?.streamSid || null;
      session.fromNumber = session.callSid ? callSidToFrom.get(session.callSid) : null;

      console.log("▶️ start", { callSid: session.callSid, streamSid: session.streamSid });

      // Welcome message at start (ElevenLabs)
      try {
        if (!session.responded) {
          const welcomeText =
            process.env.WELCOME_TEXT ||
            "Bonjour et bienvenue au cabinet du Dr Crichi à Saint-Cloud. Dites-moi votre question, et je vous aide du mieux possible.";
          await playText(ws, session, welcomeText);
        }
      } catch (err) {
        console.log("❌ Welcome TTS error:", err?.message || err);
        // If welcome fails, we still try to do the rest.
      }

      return;
    }

    // MEDIA
    if (evt.event === "media") {
      if (!session.streamSid) return;
      if (session.sttPaused || session.responded) return;

      session.mediaCount++;

      // Twilio sends μ-law 8kHz payload (base64)
      const b64 = evt.media?.payload;
      if (b64) {
        const chunk = Buffer.from(b64, "base64");
        session.audioChunks.push(chunk);
        session.audioBytes += chunk.length;
      }

      const now = Date.now();
      if (now - session.lastFlushTs < SEGMENT_MS) return;
      session.lastFlushTs = now;

      if (session.audioBytes < MIN_BYTES_TO_TRANSCRIBE) return;

      const ulawBuffer = Buffer.concat(session.audioChunks, session.audioBytes);
      session.audioChunks = [];
      session.audioBytes = 0;

      // Transcribe only once per "turn" (first non-empty transcript wins)
      if (session.n8nInFlight || session.responded) return;
      session.n8nInFlight = true;

      try {
        // μ-law -> PCM16 (Int16Array)
        const pcm = mulaw.decode(ulawBuffer);

        // PCM16 -> WAV
        const wav = new WaveFile();
        wav.fromScratch(1, STREAM_SAMPLE_RATE, "16", pcm);
        const wavBuffer = Buffer.from(wav.toBuffer());

        const model = process.env.STT_MODEL || "whisper-1";
        const language = process.env.STT_LANGUAGE || "fr";

        const transcriptResp = await openai.audio.transcriptions.create({
          file: new File([wavBuffer], "audio.wav", { type: "audio/wav" }),
          model,
          language,
        });

        const transcript = (transcriptResp.text || "").trim();
        console.log("📝 transcript:", transcript);

        if (!transcript) {
          session.n8nInFlight = false;
          return;
        }

        session.sttPaused = true;

        const brainJson = await callN8nForTurn({ transcript, session });
        console.log("🧠 n8n reply:", brainJson);

        const action = brainJson?.action;
        const textToSpeak = brainJson?.text;
        const whatsappUrl = brainJson?.whatsappUrl;

        if (killNow) return;

        session.responded = true;
        session.n8nInFlight = false;

        if (!action || !textToSpeak) {
          await degradedFallback(ws, session, "n8n invalid response");
          return;
        }

        if (action === "answer") {
          await playText(ws, session, textToSpeak);
          return;
        }

        if (action === "fallback") {
          await playText(ws, session, textToSpeak);
          const to = toWhatsAppTo(session.fromNumber);
          const url = whatsappUrl || process.env.WHATSAPP_FALLBACK_URL;
          if (to && url) {
            await sendWhatsApp({ to, body: `Voici le lien pour la suite : ${url}` });
          } else {
            console.log("⚠️ WhatsApp not sent (missing to or fallback url).");
          }
          return;
        }

        if (action === "urgence") {
          await playText(ws, session, textToSpeak);
          // n8n gère la détection; ici on joue le message.
          return;
        }

        // Unknown action
        await degradedFallback(ws, session, "unknown action");
      } catch (err) {
        session.n8nInFlight = false;
        // Timeout or pipeline failure => degraded fallback
        await degradedFallback(ws, session, err?.name === "AbortError" ? "n8n timeout" : "pipeline error");
      }

      return;
    }

    // STOP
    if (evt.event === "stop") {
      console.log("⏹️ stop", evt.stop);
      console.log(`✅ total media packets: ${session.mediaCount}`);
      return;
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WS closed");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway listening on :${PORT}`);
});