import OpenAI from "openai";

import express from "express";
import multer from "multer";
import http from "http";
import { writeFile, readFile } from "node:fs/promises";
import WebSocket, { WebSocketServer } from "ws";
import { performance } from "node:perf_hooks";
import nodemailer from "nodemailer";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

const testSttUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/test-stt", testSttUpload.single("file"), async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({ error: "OPENAI_API_KEY is not configured (required for /test-stt)." });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: "Multipart field 'file' with audio data is required." });
    }
    const model = process.env.STT_MODEL || "whisper-1";
    const language = process.env.STT_LANGUAGE || "fr";
    const file = new File(
      [req.file.buffer],
      req.file.originalname || "audio",
      { type: req.file.mimetype || "application/octet-stream" }
    );
    const transcriptResp = await openai.audio.transcriptions.create({
      file,
      model,
      language,
    });
    const transcript = (transcriptResp.text || "").trim();
    return res.json({ transcript });
  } catch (err) {
    console.log("❌ /test-stt error:", err?.message || err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

// Keep a small in-memory mapping from CallSid -> caller metadata
// so that we can reuse it when the WS 'start' arrives.
const callSidToCaller = new Map();
let smtpTransport = null;

function parseBool(v) {
  return String(v ?? "").toLowerCase() === "true";
}

const KILL_SWITCH_ENABLED = parseBool(process.env.KILL_SWITCH);
/** Si `DEBUG_TRANSCRIPT=true`, journalise le texte intégral envoyé à n8n (débogage court terme uniquement). */
const DEBUG_TRANSCRIPT = parseBool(process.env.DEBUG_TRANSCRIPT);
/** Si `DEBUG_SAVE_ULAW=true`, enregistre le 1er segment μ-law Twilio→AssemblyAI sur disque (debug stream). */
const DEBUG_SAVE_ULAW = parseBool(process.env.DEBUG_SAVE_ULAW);
const DEBUG_SAVE_ULAW_PATH = String(process.env.DEBUG_SAVE_ULAW_PATH || "/tmp/debug_segment.ulaw");

app.get("/debug-ulaw", async (req, res) => {
  try {
    const buf = await readFile(DEBUG_SAVE_ULAW_PATH);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="debug_segment.ulaw"');
    return res.send(buf);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return res.status(404).type("text/plain").send("Fichier absent — activez DEBUG_SAVE_ULAW puis passez un appel.");
    }
    console.log("❌ /debug-ulaw error:", err?.message || err);
    return res.status(500).type("text/plain").send("Erreur serveur.");
  }
});

/** AssemblyAI exige des chunks audio entre 50 ms et 1000 ms ; μ-law 8 kHz = 1 octet / échantillon. */
const AAI_MIN_SEND_BYTES = Number(process.env.AAI_MIN_SEND_BYTES || 400); // 50 ms
const AAI_MAX_SEND_BYTES = Number(process.env.AAI_MAX_SEND_BYTES || 8000); // 1000 ms

/** Nombre minimum de mots (tour AssemblyAI final) avant envoi à n8n — défaut 3. */
const STT_MIN_WORDS_FOR_N8N = Math.max(1, Math.floor(Number(process.env.STT_MIN_WORDS_FOR_N8N ?? 3)) || 3);

/** Fragments souvent hallucinés (FR) — comparaison en minuscules. */
const STT_HALLUCINATION_HINTS_FR = [
  "sous-titres",
  "sous-titrage",
  "amara",
  "merci d'avoir regardé",
  "merci d'avoir regardé cette vidéo",
  "abonnez-vous",
  "réseaux sociaux",
  "commentaire",
  "n'oubliez pas",
  "merci et à bientôt",
  "transcription",
];

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

function buildAssemblyAiRealtimeUrl() {
  const base = String(process.env.ASSEMBLYAI_STREAMING_URL || "wss://streaming.assemblyai.com/v3/ws").replace(
    /\/$/,
    ""
  );
  const params = new URLSearchParams({
    speech_model: "u3-rt-pro",
    encoding: "pcm_mulaw",
    sample_rate: "8000",
    format_turns: "true",
    language: "fr",
  });
  return `${base}?${params.toString()}`;
}

/**
 * Ouvre une session Universal Streaming v3 et attend le message `Begin`.
 * @param {string} apiKey
 * @param {number} handshakeTimeoutMs
 * @returns {Promise<WebSocket>}
 */
function connectAssemblyAiWebSocket(apiKey, handshakeTimeoutMs = 15_000) {
  const url = buildAssemblyAiRealtimeUrl();
  const ws = new WebSocket(url, { headers: { Authorization: apiKey } });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      ws.off("message", onMessage);
      reject(new Error("AssemblyAI handshake timeout"));
    }, handshakeTimeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutId);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.off("message", onMessage);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onClose = (code, reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.off("message", onMessage);
      const r = reason?.toString?.() || "";
      reject(new Error(`AssemblyAI connection closed before session start (${code}) ${r}`.trim()));
    };

    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type === "Begin") {
        if (settled) return;
        settled = true;
        cleanup();
        ws.off("message", onMessage);
        resolve(ws);
      }
    };

    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

