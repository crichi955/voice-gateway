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

/** Nombre minimum de mots (tour transcription OpenAI Realtime) avant envoi à n8n — défaut 2. */
const STT_MIN_WORDS_FOR_N8N = Math.max(1, Math.floor(Number(process.env.STT_MIN_WORDS_FOR_N8N ?? 2)) || 2);

/** Provider TTS pour les réponses n8n : "openai" (défaut, comportement actuel) ou "azure" (Azure Neural TTS). */
const TTS_PROVIDER = String(process.env.TTS_PROVIDER || "openai").trim().toLowerCase();
const AZURE_SPEECH_KEY = String(process.env.AZURE_SPEECH_KEY || "").trim();
const AZURE_SPEECH_REGION = String(process.env.AZURE_SPEECH_REGION || "").trim();
const AZURE_TTS_VOICE = "fr-FR-DeniseNeural";
const AZURE_TTS_STYLE = "cheerful";
/** Délai max (ms) avant réception du premier byte audio Azure ; au-delà, fallback automatique sur OpenAI. Configurable par env. */
const AZURE_TTS_FIRST_BYTE_TIMEOUT_MS =
  Number(process.env.AZURE_TTS_FIRST_BYTE_TIMEOUT_MS) > 0
    ? Number(process.env.AZURE_TTS_FIRST_BYTE_TIMEOUT_MS)
    : 2500;
/** Délai max (ms) pour la synthèse complète (téléchargement inclus) ; au-delà, abort + fallback OpenAI. Configurable par env. */
const AZURE_TTS_TOTAL_TIMEOUT_MS =
  Number(process.env.AZURE_TTS_TOTAL_TIMEOUT_MS) > 0
    ? Number(process.env.AZURE_TTS_TOTAL_TIMEOUT_MS)
    : 6000;
/** Format Azure REST — μ-law 8 kHz brut, sans en-tête RIFF (compatible Twilio Media Streams). */
const AZURE_TTS_OUTPUT_FORMAT = "raw-8khz-8bit-mono-mulaw";
/** Twilio attend du μ-law 8 kHz : 160 octets = 20 ms (1 octet/échantillon à 8000 Hz). */
const TWILIO_MULAW_FRAME_BYTES = 160;
const TWILIO_MULAW_FRAME_MS = 20;
/** Taille des chunks audio outbound vers Twilio (Twilio bufferise, taille libre). Rollback temps réel : 160. */
const TWILIO_OUTBOUND_CHUNK_BYTES =
  Number(process.env.TWILIO_OUTBOUND_CHUNK_BYTES) > 0
    ? Number(process.env.TWILIO_OUTBOUND_CHUNK_BYTES)
    : 800;
/** Pause (ms) entre chunks outbound ; 0 = envoi au fil de l'eau, Twilio gère la restitution. Rollback temps réel : 20. */
const TWILIO_OUTBOUND_PACING_MS =
  Number(process.env.TWILIO_OUTBOUND_PACING_MS) >= 0
    ? Number(process.env.TWILIO_OUTBOUND_PACING_MS)
    : 5;
/** Queue de silence μ-law (0xFF) ajoutée en fin d'audio Azure — évite les fins de phrase rognées. */
const AZURE_TTS_SILENCE_TAIL_MS = 300;
const AZURE_TTS_SILENCE_TAIL_BYTES = AZURE_TTS_SILENCE_TAIL_MS * 8;
/** Attente max de l'echo du mark Twilio signalant la fin de lecture du buffer audio. */
const TWILIO_MARK_TIMEOUT_MS = 2000;

const WELCOME_TEXT =
  String(process.env.WELCOME_TEXT || "").trim() ||
  "Bonjour, cabinet du Dr Crichi. En cas d'urgence, appelez le 15. Comment puis-je vous aider ?";

if (TTS_PROVIDER === "azure" && (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION)) {
  console.log(
    "⚠️ TTS_PROVIDER=azure mais AZURE_SPEECH_KEY / AZURE_SPEECH_REGION manquants — fallback OpenAI systématique."
  );
}

