import OpenAI from "openai";
import wavefilePkg from "wavefile";
const { WaveFile } = wavefilePkg;
import { mulaw } from "alawmulaw";

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();

app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

// WebSocket endpoint for Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (ws) => {
  console.log("✅ Twilio WS connected");
  let mediaCount = 0;
  // --- STT buffer (μ-law 8kHz) ---
  let audioChunks = [];
  let audioBytes = 0;
  let lastFlushTs = Date.now();

  const SEGMENT_MS = Number(process.env.STT_SEGMENT_MS || 4000);
  const STREAM_SAMPLE_RATE = 8000; // Twilio μ-law 8kHz

ws.on("message", async (msg) => {
  const text =
    Buffer.isBuffer(msg) ? msg.toString("utf8") :
    typeof msg === "string" ? msg :
    msg?.toString ? msg.toString() :
    String(msg);

  let evt;
  try {
    evt = JSON.parse(text);
  } catch (e) {
    console.log("⚠️ JSON parse failed:", e.message);
    console.log("⚠️ raw (first 200):", text.slice(0, 200));
    return;
  }

  // START
  if (evt.event === "start") {
    console.log("▶️ start", evt.start);
    mediaCount = 0;

    // Test call to n8n (comme tu l'avais prévu)
    fetch(process.env.N8N_BRAIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call: { provider: "twilio", streamSid: evt.start?.streamSid },
        turn: { text: "TEST NODE → N8N" },
        state: {},
      }),
    })
      .then((r) => r.json())
      .then((data) => console.log("🧠 n8n reply:", data))
      .catch((err) => console.log("❌ n8n error:", err?.message || err));
  }

// MEDIA
if (evt.event === "media") {
  mediaCount++;

  // 1) récupérer le payload base64 (μ-law 8kHz)
  const b64 = evt.media?.payload;
  if (b64) {
    const chunk = Buffer.from(b64, "base64");
    audioChunks.push(chunk);
    audioBytes += chunk.length;
  }

  // log léger
  if (mediaCount % 50 === 0) {
    console.log(`🎧 media packets: ${mediaCount} | buffered: ${audioBytes} bytes`);
  }

  // 2) flush toutes les SEGMENT_MS
  const now = Date.now();
  if (now - lastFlushTs < SEGMENT_MS) return;
  lastFlushTs = now;

  // rien à transcrire
  if (audioBytes < 800) return; // évite les segments trop petits

  // 3) assembler le buffer μ-law
  const ulawBuffer = Buffer.concat(audioChunks, audioBytes);
  audioChunks = [];
  audioBytes = 0;

  try {
    // 4) μ-law -> PCM16 (Int16Array)
    const pcm = mulaw.decode(ulawBuffer); // Int16Array

    // 5) PCM16 -> WAV
    const wav = new WaveFile();
    wav.fromScratch(1, STREAM_SAMPLE_RATE, "16", pcm);
    const wavBuffer = Buffer.from(wav.toBuffer());

    // 6) appel OpenAI Transcriptions
    const model = process.env.STT_MODEL || "gpt-4o-mini-transcribe";
    const language = process.env.STT_LANGUAGE || "fr";

    const transcriptResp = await openai.audio.transcriptions.create({
      file: new File([wavBuffer], "audio.wav", { type: "audio/wav" }),
      model,
      language,
    });

    const transcript = (transcriptResp.text || "").trim();
    if (!transcript) return;

    console.log("📝 transcript:", transcript);

    // 7) envoyer à n8n
    const brain = await fetch(process.env.N8N_BRAIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call: { provider: "twilio", streamSid: evt.media?.streamSid },
        turn: { text: transcript },
        state: {},
      }),
    });

    const brainJson = await brain.json();
    console.log("🧠 n8n reply:", brainJson);
  } catch (err) {
    console.log("❌ STT error:", err?.message || err);
  }
}

  // STOP
  if (evt.event === "stop") {
    console.log("⏹️ stop", evt.stop);
    console.log(`✅ total media packets: ${mediaCount}`);
  }
});

  ws.on("close", () => console.log("❌ Twilio WS closed"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway listening on :${PORT}`);
});