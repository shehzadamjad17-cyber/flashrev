import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

/* ================= EXPRESS ================= */
const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ================= HELPERS ================= */
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) {
      c.send(msg);
    }
  }
}

function generateCallId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ================= GEMINI SUMMARY ================= */
async function generateSummary(agent, transcriptText) {
  if (!transcriptText.trim()) return "No conversation detected.";

  const prompt = `
You are an AI call analysis assistant.

1. Describe the tone of the speakers.
2. Suggest how the call could be improved.
3. List 3–5 key points.

Conversation:
${transcriptText}
`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: prompt }] }
          ]
        })
      }
    );

    const data = await res.json();

    if (data.error) {
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
function openDeepgram(ws, source) {
  const dg = new WebSocket(
    "wss://api.deepgram.com/v1/listen" +
      "?model=nova-2" +
      "&language=en-US" +
      "&encoding=linear16" +
      "&sample_rate=16000" +
      "&channels=1" +
      "&interim_results=true" +
      "&smart_format=true" +
      "&punctuate=true",
    {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
      }
    }
  );

  dg.ready = false;
  dg.buffer = [];

  dg.on("open", () => {
    dg.ready = true;
    dg.buffer.forEach(chunk => dg.send(chunk));
    dg.buffer.length = 0;
    console.log(`🟢 DG OPEN [${source}] | ${ws.agent} | ${ws.callId}`);
  });

  dg.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const alt = data.channel?.alternatives?.[0];
    if (!alt?.transcript) return;

    // 🔥 FINAL SENTENCES ONLY
    if (!data.is_final) return;

    const text = alt.transcript.trim();
    if (!text) return;

    ws.transcripts.push(text);

    broadcast({
      type: "transcript",
      agent: ws.agent,
      callId: ws.callId,
      source,
      text,
      final: true
    });
  });

  dg.on("close", () => {
    console.log(`🔴 DG CLOSED [${source}] | ${ws.agent} | ${ws.callId}`);
  });

  dg.on("error", (e) => {
    console.error(`❌ DG ERROR [${source}]`, e.message);
  });

  return dg;
}

/* ================= WEBSOCKET ================= */
wss.on("connection", (ws) => {
  console.log("🔌 Client connected");

  ws.agent = null;
  ws.callId = null;
  ws.startTime = null;
  ws.currentSource = "mic";
  ws.transcripts = [];

  ws.on("message", (data, isBinary) => {

    /* ===== CONTROL MESSAGES ===== */
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === "agent_join") {
        ws.agent = msg.agent;
        ws.callId = generateCallId();   // 🔥 UNIQUE SESSION
        ws.startTime = Date.now();

        console.log("👤 Agent joined:", ws.agent, ws.callId);

        broadcast({
          type: "agent_join",
          agent: ws.agent,
          callId: ws.callId,
          startTime: ws.startTime
        });

        ws.dgMic = openDeepgram(ws, "mic");
        ws.dgTab = openDeepgram(ws, "tab");
        return;
      }

      if (msg.type === "audio_source") {
        ws.currentSource = msg.source; // mic | tab
        return;
      }

      return;
    }

    /* ===== AUDIO STREAM ===== */
    const dg =
      ws.currentSource === "mic" ? ws.dgMic : ws.dgTab;

    if (!dg) return;

    if (dg.ready && dg.readyState === WebSocket.OPEN) {
      dg.send(data);
    } else {
      dg.buffer.push(data);
    }
  });

  ws.on("close", async () => {
    console.log("❌ Agent disconnected:", ws.agent, ws.callId);

    try { ws.dgMic?.close(); } catch {}
    try { ws.dgTab?.close(); } catch {}

    if (!ws.agent || !ws.callId) return;

    console.log("🧠 Generating summary:", ws.agent, ws.callId);

    const summary = await generateSummary(
      ws.agent,
      ws.transcripts.join(" ")
    );

    broadcast({
      type: "summary",
      agent: ws.agent,
      callId: ws.callId,
      summary
    });

    console.log("✅ Summary sent:", ws.agent, ws.callId);
  });
});

/* ================= START ================= */
server.listen(3000, () => {
  console.log("🚀 Server running");
  console.log("👉 http://localhost:3000/agent.html");
  console.log("👉 http://localhost:3000/manager.html");
});