console.log(
  `🔊 TTS config at startup | TTS_PROVIDER=${TTS_PROVIDER}` +
    (TTS_PROVIDER === "azure"
      ? ` | azureVoice=${AZURE_TTS_VOICE} | azureStyle=${AZURE_TTS_STYLE} | region=${AZURE_SPEECH_REGION || "MISSING"} | key=${AZURE_SPEECH_KEY ? "set" : "MISSING"} | firstByteTimeout=${AZURE_TTS_FIRST_BYTE_TIMEOUT_MS}ms | totalTimeout=${AZURE_TTS_TOTAL_TIMEOUT_MS}ms`
      : " | provider=openai-realtime | voice=marin")
);

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

/** Réinitialise les flags session après lecture du message d'accueil. */
function afterWelcomePlayback(session) {
  session.allowAudio = false;
  session._welcomeResponsePending = false;
  void (async () => {
    await sleep(800);
    session.sttPaused = false;
  })();
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildAzureSsml(text) {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="fr-FR">` +
    `<voice name="${AZURE_TTS_VOICE}">` +
    `<mstts:express-as style="${AZURE_TTS_STYLE}">${escapeXml(text)}</mstts:express-as>` +
    `</voice></speak>`
  );
}

/** Vérifie que la réponse Azure est du μ-law brut (pas un conteneur RIFF/WAV). */
function verifyAzureMulawAudio(audio) {
  const head = audio.subarray(0, Math.min(4, audio.length));
  const magic = head.toString("ascii");
  const headHex = audio.subarray(0, Math.min(8, audio.length)).toString("hex");
  console.log(
    `🔷 Azure TTS audio verify | bytes=${audio.length} | expected=${AZURE_TTS_OUTPUT_FORMAT} | magic=${JSON.stringify(magic)} | headHex=${headHex}`
  );
  if (magic === "RIFF") {
    throw new Error(
      "Azure TTS returned RIFF/WAV — use raw-8khz-8bit-mono-mulaw (headerless) for Twilio"
    );
  }
}

/**
 * Synthétise `text` via Azure Neural TTS en μ-law 8kHz mono (format natif Twilio Media Streams).
 * Rejette si le premier byte audio n'arrive pas avant `AZURE_TTS_FIRST_BYTE_TIMEOUT_MS`.
 * @returns {Promise<{ audio: Buffer, firstByteTs: number }>}
 */
async function synthesizeAzureTts(text) {
  const tStart = Date.now();
  const textPreview = text.length > 100 ? `${text.slice(0, 100)}…` : text;
  console.log(
    `🔷 Azure TTS synthesize START | chars=${text.length} | region=${AZURE_SPEECH_REGION} | format=${AZURE_TTS_OUTPUT_FORMAT} | timeout=${AZURE_TTS_FIRST_BYTE_TIMEOUT_MS}ms | preview="${textPreview}"`
  );

  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    console.log("❌ Azure TTS synthesize: AZURE_SPEECH_KEY / AZURE_SPEECH_REGION missing");
    throw new Error("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION missing");
  }
  const url = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const controller = new AbortController();
  let totalTimer = null;
  let abortReason = null;
  const timer = setTimeout(() => {
    abortReason = "first-byte";
    console.log(
      `⚠️ Azure TTS TIMEOUT FIRST BYTE: abort (premier byte > ${AZURE_TTS_FIRST_BYTE_TIMEOUT_MS}ms, elapsed=${Date.now() - tStart}ms) -> fallback OpenAI`
    );
    controller.abort();
  }, AZURE_TTS_FIRST_BYTE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": AZURE_TTS_OUTPUT_FORMAT,
        "User-Agent": "voice-gateway",
      },
      body: buildAzureSsml(text),
      signal: controller.signal,
    });
    console.log(
      `🔷 Azure TTS HTTP response | status=${resp.status} ${resp.statusText} | content-type=${resp.headers.get("content-type") ?? "n/a"} | content-length=${resp.headers.get("content-length") ?? "n/a"} | fetchMs=${Date.now() - tStart}`
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.log(`❌ Azure TTS HTTP error body: ${txt.slice(0, 500)}`);
      throw new Error(`Azure TTS HTTP ${resp.status} ${resp.statusText} ${txt.slice(0, 200)}`);
    }
    if (!resp.body) {
      console.log("❌ Azure TTS: response body is null (stream absent)");
      throw new Error("Azure TTS response body is null");
    }
    const chunks = [];
    let firstByteTs = null;
    let chunkIndex = 0;
    let totalBytes = 0;
    for await (const chunk of resp.body) {
      chunkIndex += 1;
      const buf = Buffer.from(chunk);
      totalBytes += buf.length;
      if (firstByteTs === null) {
        firstByteTs = Date.now();
        console.log(
          `🔷 Azure TTS premier byte | chunk=#${chunkIndex} bytes=${buf.length} | firstByteMs=${firstByteTs - tStart}`
        );
        clearTimeout(timer);
        // Timeout premier byte levé ; on borne maintenant le téléchargement complet.
        totalTimer = setTimeout(() => {
          abortReason = "total";
          console.log(
            `⚠️ Azure TTS TIMEOUT TOTAL: abort (synthèse totale > ${AZURE_TTS_TOTAL_TIMEOUT_MS}ms, elapsed=${Date.now() - tStart}ms) -> fallback OpenAI`
          );
          controller.abort();
        }, Math.max(0, AZURE_TTS_TOTAL_TIMEOUT_MS - (Date.now() - tStart)));
      }
      if (chunkIndex <= 3 || chunkIndex % 20 === 0) {
        console.log(
          `🔷 Azure TTS chunk #${chunkIndex} | bytes=${buf.length} | totalSoFar=${totalBytes} | elapsedMs=${Date.now() - tStart}`
        );
      }
      chunks.push(buf);
    }
    const audio = Buffer.concat(chunks);
    const durationMs = Math.ceil(audio.length / 8);
    console.log(
      `🔷 Azure TTS synthesize DONE | chunks=${chunkIndex} | totalBytes=${audio.length} | ~audioDurationMs=${durationMs} | firstByteMs=${firstByteTs != null ? firstByteTs - tStart : "n/a"} | totalMs=${Date.now() - tStart}`
    );
    if (!audio.length) {
      console.log("❌ Azure TTS: stream terminé mais audio vide");
      throw new Error("Azure TTS returned empty audio");
    }
    verifyAzureMulawAudio(audio);
    return { audio, firstByteTs };
  } catch (err) {
    console.log(
      `❌ Azure TTS synthesize ERROR | name=${err?.name ?? "n/a"} | message=${err?.message ?? err} | elapsedMs=${Date.now() - tStart}`
    );
    if (err?.stack) console.log(`❌ Azure TTS synthesize stack: ${err.stack}`);
    if (err?.name === "AbortError") {
      throw new Error(
        abortReason === "total"
          ? `Azure TTS timeout (synthèse totale > ${AZURE_TTS_TOTAL_TIMEOUT_MS}ms)`
          : `Azure TTS timeout (premier byte > ${AZURE_TTS_FIRST_BYTE_TIMEOUT_MS}ms)`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (totalTimer) clearTimeout(totalTimer);
  }
}

/**
 * Joue `text` via Azure TTS : synthèse, envoi de l'audio μ-law à Twilio par trames,
 * puis attente de la durée de lecture (8000 bytes/s) — équivalent de l'attente
 * de `response.done` sur le chemin OpenAI, pour que le garde STT reste actif.
 */
async function playTextAzureTts(twilioWs, session, text) {
  const t0 = Date.now();
  session.turnTimings = session.turnTimings || {};
  session.turnTimings.azureStart = t0;
  const textPreview = text.length > 100 ? `${text.slice(0, 100)}…` : text;
  console.log(
    `🔷 Azure TTS play START | streamSid=${session.streamSid ?? "n/a"} | wsState=${twilioWs.readyState} | chars=${text.length} | preview="${textPreview}"`
  );

  if (!session.streamSid || twilioWs.readyState !== WebSocket.OPEN) {
    console.log(
      `❌ Azure TTS play: Twilio WS not ready | streamSid=${session.streamSid ?? "n/a"} | wsState=${twilioWs.readyState}`
    );
    throw new Error("Twilio WS not ready for Azure TTS playback");
  }

  let audio;
  let firstByteTs;
  try {
    ({ audio, firstByteTs } = await synthesizeAzureTts(text));
    session.turnTimings.azureFirstByte = firstByteTs;
    session.turnTimings.azureSynthDone = Date.now();
    console.log(
      `🔷 Azure TTS play: synthèse OK | audioBytes=${audio.length} | synthMs=${Date.now() - t0}`
    );
  } catch (err) {
    console.log(`❌ Azure TTS play: synthèse échouée | message=${err?.message ?? err}`);
    throw err;
  }

  if (session.lastSpeechEndTs) {
    console.log(
      `⏱️ TTS latency (azure): fin parole patient -> premier byte audio = ${firstByteTs - session.lastSpeechEndTs}ms` +
      ` (dont synthèse: ${firstByteTs - t0}ms)`
    );
    session.lastSpeechEndTs = null;
  }

  const FRAME_BYTES = TWILIO_MULAW_FRAME_BYTES;

  // Queue de 300 ms de silence μ-law (0xFF) + padding de la dernière frame à 160 octets :
  // toutes les frames envoyées à Twilio sont pleines et la fin de phrase n'est plus rognée.
  const paddedLen =
    Math.ceil((audio.length + AZURE_TTS_SILENCE_TAIL_BYTES) / FRAME_BYTES) * FRAME_BYTES;
  const paddedAudio = Buffer.alloc(paddedLen, 0xff);
  audio.copy(paddedAudio, 0);
  console.log(
    `🔷 Azure TTS padding | audioBytes=${audio.length} | silence+pad=${paddedLen - audio.length} | total=${paddedLen}`
  );
  audio = paddedAudio;

  const CHUNK_BYTES = TWILIO_OUTBOUND_CHUNK_BYTES;
  const PACING_MS = TWILIO_OUTBOUND_PACING_MS;
  const totalChunks = Math.ceil(audio.length / CHUNK_BYTES);
  let chunksSent = 0;
  let bytesSent = 0;

  session.turnTimings.twilioSendStart = Date.now();
  console.log(
    `🔷 Azure TTS play: début envoi Twilio | chunks=${totalChunks} | chunkBytes=${CHUNK_BYTES} | pacingMs=${PACING_MS}`
  );

  // Vide le buffer Twilio avant injection (évite collisions avec un flux précédent).
  try {
    twilioWs.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));
    console.log("🔷 Azure TTS play: event clear envoyé à Twilio");
  } catch (clearErr) {
    console.log("⚠️ Azure TTS play: clear Twilio ignoré:", clearErr?.message || clearErr);
  }

  for (let i = 0; i < audio.length; i += CHUNK_BYTES) {
    if (twilioWs.readyState !== WebSocket.OPEN) {
      console.log(
        `⚠️ Azure TTS play ABORT: Twilio WS fermé | chunksSent=${chunksSent}/${totalChunks} | bytesSent=${bytesSent}/${audio.length} | wsState=${twilioWs.readyState}`
      );
      break;
    }
    const chunk = audio.subarray(i, i + CHUNK_BYTES);
    const payloadB64 = chunk.toString("base64");
    try {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid: session.streamSid,
          media: { payload: payloadB64 },
        })
      );
      chunksSent += 1;
      bytesSent += chunk.length;
      if (chunksSent === 1) {
        const decodedLen = Buffer.from(payloadB64, "base64").length;
        console.log(
          `🔷 Azure TTS chunk #1 | chunkBytes=${chunk.length} | b64Len=${payloadB64.length} | decodedLen=${decodedLen} | headHex=${chunk.subarray(0, Math.min(8, chunk.length)).toString("hex")}`
        );
      } else if (chunksSent % 25 === 0 || chunksSent === totalChunks) {
        console.log(
          `🔷 Azure TTS chunk #${chunksSent}/${totalChunks} | chunkBytes=${chunk.length} | bytesSent=${bytesSent}/${audio.length}`
        );
      }
      // Twilio bufferise les payloads media : le pacing sert seulement à lisser le débit réseau sortant.
      if (PACING_MS > 0 && chunksSent < totalChunks) {
        await sleep(PACING_MS);
      }
    } catch (sendErr) {
      console.log(
        `❌ Azure TTS play: erreur envoi chunk #${chunksSent + 1} | message=${sendErr?.message ?? sendErr}`
      );
      throw sendErr;
    }
  }

  const durationMs = Math.ceil(audio.length / 8);
  const playbackComplete = bytesSent >= audio.length;
  session.turnTimings.twilioSendEnd = Date.now();
  const twilioSendMs = session.turnTimings.twilioSendEnd - session.turnTimings.twilioSendStart;
  console.log(
    `🔊 Azure TTS play: envoi Twilio terminé | chunkBytes=${CHUNK_BYTES} | pacingMs=${PACING_MS} | chunksSent=${chunksSent}/${totalChunks} | bytesSent=${bytesSent}/${audio.length} | complete=${playbackComplete} | twilioSendMs=${twilioSendMs} | audioDurationMs=${durationMs} | totalMs=${Date.now() - t0}`
  );

  if (!playbackComplete) {
    console.log(
      `⚠️ Azure TTS play: lecture incomplète — ${audio.length - bytesSent} bytes non envoyés à Twilio`
    );
  }

  // Fin de lecture mesurée par l'echo du mark Twilio (renvoyé une fois le buffer audio joué).
  // L'envoi étant plus rapide que le temps réel, Twilio continue de jouer après le dernier chunk :
  // l'attente couvre la lecture restante + la marge TWILIO_MARK_TIMEOUT_MS de secours.
  let markEchoed = false;
  if (twilioWs.readyState === WebSocket.OPEN) {
    const remainingPlaybackMs = Math.max(0, durationMs - twilioSendMs);
    const markWaitMs = remainingPlaybackMs + TWILIO_MARK_TIMEOUT_MS;
    const markName = `azure-tts-${Date.now()}`;
    const markWait = new Promise((resolve) => {
      session._pendingMark = { name: markName, resolve };
    });
    try {
      twilioWs.send(
        JSON.stringify({ event: "mark", streamSid: session.streamSid, mark: { name: markName } })
      );
      console.log(
        `🔷 Azure TTS play: mark "${markName}" envoyé, attente echo (max ${markWaitMs}ms = lecture restante ${remainingPlaybackMs}ms + marge ${TWILIO_MARK_TIMEOUT_MS}ms)`
      );
      markEchoed = await Promise.race([
        markWait.then(() => true),
        sleep(markWaitMs).then(() => false),
      ]);
    } catch (markErr) {
      console.log("⚠️ Azure TTS play: envoi mark échoué:", markErr?.message || markErr);
    } finally {
      session._pendingMark = null;
    }
  }
  console.log(`🔷 Azure TTS play DONE | markEchoed=${markEchoed} | totalMs=${Date.now() - t0}`);
  logLatencySummary(session);
}