function terminateAssemblyAiSession(aaiWs) {
  if (!aaiWs || aaiWs.readyState !== WebSocket.OPEN) return;
  try {
    aaiWs.send(JSON.stringify({ type: "Terminate" }));
  } catch (err) {
    console.log("⚠️ AssemblyAI Terminate send error:", err?.message || err);
  }
}

function resetListeningBuffers(session) {
  session.aaiUlawAccum = Buffer.alloc(0);
  session.lastFlushTs = Date.now();
}

function toWhatsAppTo(fromNumber) {
  if (!fromNumber) return null;
  const n = String(fromNumber).trim();
  if (!n) return null;
  return n.startsWith("whatsapp:") ? n : `whatsapp:${n}`;
}

function getSmtpTransport() {
  if (smtpTransport) return smtpTransport;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !port || !user || !pass) return null;

  smtpTransport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return smtpTransport;
}

function buildDoctorNotificationText({ patientName, patientNumber, transcript }) {
  const safeName = patientName || "Inconnu";
  const safeNumber = patientNumber || "Numero inconnu";
  const safeTranscript = transcript || "(transcription vide)";
  return [
    "Nouveau message vocal patient",
    `Nom: ${safeName}`,
    `Numero: ${safeNumber}`,
    "",
    "Transcript:",
    safeTranscript,
  ].join("\n");
}

function getValidN8nBrainUrl() {
  const raw = process.env.N8N_BRAIN_URL;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildTwimlConnect(wsUrl) {
  // Twilio will start streaming as soon as the WS handshake is complete.
  // We keep the Twilio transport simple; audio playback is handled by our WS.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_track" />
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
    const patientName =
      req.body?.CallerName ||
      req.body?.FromName ||
      req.body?.caller_name ||
      null;
    if (callSid) {
      callSidToCaller.set(callSid, {
        from: from || null,
        name: patientName || null,
      });
    }

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

async function sendDoctorWhatsAppNotification({ patientName, patientNumber, transcript }) {
  const doctorWhatsApp = process.env.DOCTOR_WHATSAPP;
  if (!doctorWhatsApp) {
    console.log("⚠️ DOCTOR_WHATSAPP missing; doctor WhatsApp notification skipped.");
    return;
  }
  const to = doctorWhatsApp.startsWith("whatsapp:")
    ? doctorWhatsApp
    : `whatsapp:${doctorWhatsApp}`;
  const body = buildDoctorNotificationText({ patientName, patientNumber, transcript });
  await sendWhatsApp({ to, body });
}

async function sendDoctorEmailNotification({ patientNumber, transcript }) {
  const doctorEmail = process.env.DOCTOR_EMAIL;
  if (!doctorEmail) {
    console.log("⚠️ DOCTOR_EMAIL missing; doctor email notification skipped.");
    return;
  }

  const transporter = getSmtpTransport();
  if (!transporter) {
    console.log("⚠️ SMTP config missing/invalid; doctor email notification skipped.");
    return;
  }

  const safeNumber = patientNumber || "inconnu";
  const subject = `[PATIENT: ${safeNumber}] Message vocal recu`;
  const text = transcript || "(transcription vide)";
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: doctorEmail,
    subject,
    text,
  });
}

