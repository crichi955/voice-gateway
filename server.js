import OpenAI from "openai";

import express from "express";
import multer from "multer";
import http from "http";
import { readFile } from "node:fs/promises";
import WebSocket, { WebSocketServer } from "ws";
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
/** Si `DEBUG_SAVE_ULAW=true`, enregistre le 1er segment μ-law Twilio→OpenAI sur disque (debug stream). */
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

/** Nombre minimum de mots (tour transcription OpenAI Realtime) avant envoi à n8n — défaut 3. */
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

function resetListeningBuffers(session) {
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

async function callN8nForTurn({ transcript, session }) {
  console.log("🧠 callN8nForTurn ENTER | env N8N_BRAIN_URL =", process.env.N8N_BRAIN_URL);
  if (!getValidN8nBrainUrl()) throw new Error("Missing N8N_BRAIN_URL.");

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

  console.log("🧠 About to call n8n:", process.env.N8N_BRAIN_URL);

  let res;
  let rawText;

  try {
    res = await fetch(process.env.N8N_BRAIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    rawText = await res.text();
    if (!rawText || !rawText.trim()) {
      console.warn("🧠 n8n returned empty body, forcing fallback");
      return {
        action: "fallback",
        text: "Je transmets votre demande au médecin.",
        whatsappUrl: process.env.WHATSAPP_FALLBACK_URL,
        transcript,
      };
    }
    console.log("🧠 n8n status:", res.status, res.statusText);
    console.log("🧠 n8n rawText:", rawText);

    if (!res.ok) throw new Error("n8n HTTP " + res.status + " " + res.statusText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      throw new Error("n8n returned non-JSON: " + rawText.slice(0, 200));
    }

    const action = String(data?.action || "").trim().toLowerCase();
    console.log("🎯 action parsed:", action);
    data.action = action;
    return data;
  } catch (err) {
    console.error("💥 PIPELINE ERROR DETAILS:", err?.message);
    console.error(err?.stack);
    console.error("💥 last n8n rawText:", rawText?.slice?.(0, 500));
    throw err;
  }
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
    console.log("🧠 Will call n8n now | transcript =", transcript);
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
      await playTextWithSttGuard(
        ws,
        session,
        "Bien sûr, je vous envoie un WhatsApp avec les options disponibles."
      );
      session.responded = true;
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

  async function playTextOpenAIRealtime(twilioWs, session, text) {
    const oai = session.openAiWs;
    if (!oai || oai.readyState !== WebSocket.OPEN) {
      console.log("⚠️ playTextOpenAIRealtime: OpenAI WS not open");
      return;
    }
    if (session.openAiResponseInProgress) {
      return;
    }
    session.openAiResponseInProgress = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        session._playDonePending = null;
        fn();
      };
      session._playDonePending = {
        resolve: () => finish(() => resolve()),
        reject: (e) => finish(() => reject(e)),
      };
      timeoutId = setTimeout(() => {
        console.log("⚠️ playTextOpenAIRealtime: timeout waiting response.done");
        finish(() => resolve());
      }, 120_000);
      try {
        session.allowAudio = true;
        console.log("🗣️ response.create (TTS) sending, allowAudio=", session.allowAudio);
        oai.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              voice: "marin",
              instructions: `Dis exactement ce texte, sans rien ajouter ni reformuler : ${text}`,
            },
          })
        );
      } catch (e) {
        session.allowAudio = false;
        finish(() => reject(e));
      }
    });
  }

  /**
   * Coupe le STT pendant toute la réponse audio OpenAI Realtime puis un délai après la fin (`TTS_POST_PLAY_MS`,
   * défaut 1000 ms — évite de renvoyer l'audio synthétique au STT). Remet sttPaused à false ensuite.
   */
  function createPlayTextWithSttGuard(sleepFn, postPlayMs) {
    return async function playTextWithSttGuard(wsToUse, sessionToUse, text) {
      sessionToUse.sttPaused = true;
      sessionToUse.ttsPlaying = true;
      resetListeningBuffers(sessionToUse);
      try {
        await playTextOpenAIRealtime(wsToUse, sessionToUse, text);
      } finally {
        await sleep(500);
        sessionToUse.ttsPlaying = false;
        sessionToUse.sttPaused = false;
      }
    };
  }

  const playTextWithSttGuard = createPlayTextWithSttGuard(sleep, TTS_POST_PLAY_MS);

  async function degradedFallback(wsToUse, sessionToUse, reason) {
    if (sessionToUse.responded) return;
    sessionToUse.responded = true;

    console.log("⚠️ Degraded mode:", reason);

    const shortVoice =
      process.env.DEGRADED_VOICE_TEXT ||
      "Votre question a bien été transmise au médecin. Il vous recontactera rapidement. En cas d'urgence, appelez le 15.";

    try {
      await playTextWithSttGuard(wsToUse, sessionToUse, shortVoice);
    } catch (err) {
      console.log("❌ TTS degraded error:", err?.message || err);
    }

    if (sessionToUse.openAiWs) {
      try {
        sessionToUse.openAiWs.close();
      } catch {
        /* ignore */
      }
      sessionToUse.openAiWs = null;
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

  function connectOpenAIRealtime(session, twilioWs) {
    return new Promise((resolve, reject) => {
      let settledConnect = false;

      const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
      const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini";
      const oaiWs = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      oaiWs.on("message", (data) => {
        if (killNow) return;
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.type === "session.updated") {
          console.log("✅ session.updated received", msg.session?.turn_detection);
          if (!session.didWelcome) {
            session.didWelcome = true;
            session.allowAudio = true;
            session._welcomeResponsePending = true;
            session.openAiWs.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio", "text"],
                  voice: "marin",
                  instructions:
                    "Dis exactement : Cabinet du Dr Crichi, bonjour. En cas d'urgence médicale, appelez le 15 immédiatement. Comment puis-je vous aider ?",
                },
              })
            );
          }
          return;
        }

        if (msg.type === "response.created") {
          session.openAiResponseInProgress = true;
          return;
        }

        if (msg.type === "response.audio.delta") {
          if (!session.allowAudio) return;
          session._deltaCount = (session._deltaCount || 0) + 1;
          if (session._deltaCount % 50 === 0) console.log("🔊 audio delta passing", session._deltaCount);
          const deltaB64 = msg.delta;
          if (deltaB64 && session.streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid: session.streamSid,
                media: { payload: deltaB64 },
              })
            );
          }
          return;
        }

        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          if (session.sttPaused) return;
          const transcript = (msg.transcript || "").trim();
          console.log("📝 transcript reçu:", transcript);
          const wc = transcript.trim().split(/\s+/).filter(Boolean).length;
          if (wc < 3) return;
          if (!getValidN8nBrainUrl()) return;
          if (!session.streamSid) return;
          if (session.sttPaused || session.responded) return;
          if (session.listenReadyAt == null || Date.now() < session.listenReadyAt) return;
          session.openAiWs.send(JSON.stringify({
            type: "input_audio_buffer.commit",
          }));
          void handleFinalUserTranscript(twilioWs, session, transcript, playTextWithSttGuard, degradedFallback);
          console.log("➡️ envoi n8n:", transcript);
          return;
        }

        if (msg.type === "error") {
          console.log("❌ OpenAI Realtime error:", msg.error || msg);
          const p = session._playDonePending;
          session._playDonePending = null;
          try {
            p?.reject?.(new Error(msg.error?.message || JSON.stringify(msg.error || msg)));
          } catch {
            /* ignore */
          }
          void degradedFallback(twilioWs, session, "OpenAI Realtime error");
          return;
        }

        if (msg.type === "response.done" || msg.type === "response.completed") {
          const wasWelcome = session._welcomeResponsePending;
          session.allowAudio = false;
          session.openAiResponseInProgress = false;
          session._welcomeResponsePending = false;
          console.log("✅ response finished -> flags reset", msg.type);
          if (wasWelcome) {
            void (async () => {
              await sleep(800);
              session.sttPaused = false;
            })();
          }
          const p = session._playDonePending;
          session._playDonePending = null;
          try {
            p?.resolve?.();
          } catch {
            /* ignore */
          }
        }
      });

      oaiWs.on("error", (err) => {
        console.log("❌ OpenAI Realtime WS error:", err?.message || err);
        if (!settledConnect) {
          settledConnect = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          void degradedFallback(twilioWs, session, "OpenAI Realtime WS error");
        }
      });

      oaiWs.on("close", () => {
        if (session.openAiWs === oaiWs) {
          session.openAiWs = null;
        }
      });

      oaiWs.on("open", () => {
        session.openAiWs = oaiWs;

        try {
          oaiWs.send(
            JSON.stringify({
              type: "session.update",
              session: {
                modalities: ["audio", "text"],
                instructions:
                  "Tu es un agent vocal de standard médical pour le cabinet du Dr Crichi. Tu réponds uniquement selon la FAQ fournie. En cas d'urgence tu dis d'appeler le 15 ou le 112. Tu ne donnes jamais de diagnostic ni d'avis médical. Tu parles uniquement en français. Quand un patient mentionne rendez-vous, rdv, consultation, prendre un rendez-vous ou voir le médecin : réponds UNIQUEMENT et EXACTEMENT cette phrase : « Je vous envoie les options disponibles par WhatsApp. » Ne pose JAMAIS de questions sur le nom, les disponibilités ou le motif. Ne dis rien d'autre.",
                voice: "marin",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: null,
                tool_choice: "auto",
              },
            })
          );
          console.log("✅ session.update sent (turn_detection=null, manual responses only)");
        } catch (e) {
          if (!settledConnect) {
            settledConnect = true;
            reject(e);
          }
          return;
        }

        if (!settledConnect) {
          settledConnect = true;
          resolve();
        }
        console.log("✅ OpenAI Realtime streaming session ready");
      });
    });
  }

  const session = {
    callSid: null,
    streamSid: null,
    fromNumber: null,
    patientName: null,
    mediaCount: 0,
    lastFlushTs: Date.now(),
    /** Client WebSocket OpenAI Realtime pour cet appel. */
    openAiWs: null,
    openAiResponseInProgress: false,
    _playDonePending: null,
    /** `null` tant que le message d'accueil n'est pas terminé ; ensuite timestamp au-delà duquel l'écoute STT est autorisée. */
    listenReadyAt: null,
    sttPaused: true,
    ttsPlaying: false,
    responded: false,
    n8nInFlight: false,
    n8nMissingLogged: false,
    /** Nombre de réponses n8n `fallback` déjà reçues (les 2 premières sont ignorées). */
    transcriptAttempts: 0,
    /** Segments filtrés (hallucination FR) d'affilée (réinitialisé après passage au STT réel). */
    consecutiveHallucinationStrikes: 0,
    audioPacketCount: 0,
    allowAudio: false,
    didWelcome: false,
  };

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

      const openaiKey = String(process.env.OPENAI_API_KEY || "").trim();

      if (!openaiKey) {
        console.log("❌ OPENAI_API_KEY missing");
        await degradedFallback(ws, session, "missing OPENAI_API_KEY");
        session.listenReadyAt = Date.now() + POST_WELCOME_LISTEN_DELAY_MS;
        session.lastFlushTs = Date.now();
        return;
      }

      try {
        await connectOpenAIRealtime(session, ws);
      } catch (err) {
        console.log("❌ OpenAI Realtime connect error:", err?.message || err);
        await degradedFallback(ws, session, "OpenAI Realtime connection failed");
        session.listenReadyAt = Date.now() + POST_WELCOME_LISTEN_DELAY_MS;
        session.lastFlushTs = Date.now();
        return;
      }

      session.listenReadyAt = Date.now() + POST_WELCOME_LISTEN_DELAY_MS;
      session.lastFlushTs = Date.now();

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

      const oaiWs = session.openAiWs;
      if (!oaiWs || oaiWs.readyState !== WebSocket.OPEN) return;

      session.mediaCount++;

      const b64 = evt.media?.payload;
      if (!b64) return;

      try {
        oaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: b64,
          })
        );
        session.audioPacketCount += 1;
        if (session.audioPacketCount >= 100) {
          session.audioPacketCount = 0;
          oaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
      } catch (err) {
        console.log("❌ OpenAI input_audio_buffer.append error:", err?.message || err);
      }
      session.lastFlushTs = Date.now();

      return;
    }

    // STOP
    if (evt.event === "stop") {
      console.log("⏹️ stop", evt.stop);
      console.log(`✅ total media packets: ${session.mediaCount}`);
      if (session.openAiWs) {
        try {
          session.openAiWs.close();
        } catch {
          /* ignore */
        }
        session.openAiWs = null;
      }
      return;
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WS closed");
    if (session.openAiWs) {
      try {
        session.openAiWs.close();
      } catch {
        /* ignore */
      }
      session.openAiWs = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway listening on :${PORT}`);
});
