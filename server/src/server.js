import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;
const SESSIONS_URL = process.env.OPENAI_REALTIME_SESSIONS_URL || "https://api.openai.com/v1/realtime/sessions";
const REALTIME_URL = process.env.OPENAI_REALTIME_URL || "https://api.openai.com/v1/realtime"; // SDP ÍµêÌôò??Î≤†Ïù¥??URL
const VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";
// ÏµúÏã† Í∏∞Î≥∏ Î™®Îç∏ ?∞ÏÑ† ?¨Ïö© (?òÍ≤ΩÎ≥Ä?òÎ°ú ?§Î≤Ñ?ºÏù¥??Í∞Ä??
const PRIMARY_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const FALLBACK_MODEL = "gpt-realtime"; // Ï∂îÍ? ?ÑÎ≥¥

app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "../../client")));

app.get("/health", (_req, res) => {
  const hasKey = !!process.env.OPENAI_API_KEY;
  res.json({
    ok: true,
    OPENAI_API_KEY: hasKey ? "present" : "missing",
    MODEL: PRIMARY_MODEL,
    VOICE,
    SESSIONS_URL
  });
});

// ?∏ÏÖò ?ùÏÑ± ?®Ïàò (?îÎ≤ÑÍ∑?Î°úÍ∑∏ ?¨Ìï®)
async function createRealtimeSession({ model, instructions }) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const body = {
    model,
    voice: VOICE,
    instructions,
    modalities: ["text", "audio"],
    turn_detection: { type: "server_vad" },
    input_audio_transcription: {
      // gpt-5-mini-transcribe ?ÑÏû¨ ÎØ∏Ï?????Í≥µÏãù ÏßÄ??Î™®Îç∏ ?¨Ïö©
      model: "gpt-4o-mini-transcribe"
    }
  };

  const resp = await fetch(SESSIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "realtime=v1"       // ?î¥ ?ÑÏàò
    },
    body: JSON.stringify(body)
  });

  const text = await resp.text();

    if (!resp.ok) {
   console.error("[session:create] OpenAI error", resp.status, text);
   throw new Error(`OpenAI session failed: ${resp.status} ${text}`);
  }

  // ?¥Îñ§ Í≤ΩÏö∞??HTML/Í≥µÏ? ?òÏù¥ÏßÄÍ∞Ä ?????àÏúº??Î∞©Ï?
  if (text.trim().startsWith("<!DOCTYPE html")) {
    console.error("[session:create] HTML received (proxy/portal?)", text.slice(0, 200));
    throw new Error("HTML page received instead of JSON (check proxy/firewall)");
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.error("[session:create] JSON parse error (raw):", text);
    throw new Error("Session JSON parse error");
  }

  // OpenAI ?úÏ? ?êÎü¨ ?ïÏãù ?ÑÌåå
  if (json && json.error) {
    const msg = json.error.message || json.error.code || "Unknown OpenAI error";
    console.error("[session:create] OpenAI error payload:", json);
    throw new Error(`OpenAI session error: ${msg}`);
  }

  const sessionUrl = json.url; // ?ºÎ? Íµ¨Î≤Ñ???¥Î? ?ëÎãµ???¨Ìï®?????àÏùå
  const ephemeral = json.client_secret?.value;
  if (!ephemeral) {
    console.error("[session:create] Missing fields in response (full json):", json);
    const keys = Object.keys(json || {});
    throw new Error(`Invalid OpenAI session response (keys: ${keys.join(",")})`);
  }

  return { sessionUrl, ephemeral };
}

app.post("/realtime/sdp", async (req, res) => {
  try {
    const { mode = "auto", offerSdp } = req.body || {};
    if (!offerSdp || !offerSdp.startsWith("v=")) {
      return res.status(400).json({ error: "Invalid offer SDP" });
    }

    const instructions =
      mode === "ko->en" ? "You are a simultaneous interpreter. Detect Korean and respond as NATURAL English speech only."
    : mode === "en->ko" ? "You are a simultaneous interpreter. Detect English and respond as NATURAL Korean speech only, polite business tone."
    : "You are a simultaneous interpreter. Auto-detect Korean/English and speak in the opposite language, concise and professional.";

    // 1) Í∏∞Î≥∏ Î™®Îç∏ ?úÎèÑ ???§Ìå® ???¥Î∞±
    let modelTried = PRIMARY_MODEL;
    let session;
    try {
      session = await createRealtimeSession({ model: modelTried, instructions });
    } catch (e) {
      console.warn(`[realtime/sdp] Primary model failed (${modelTried}).`, e.message);
      if (FALLBACK_MODEL && FALLBACK_MODEL !== modelTried) {
        modelTried = FALLBACK_MODEL;
        session = await createRealtimeSession({ model: modelTried, instructions });
      } else {
        throw e;
      }
    }

    // 2) ?úÎ≤ÑÍ∞Ä SDP ÍµêÌôò (?¥Îùº ???úÎ≤Ñ ??OpenAI)
    // ?∏ÏÖò ?ëÎãµ??url???ÜÏúºÎ©?Í≥µÏãù ?îÎìú?¨Ïù∏??+ model ÏøºÎ¶¨Î•??¨Ïö©
    const sdpUrl = session.sessionUrl || `${REALTIME_URL}?model=${encodeURIComponent(modelTried)}`;
    const answerRes = await fetch(sdpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.ephemeral}`,
        "Content-Type": "application/sdp",
        "Accept": "application/sdp",
        "OpenAI-Beta": "realtime=v1"     // ?î¥ ?ÑÏàò
      },
      body: offerSdp
    });

    const answerSdp = await answerRes.text();
    if (!answerRes.ok || !answerSdp.startsWith("v=")) {
      console.error("[realtime/sdp] SDP answer failed", answerRes.status, answerSdp.slice(0, 200));
      return res.status(answerRes.status).json({ error: `SDP answer failed: ${answerSdp}` });
    }

    res.type("application/sdp").send(answerSdp);
  } catch (e) {
    console.error("[realtime/sdp] Error:", e.message);
    return res.status(500).json({ error: e.message || "Unknown error" });
  }
});

// Í∏∞Î≥∏ ?òÏù¥ÏßÄ
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../../client/index.html"));
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