async function notifyDoctorDoubleChannel({ patientName, patientNumber, transcript }) {
  try {
    await sendDoctorWhatsAppNotification({ patientName, patientNumber, transcript });
  } catch (err) {
    console.log("❌ Doctor WhatsApp notification error:", err?.message || err);
  }

  try {
    await sendDoctorEmailNotification({ patientNumber, transcript });
  } catch (err) {
    console.log("❌ Doctor email notification error:", err?.message || err);
  }
}

async function elevenLabsTextToMuLaw8000(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID.");
  }

  // Ask ElevenLabs for native telephony μ-law 8kHz output.
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
  const audioBuffer = Buffer.from(ab);
  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  console.log(`🔊 ElevenLabs TTS content-type: ${contentType || "unknown"} | bytes: ${audioBuffer.length}`);
  if (contentType.includes("mp3") || contentType.includes("mpeg") || contentType.includes("opus") || contentType.includes("wav")) {
    console.log("⚠️ Unexpected TTS content-type for ulaw_8000; expected raw telephony audio.");
  }

  // ulaw_8000 response is already μ-law 8kHz.
  return audioBuffer;
}

async function playMuLawToTwilio(ws, streamSid, muLawBuffer) {
  if (!streamSid) return;
  // 20ms @ 8000 Hz => 160 bytes (μ-law is 8-bit/byte).
  const FRAME_MS = 20;
  const CHUNK_BYTES = 160;
  const SILENCE_BYTE = 0xff;
  let frameIndex = 0;
  const startedAt = performance.now();
  const frames = [];

  for (let i = 0; i < muLawBuffer.length; i += CHUNK_BYTES) {
    const rawChunk = muLawBuffer.subarray(i, i + CHUNK_BYTES);
    // Always send full 20ms frames to avoid timing/audio artifacts on tail frames.
    frames.push(
      rawChunk.length === CHUNK_BYTES
        ? Buffer.from(rawChunk)
        : Buffer.concat([rawChunk, Buffer.alloc(CHUNK_BYTES - rawChunk.length, SILENCE_BYTE)])
    );
  }

  // Send pre-built frames at regular pace (no conversion/chunking work in the timing loop).
  for (const chunk of frames) {
    if (killNow) return;
    const payload = Buffer.from(chunk).toString("base64");

    // Anti-jitter scheduler: align each frame to a monotonic clock.
    const targetAt = startedAt + frameIndex * FRAME_MS;
    const now = performance.now();
    if (targetAt > now) {
      await sleep(targetAt - now);
    }

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload },
      })
    );
    frameIndex += 1;
  }
}

async function playText(ws, session, text) {
  const muLaw = await elevenLabsTextToMuLaw8000(text);
  await playMuLawToTwilio(ws, session.streamSid, muLaw);
}

/**
 * Coupe le STT pendant tout le TTS ElevenLabs puis un délai après la fin (`TTS_POST_PLAY_MS`,
 * défaut 1000 ms — évite de renvoyer l'audio synthétique au STT). Remet sttPaused à false ensuite.
 */
function createPlayTextWithSttGuard(sleepFn, postPlayMs) {
  return async function playTextWithSttGuard(ws, session, text) {
    session.sttPaused = true;
    resetListeningBuffers(session);
    try {
      await playText(ws, session, text);
    } finally {
      await sleepFn(postPlayMs);
      session.sttPaused = false;
    }
  };
}

