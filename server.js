import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import crypto from "crypto";
import http from "http";
import fetch from "node-fetch";

dotenv.config();

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 3000;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

/* ================= USERS ================= */
const USERS = {
  user1: { password: "password1", role: "agent" },
  user2: { password: "password2", role: "agent" },
  manager: { password: "manager123", role: "manager" }
};

/* ================= EXPRESS ================= */
const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ================= MANAGER BROADCAST ================= */
function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.role === "manager") {
      c.send(data);
    }
  });
}

/* ================= GEMINI SUMMARY ================= */
async function summarizeWithGemini(transcriptText) {
  if (!transcriptText.trim()) {
    return "No conversation detected.";
  }

  const prompt = `
You are an AI call analysis assistant.

Summarize the following call in EXACTLY 5 concise bullet-style lines.
Each line should be short, clear, and meaningful.

Call transcript:
${transcriptText}
`.trim();

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ]
        })
      }
    );

    const data = await res.json();

    if (data.error) {
      console.error("❌ Gemini error:", data.error.message);
      return `Gemini error: ${data.error.message}`;
    }

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const textPart = parts.find(p => p.text);

    return textPart?.text || "Summary text missing.";

  } catch (e) {
    console.error("❌ Gemini failure:", e.message);
    return "Summary generation failed.";
  }
}


/* ================= DEEPGRAM ================= */
function createDeepgramSocket(ws, callId, source) {
  const dg = new WebSocket(
    "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1",
    { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } }
  );

  dg.onopen = () => {
    console.log(`🎧 Deepgram connected (${source})`);
  };

  dg.onmessage = (msg) => {
    let data;
    try {
      data = JSON.parse(msg.data.toString());
    } catch {
      return;
    }

    const alt = data.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;

    if (data.is_final) {
      ws.transcripts[source].push(alt.transcript);
    }

    broadcast({
      type: "transcript",
      callId,
      source,
      text: alt.transcript,
      final: data.is_final
    });
  };

  dg.onerror = err => {
    console.error(`❌ Deepgram error (${source})`, err.message);
  };

  dg.onclose = () => {
    console.log(`🔌 Deepgram closed (${source})`);
  };

  return dg;
}

/* ================= WEBSOCKET ================= */
wss.on("connection", (ws) => {
  ws.isAuthenticated = false;
  ws.username = null;
  ws.role = null;

  ws.callActive = false;
  ws.callId = null;

  ws.dgMic = null;
  ws.dgTab = null;
  ws.lastBinaryType = null;

  ws.transcripts = {
    mic: [],
    tab: []
  };

  ws.on("message", async (data) => {

    /* ---------- TRY JSON ---------- */
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      /* ---------- BINARY AUDIO ---------- */
      if (!ws.callActive) return;

      if (
        ws.lastBinaryType === "mic" &&
        ws.dgMic &&
        ws.dgMic.readyState === WebSocket.OPEN
      ) {
        ws.dgMic.send(data);
      }

      if (
        ws.lastBinaryType === "tab" &&
        ws.dgTab &&
        ws.dgTab.readyState === WebSocket.OPEN
      ) {
        ws.dgTab.send(data);
      }

      return;
    }

    /* ================= AUTH ================= */
    if (msg.type === "auth") {
      const user = USERS[msg.username];
      if (!user || user.password !== msg.password) {
        ws.send(JSON.stringify({ type: "auth_failed" }));
        return;
      }

      ws.isAuthenticated = true;
      ws.username = msg.username;
      ws.role = user.role;

      ws.send(JSON.stringify({
        type: "auth_success",
        username: ws.username,
        role: ws.role
      }));

      if (ws.role === "agent") {
        broadcast({ type: "agent_online", agent: ws.username });
      }

      console.log(`🔐 Authenticated: ${ws.username} (${ws.role})`);
      return;
    }

    if (!ws.isAuthenticated) return;

    /* ================= START CALL ================= */
    if (msg.type === "agent_start" && ws.role === "agent") {
      ws.callId = crypto.randomUUID();
      ws.callActive = true;

      ws.transcripts = { mic: [], tab: [] };

      ws.dgMic = createDeepgramSocket(ws, ws.callId, "mic");
      ws.dgTab = createDeepgramSocket(ws, ws.callId, "tab");

      broadcast({
        type: "agent_join",
        agent: ws.username,
        callId: ws.callId,
        startTime: Date.now()
      });

      console.log(`📞 Call started by ${ws.username}`);
      return;
    }

    /* ================= STOP CALL ================= */
    if (msg.type === "agent_stop" && ws.callActive) {
      ws.callActive = false;

      ws.dgMic?.close();
      ws.dgTab?.close();

      const micText = ws.transcripts.mic.join(" ");
      const tabText = ws.transcripts.tab.join(" ");

      const combinedTranscript = `
AGENT SPEECH:
${micText || "No agent speech detected."}

SYSTEM / TAB AUDIO:
${tabText || "No system audio detected."}
      `.trim();

      let summary = "Summary could not be generated.";

      try {
        summary = await summarizeWithGemini(combinedTranscript);
      } catch (err) {
        console.error("❌ Gemini summary error:", err.message);
      }

      broadcast({
        type: "summary",
        callId: ws.callId,
        summary: summary.replace(/\n/g, "<br>")
      });

      ws.dgMic = null;
      ws.dgTab = null;

      console.log(`🛑 Call ended by ${ws.username}`);
      return;
    }

    /* ================= AUDIO SOURCE TAG ================= */
    if (msg.type === "audio_mic") {
      ws.lastBinaryType = "mic";
      return;
    }

    if (msg.type === "audio_tab") {
      ws.lastBinaryType = "tab";
      return;
    }
  });

  ws.on("close", () => {
    if (ws.role === "agent") {
      broadcast({ type: "agent_offline", agent: ws.username });
      ws.dgMic?.close();
      ws.dgTab?.close();
      console.log(`🔴 Agent disconnected: ${ws.username}`);
    }
  });
});

/* ================= START ================= */
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log("Deepgram key loaded:", !!DEEPGRAM_KEY);
  console.log("Gemini key loaded:", !!GEMINI_KEY);
});
