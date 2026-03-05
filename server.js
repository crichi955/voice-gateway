import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();

app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

// WebSocket endpoint for Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (ws) => {
  console.log("✅ Twilio WS connected");
  let mediaCount = 0;

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
    if (mediaCount % 50 === 0) {
      console.log(`🎧 media packets: ${mediaCount}`);
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