/** Récapitulatif des latences du tour courant (les étapes non renseignées affichent n/a). */
function logLatencySummary(session) {
  const t = session.turnTimings;
  if (!t) return;
  const d = (a, b) => (t[a] != null && t[b] != null ? `${t[b] - t[a]}ms` : "n/a");
  console.log(
    `⏱️ LATENCY SUMMARY | speechEnd->transcriptFinal=${d("speechEnd", "transcriptFinal")}` +
      ` | transcriptFinal->n8nStart=${d("transcriptFinal", "n8nStart")}` +
      ` | n8n=${d("n8nStart", "n8nEnd")}` +
      ` | n8nEnd->azureStart=${d("n8nEnd", "azureStart")}` +
      ` | azureStart->firstByte=${d("azureStart", "azureFirstByte")}` +
      ` | synthTotal=${d("azureStart", "azureSynthDone")}` +
      ` | twilioSend=${d("twilioSendStart", "twilioSendEnd")}` +
      ` | speechEnd->sendEnd=${d("speechEnd", "twilioSendEnd")}`
  );
  session.turnTimings = null;
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
    <Stream url="${wsUrl}" />
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
    session.turnTimings = session.turnTimings || {};
    session.turnTimings.n8nStart = Date.now();
    console.log("🧠 Will call n8n now | transcript =", transcript);
    const brainJson = await callN8nForTurn({ transcript, session });
    if (session.turnTimings) session.turnTimings.n8nEnd = Date.now();
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
      session.responded = true;
      await playTextWithSttGuard(ws, session, textToSpeak);
      // await notifyDoctorDoubleChannel({
      //   patientName: session.patientName,
      //   patientNumber: session.fromNumber,
      //   transcript,
      // });
      const to = toWhatsAppTo(session.fromNumber);
      if (to) {
        // await sendWhatsApp({
        //   to,
        //   body: "Votre question a été transmise au médecin. Il vous recontactera rapidement. En cas d'urgence, appelez le 15 ou le 112.",
        // });
      } else {
        console.log("⚠️ WhatsApp not sent (missing recipient).");
      }
      session.sttPaused = false;
      resetListeningBuffers(session);
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

  let activeResponseId = null;
  let activeResponseLabel = "";
  let audioDeltaCount = 0;
  let forwardedDeltaCount = 0;
  let pendingText = "";
  let pendingTimer = null;

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
        // Étape 1 — injecter le texte
        oai.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: text }]
          }
        }));

        // Étape 2 — garder les resets existants puis response.create
        activeResponseId = null;
        audioDeltaCount = 0;
        forwardedDeltaCount = 0;
        activeResponseLabel = "N8N_TTS";
        console.log("🗣️ response.create sent label=", activeResponseLabel);

        oai.send(JSON.stringify({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions: "Tu es un lecteur TTS. Lis mot pour mot le dernier message utilisateur. N'ajoute rien. Ne pose aucune question."
          }
        }));
      } catch (e) {
        session.allowAudio = false;
        finish(() => reject(e));
      }
    });
  }

  /**
   * Route le TTS selon `TTS_PROVIDER`. En mode "azure", fallback automatique sur
   * OpenAI Realtime si Azure échoue ou ne renvoie pas le premier byte audio
   * en moins de `AZURE_TTS_FIRST_BYTE_TIMEOUT_MS`.
   */
  async function playText(wsToUse, sessionToUse, text) {
    if (TTS_PROVIDER === "azure") {
      try {
        await playTextAzureTts(wsToUse, sessionToUse, text);
        return;
      } catch (err) {
        console.log("⚠️ Azure TTS KO, fallback OpenAI Realtime:", err?.message || err);
      }
    }
    await playTextOpenAIRealtime(wsToUse, sessionToUse, text);
  }

  /**
   * Coupe le STT pendant toute la réponse audio TTS puis un délai après la fin (`TTS_POST_PLAY_MS`,
   * défaut 1000 ms — évite de renvoyer l'audio synthétique au STT). Remet sttPaused à false ensuite.
   */
  function createPlayTextWithSttGuard(sleepFn, postPlayMs) {
    return async function playTextWithSttGuard(wsToUse, sessionToUse, text) {
      sessionToUse.sttPaused = true;
      sessionToUse.ttsPlaying = true;
      resetListeningBuffers(sessionToUse);
      try {
        await playText(wsToUse, sessionToUse, text);
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

  let TRACE_ENABLED = false;
  let TRACE_END_AT = 0;
  const seenTypes = new Set();
  let traceTimer = null;

  function startEventTrace(seconds = 10) {
    TRACE_ENABLED = true;
    TRACE_END_AT = Date.now() + seconds * 1000;
    seenTypes.clear();
    if (traceTimer) clearInterval(traceTimer);
    traceTimer = setInterval(() => {
      if (Date.now() > TRACE_END_AT) {
        TRACE_ENABLED = false;
        clearInterval(traceTimer);
        traceTimer = null;
        console.log("🧪 OpenAI TRACE ended. Types seen:",
          Array.from(seenTypes).sort());
      }
    }, 250);
    console.log(`🧪 OpenAI TRACE started for ${seconds}s...`);
  }

  function traceEventOnce(msg) {
    if (!TRACE_ENABLED || Date.now() > TRACE_END_AT) return;
    const t = msg?.type || "(no type)";
    if (seenTypes.has(t)) return;
    seenTypes.add(t);
    const keys = Object.keys(msg || {}).slice(0, 20);
    console.log("🧪 OpenAI event type:", t, "| keys:", keys);
    const asString = JSON.stringify(msg);
    if (t.toLowerCase().includes("audio") ||
        asString.includes('"audio"')) {
      console.log("🧪 (audio-related) type:", t);
    }
  }

  const OPENAI_PCMU_FORMAT = { type: "audio/pcmu" };

  /** Payload `session` pour `session.update` (API Realtime GA). */
  function buildOpenAiRealtimeGaSession(instructions) {
    return {
      type: "realtime",
      output_modalities: ["audio"],
      instructions,
      audio: {
        input: {
          format: OPENAI_PCMU_FORMAT,
          turn_detection: null,
          transcription: { model: "gpt-4o-mini-transcribe", language: "fr" },
        },
        output: {
          format: OPENAI_PCMU_FORMAT,
          voice: "marin",
        },
      },
      tool_choice: "auto",
    };
  }

  function connectOpenAIRealtime(session, twilioWs) {
    return new Promise((resolve, reject) => {
      let settledConnect = false;

      const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
      const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini";
      const oaiWs = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
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

        traceEventOnce(msg);

        if (msg.type === "session.updated") {
          console.log("✅ session.updated received", msg.session?.audio?.input?.turn_detection);
          if (process.env.OAI_TRACE === "true") startEventTrace(15);
          if (!session.didWelcome) {
            session.didWelcome = true;
            session.allowAudio = true;
            session._welcomeResponsePending = true;
            activeResponseId = null;
            audioDeltaCount = 0;
            activeResponseLabel = "WELCOME";

            if (TTS_PROVIDER === "azure") {
              console.log("🗣️ WELCOME via playText (Azure TTS) | text=", WELCOME_TEXT);
              void (async () => {
                try {
                  await playText(twilioWs, session, WELCOME_TEXT);
                } catch (err) {
                  console.log("❌ WELCOME playText error:", err?.message || err);
                } finally {
                  afterWelcomePlayback(session);
                  activeResponseLabel = "";
                  console.log("✅ WELCOME finished (Azure/playText path)");
                }
              })();
            } else {
              console.log("🗣️ response.create sent label=", activeResponseLabel);
              session.openAiWs.send(
                JSON.stringify({
                  type: "response.create",
                  response: {
                    output_modalities: ["audio"],
                    instructions: `Dis exactement : ${WELCOME_TEXT}`,
                  },
                })
              );
            }
          }
          return;
        }

        if (msg.type === "response.created") {
          const rid = msg.response?.id || msg.response_id;
          if (rid) {
            activeResponseId = rid;
            console.log("🧷 activeResponseId set:", activeResponseId,
              "label=", activeResponseLabel);
          }
          return;
        }

        if (msg.type === "response.output_audio.delta") {
          if (!activeResponseId && (msg.response_id || msg.response?.id)) {
            console.log("⚠️ audio.delta arrived but activeResponseId is null. incoming rid=",
              msg.response_id || msg.response?.id);
          }
          const rid = msg.response_id || msg.response?.id;
          if (!rid || rid !== activeResponseId) return;
          const b64 = msg.delta;
          audioDeltaCount++;
          if (audioDeltaCount === 1 && session.lastSpeechEndTs) {
            console.log(
              `⏱️ TTS latency (openai): fin parole patient -> premier byte audio = ${Date.now() - session.lastSpeechEndTs}ms`
            );
            session.lastSpeechEndTs = null;
          }
          if (audioDeltaCount % 50 === 0) {
            console.log("🔊 audio delta passing", audioDeltaCount,
              "label=", activeResponseLabel);
          }
          if (b64 && session.streamSid &&
              twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: "media",
              streamSid: session.streamSid,
              media: { payload: b64 }
            }));
            forwardedDeltaCount++;
            if (audioDeltaCount <= 5) {
              console.log("📤 forwarded sample", audioDeltaCount,
                "b64len=", b64?.length || 0,
                "label=", activeResponseLabel);
            }
            if (audioDeltaCount % 50 === 0) {
              console.log("📤 forwarded to Twilio", audioDeltaCount,
                "bytes(b64)=", b64?.length || 0,
                "label=", activeResponseLabel);
            }
          }
          return;
        }

        if (msg.type === "response.output_audio.done") {
          const rid = msg.response_id || msg.response?.id;
          if (rid && rid === activeResponseId) {
            console.log(
              "✅ audio done", rid,
              "deltas_in=", audioDeltaCount,
              "deltas_forwarded=", forwardedDeltaCount,
              "twilioState=", twilioWs.readyState,
              "streamSid=", session.streamSid,
              "label=", activeResponseLabel
            );
            forwardedDeltaCount = 0;
          }
          return;
        }

        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          if (session.sttPaused) return;
          const transcript = (msg.transcript || "").trim();
          console.log("📝 transcript reçu:", transcript);
          const wc = transcript.trim().split(/\s+/).filter(Boolean).length;
          if (wc < 2) return;
          if (!getValidN8nBrainUrl()) return;
          if (!session.streamSid) return;
          if (session.sttPaused || session.responded) return;
          if (session.listenReadyAt == null || Date.now() < session.listenReadyAt) return;
          if (session.lastTranscript === transcript) return;
          session.lastTranscript = transcript;
          // Approximation de la fin de parole patient : réception du dernier
          // segment transcrit (mis à jour à chaque segment, le dernier fait foi).
          session.lastSpeechEndTs = Date.now();
          session.turnTimings = { speechEnd: session.lastSpeechEndTs };
          pushTranscriptChunk(transcript);
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

        if (msg.type === "response.done") {
          const rid = msg.response?.id || msg.response_id;
          if (rid && rid === activeResponseId) {
            console.log("✅ response.done for", rid,
              "label=", activeResponseLabel);
            activeResponseId = null;
            activeResponseLabel = "";
          }
          const wasWelcome = session._welcomeResponsePending;
          session.openAiResponseInProgress = false;
          console.log("✅ response finished -> flags reset", msg.type);
          if (wasWelcome) {
            afterWelcomePlayback(session);
          } else {
            session.allowAudio = false;
            session._welcomeResponsePending = false;
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
          const gaSession = buildOpenAiRealtimeGaSession(
            "Tu es un serveur TTS. Tu ne dois JAMAIS improviser, reformuler, ajouter des mots, ni poser de questions. Quand l'application te fournit un texte à dire, tu dois le lire EXACTEMENT à l'identique puis t'arrêter. Si le texte est incomplet (ex: '...'), lis uniquement ce qui est fourni puis stop. N'ajoute jamais de ponctuation ou de salutations supplémentaires."
          );
          oaiWs.send(
            JSON.stringify({
              type: "session.update",
              session: gaSession,
            })
          );
          console.log(
            "✅ session.update sent (GA)",
            "session.type=", gaSession.type,
            "turn_detection=", gaSession.audio?.input?.turn_detection
          );
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
    /** Timestamp de fin de parole patient (dernier segment transcrit) — pour les logs de latence TTS. */
    lastSpeechEndTs: null,
    /** Horodatages du tour courant (fin parole, n8n, Azure, envoi Twilio) pour le récap latence. */
    turnTimings: null,
    /** Mark Twilio en attente d'echo (fin de lecture de l'audio Azure). */
    _pendingMark: null,
    audioPacketCount: 0,
    allowAudio: false,
    didWelcome: false,
  };

  function pushTranscriptChunk(chunk) {
    const chunkText = (chunk || "").trim();
    if (!chunkText) return;

    if (pendingText) pendingText += " ";
    pendingText += chunkText;

    if (pendingTimer) clearTimeout(pendingTimer);

    const text = (pendingText || "").trim();
    const words = text ? text.split(/\s+/).length : 0;

    let delayMs = 1000;
    let delayReason = "neutral";

    const endsWithEllipsis = text.endsWith("...");
    const endsWithNonTerminalPunct = /[,;:-]$/.test(text);
    const startsLikeQuestion =
      /^(est-ce que|est ce que|je voudrais|j'aimerais|j'ai|j’ai|bonjour)\b/i.test(text);
    const endsWithTerminalPunct = /[.?!…]$/.test(text);

    const looksIncomplete =
      !endsWithTerminalPunct &&
      (endsWithEllipsis || endsWithNonTerminalPunct || (startsLikeQuestion && words < 9));

    if (looksIncomplete) {
      delayMs = 1400;
      delayReason = "incomplete";
    } else if (endsWithTerminalPunct && words >= 4) {
      delayMs = 700;
      delayReason = "terminal_punctuation";
    }
    console.log(`transcript_buffer_delay=${delayMs} reason=${delayReason}`);

    pendingTimer = setTimeout(() => {
      const finalText = pendingText.trim();
      pendingText = "";
      pendingTimer = null;
      const wc = finalText.split(/\s+/).filter(Boolean).length;
      if (wc < 2) return;
      session.turnTimings = session.turnTimings || {};
      session.turnTimings.transcriptFinal = Date.now();
      console.log(`📝 transcript tour final buffer (${wc} mots)`);
      void handleFinalUserTranscript(ws, session, finalText, playTextWithSttGuard, degradedFallback);
    }, delayMs);
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

    // MARK : echo du mark envoyé après l'audio Azure — Twilio a fini de jouer le buffer.
    if (evt.event === "mark") {
      const markName = evt.mark?.name;
      if (session._pendingMark && session._pendingMark.name === markName) {
        console.log(`🔷 mark echo Twilio reçu (${markName})`);
        session._pendingMark.resolve();
        session._pendingMark = null;
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

    if (evt.event === "stop") {
      console.log("⏹️ stop", evt.stop);
      console.log(`✅ total media packets: ${session.mediaCount}`);

      // Débloque une éventuelle attente de mark (l'appel se termine, l'echo ne viendra plus).
      if (session._pendingMark) {
        session._pendingMark.resolve();
        session._pendingMark = null;
      }

      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingText = "";

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
