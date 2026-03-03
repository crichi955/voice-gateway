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

  ws.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg.toString());

      if (evt.event === "start") {
        console.log("▶️ start", evt.start);
        mediaCount = 0;
      }

      if (evt.event === "media") {
        mediaCount++;
        if (mediaCount % 50 === 0) {
          console.log(`🎧 media packets: ${mediaCount}`);
        }
      }

      if (evt.event === "stop") {
        console.log("⏹️ stop", evt.stop);
        console.log(`✅ total media packets: ${mediaCount}`);
      }
    } catch (e) {
      console.log("⚠️ non-JSON message", msg.toString().slice(0, 120));
    }
  });

  ws.on("close", () => console.log("❌ Twilio WS closed"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Voice Gateway listening on :${PORT}`);
});