async function callN8nForTurn({ transcript, session }) {
  const brainUrl = getValidN8nBrainUrl();
  if (!brainUrl) throw new Error("Missing N8N_BRAIN_URL.");

  const controller = new AbortController();
  const timeoutMs = 5_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const phone = session.fromNumber ?? null;
  const payload = {
    call: {
      provider: "twilio",
      streamSid: session.streamSid,
      callSid: session.callSid,
      fromNumber: phone,
      callerNumber: phone,
    },
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

/**
 * Envoie le μ-law accumulé vers AssemblyAI par blocs conformes (50–1000 ms).
 */
function flushAaiAudioSendBuffer(session) {
  const aaiWs = session.aaiWs;
  if (!aaiWs || aaiWs.readyState !== WebSocket.OPEN) return;
  let buf = session.aaiUlawAccum;
  if (!buf?.length) return;

  while (buf.length >= AAI_MIN_SEND_BYTES) {
    const take = Math.min(buf.length, AAI_MAX_SEND_BYTES);
    const packet = buf.subarray(0, take);
    buf = buf.subarray(take);
    aaiWs.send(packet);
  }
  session.aaiUlawAccum = buf;
}

/**
 * Traite une transcription finale de tour (AssemblyAI `Turn` avec `end_of_turn`).
 */
async function handleFinalUserTranscript(ws, session, transcript, playTextWithSttGuard, degradedFallback) {
  if (session.n8nInFlight || session.responded) return;
  session.n8nInFlight = true;

  try {
    const wordCount = transcript.split(/\s+/).filter(Boolean).length;
    console.log(`📝 transcript tour final (${wordCount} mots)`);

    if (!transcript) {
      session.n8nInFlight = false;
      return;
    }

    if (wordCount < STT_MIN_WORDS_FOR_N8N) {
      console.log(
        `⚠️ STT ignoré (trop court: ${wordCount} mot(s), minimum ${STT_MIN_WORDS_FOR_N8N} pour n8n)`
      );
      session.n8nInFlight = false;
      return;
    }

    const normalized = transcript.toLowerCase();
    const matchesKnownHallucination = STT_HALLUCINATION_HINTS_FR.some((hint) => normalized.includes(hint));
    if (matchesKnownHallucination) {
      session.consecutiveHallucinationStrikes += 1;
      console.log("⚠️ STT ignoré (fragment hallucination FR connu, contenu non journalisé)");
      session.n8nInFlight = false;
      if (session.consecutiveHallucinationStrikes >= 3) {
        console.log(
          "ℹ️ 3 segments hallucination consécutifs — réinitialisation écoute (sttPaused, buffers, transcriptAttempts)"
        );
        session.consecutiveHallucinationStrikes = 0;
        session.transcriptAttempts = 0;
        session.sttPaused = false;
        resetListeningBuffers(session);
      }
      return;
    }

    session.consecutiveHallucinationStrikes = 0;

    session.sttPaused = true;

    if (DEBUG_TRANSCRIPT) {
      console.log(`🐛 DEBUG_TRANSCRIPT: ${wordCount} mots | texte capté:`, transcript);
    }
    const brainJson = await callN8nForTurn({ transcript, session });
    const action = brainJson?.action;
    const textToSpeak = brainJson?.text;
    const replyTextLen = typeof textToSpeak === "string" ? textToSpeak.length : 0;
    console.log(`🧠 n8n reply: action=${action ?? "n/a"} length=${replyTextLen}`);

    if (killNow) {
      session.n8nInFlight = false;
      session.sttPaused = false;
      return;
    }

    session.n8nInFlight = false;

    if (!action) {
      await degradedFallback(ws, session, "n8n invalid response");
      return;
    }

    if (action === "rdv") {
      session.responded = true;
      await playTextWithSttGuard(
        ws,
        session,
        "Bien sûr, je vous envoie un WhatsApp avec les options disponibles."
      );
      return;
    }

    if (!textToSpeak) {
      await degradedFallback(ws, session, "n8n invalid response");
      return;
    }

    if (action === "answer") {
      session.responded = true;
      await playTextWithSttGuard(ws, session, textToSpeak);
      return;
    }

    if (action === "fallback") {
      session.transcriptAttempts += 1;
      if (session.transcriptAttempts < 3) {
        console.log(
          `ℹ️ Fallback n8n ignoré (tentative ${session.transcriptAttempts}/3, STT possiblement bruit/hallucination) — poursuite écoute`
        );
        session.sttPaused = false;
        resetListeningBuffers(session);
        return;
      }

      session.responded = true;
      await playTextWithSttGuard(ws, session, textToSpeak);

      // Notify doctor with patient metadata + transcript on FAQ fallback.
      await notifyDoctorDoubleChannel({
        patientName: session.patientName,
        patientNumber: session.fromNumber,
        transcript,
      });

      const to = toWhatsAppTo(session.fromNumber);
      if (to) {
        await sendWhatsApp({
          to,
          body: "Votre question a été transmise au médecin. Il vous recontactera rapidement. En cas d'urgence, appelez le 15 ou le 112.",
        });
      } else {
        console.log("⚠️ WhatsApp not sent (missing recipient).");
      }
      return;
    }

    if (action === "urgence") {
      session.responded = true;
      await playTextWithSttGuard(ws, session, textToSpeak);
      return;
    }

    await degradedFallback(ws, session, "unknown action");
  } catch (err) {
    session.n8nInFlight = false;
    await degradedFallback(ws, session, err?.name === "AbortError" ? "n8n timeout" : "pipeline error");
  }
}

wss.on("connection", (ws) => {
  console.log("✅ Twilio WS connected");

  const POST_WELCOME_LISTEN_DELAY_MS = Number(process.env.POST_WELCOME_LISTEN_DELAY_MS || 1000);
  const TTS_POST_PLAY_MS = Number(process.env.TTS_POST_PLAY_MS || 1000);
  const playTextWithSttGuard = createPlayTextWithSttGuard(sleep, TTS_POST_PLAY_MS);

  const session = {
    callSid: null,
    streamSid: null,
    fromNumber: null,
    patientName: null,
    mediaCount: 0,
    /** Tampon μ-law à envoyer à AssemblyAI (respect 50–1000 ms par envoi). */
    aaiUlawAccum: Buffer.alloc(0),
    lastFlushTs: Date.now(),
    /** Client WebSocket AssemblyAI pour cet appel ; `null` si non connecté (ex. mode welcome-only). */
    aaiWs: null,
    /** `null` tant que le message d'accueil n'est pas terminé ; ensuite timestamp au-delà duquel l'écoute STT est autorisée. */
    listenReadyAt: null,
    sttPaused: false,
    responded: false,
    n8nInFlight: false,
    n8nMissingLogged: false,
    debugSegmentUlawSaved: false,
    /** Nombre de réponses n8n `fallback` déjà reçues (les 2 premières sont ignorées). */
    transcriptAttempts: 0,
    /** Segments filtrés (hallucination FR) d'affilée (réinitialisé après passage au STT réel). */
    consecutiveHallucinationStrikes: 0,
  };

  async function degradedFallback(wsToUse, sessionToUse, reason) {
    if (sessionToUse.responded) return;
    sessionToUse.responded = true;

    console.log("⚠️ Degraded mode:", reason);

    terminateAssemblyAiSession(sessionToUse.aaiWs);
    try {
      sessionToUse.aaiWs?.close();
    } catch {
      /* ignore */
    }
    sessionToUse.aaiWs = null;

    const shortVoice =
      process.env.DEGRADED_VOICE_TEXT ||
      "Votre question a bien été transmise au médecin. Il vous recontactera rapidement. En cas d'urgence, appelez le 15.";

    try {
      await playTextWithSttGuard(wsToUse, sessionToUse, shortVoice);
    } catch (err) {
      console.log("❌ TTS degraded error:", err?.message || err);
    }

    try {
      const to = toWhatsAppTo(sessionToUse.fromNumber);
      if (to) {
        await sendWhatsApp({
          to,
          body: "Votre question a été transmise au médecin. Il vous recontactera rapidement. En cas d'urgence, appelez le 15 ou le 112.",
        });
      } else {
        console.log("⚠️ WhatsApp not sent (missing recipient).");
      }
    } catch (err) {
      console.log("❌ WhatsApp degraded error:", err?.message || err);
    }
  }

  function attachAssemblyAiInboundHandler(aaiWs) {
    aaiWs.on("message", (data) => {
      if (killNow) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === "Termination") {
        console.log("ℹ️ AssemblyAI Termination", msg);
        return;
      }

      if (msg.type !== "Turn" || !msg.end_of_turn) return;

      if (!session.streamSid) return;
      if (session.sttPaused || session.responded) return;
      if (session.listenReadyAt == null || Date.now() < session.listenReadyAt) return;

      if (!getValidN8nBrainUrl()) return;

      const transcript = (msg.transcript || "").trim();
      void handleFinalUserTranscript(ws, session, transcript, playTextWithSttGuard, degradedFallback);
    });

    aaiWs.on("error", (err) => {
      console.log("❌ AssemblyAI WS error:", err?.message || err);
    });
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
      const caller = session.callSid ? callSidToCaller.get(session.callSid) : null;
      session.fromNumber = caller?.from || null;
      session.patientName = caller?.name || null;

      console.log("▶️ start", { callSid: session.callSid, streamSid: session.streamSid });

      const wantsBrain = Boolean(getValidN8nBrainUrl());
      const assemblyKey = String(process.env.ASSEMBLYAI_API_KEY || "").trim();

      if (wantsBrain) {
        if (!assemblyKey) {
          console.log("❌ ASSEMBLYAI_API_KEY missing");
          await degradedFallback(ws, session, "missing ASSEMBLYAI_API_KEY");
          return;
        }

        try {
          const aaiWs = await connectAssemblyAiWebSocket(assemblyKey);
          session.aaiWs = aaiWs;
          attachAssemblyAiInboundHandler(aaiWs);
          console.log("✅ AssemblyAI streaming session ready");
        } catch (err) {
          console.log("❌ AssemblyAI connect error:", err?.message || err);
          await degradedFallback(ws, session, "AssemblyAI connection failed");
          return;
        }
      }

      try {
        if (!session.responded) {
          const welcomeText =
            process.env.WELCOME_TEXT ||
            "Cabinet du Dr Crichi, je vous écoute.";
          await playTextWithSttGuard(ws, session, welcomeText);
        }
      } catch (err) {
        console.log("❌ Welcome TTS error:", err?.message || err);
      } finally {
        session.listenReadyAt = Date.now() + POST_WELCOME_LISTEN_DELAY_MS;
        session.lastFlushTs = Date.now();
      }

      return;
    }

    // MEDIA
    if (evt.event === "media") {
      if (!session.streamSid) return;
      if (session.sttPaused || session.responded || session.n8nInFlight) return;
      if (session.listenReadyAt == null || Date.now() < session.listenReadyAt) return;

      if (!getValidN8nBrainUrl()) {
        if (!session.n8nMissingLogged) {
          session.n8nMissingLogged = true;
          console.log("ℹ️ N8N_BRAIN_URL missing/invalid: welcome-only mode, skipping STT->n8n.");
        }
        return;
      }

      const aaiWs = session.aaiWs;
      if (!aaiWs || aaiWs.readyState !== WebSocket.OPEN) return;

      session.mediaCount++;

      const b64 = evt.media?.payload;
      if (!b64) return;

      const chunk = Buffer.from(b64, "base64");
      session.aaiUlawAccum = session.aaiUlawAccum.length
        ? Buffer.concat([session.aaiUlawAccum, chunk])
        : chunk;

      if (DEBUG_SAVE_ULAW && !session.debugSegmentUlawSaved && session.aaiUlawAccum.length >= AAI_MIN_SEND_BYTES) {
        session.debugSegmentUlawSaved = true;
        const snap = session.aaiUlawAccum.subarray(0, Math.min(session.aaiUlawAccum.length, AAI_MAX_SEND_BYTES));
        void writeFile(DEBUG_SAVE_ULAW_PATH, snap)
          .then(() => console.log(`🐛 DEBUG_SAVE_ULAW: ${snap.length} octets → ${DEBUG_SAVE_ULAW_PATH}`))
          .catch((err) => console.log("⚠️ DEBUG_SAVE_ULAW write error:", err?.message || err));
      }

      flushAaiAudioSendBuffer(session);
      session.lastFlushTs = Date.now();

      return;
    }

    // STOP
    if (evt.event === "stop") {
      console.log("⏹️ stop", evt.stop);
      console.log(`✅ total media packets: ${session.mediaCount}`);
      flushAaiAudioSendBuffer(session);
      terminateAssemblyAiSession(session.aaiWs);
      try {
        session.aaiWs?.close();
      } catch {
        /* ignore */
      }
      session.aaiWs = null;
      return;
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WS closed");
    flushAaiAudioSendBuffer(session);
    terminateAssemblyAiSession(session.aaiWs);
    try {
      session.aaiWs?.close();
    } catch {
      /* ignore */
    }
    session.aaiWs = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway listening on :${PORT}`);
});
