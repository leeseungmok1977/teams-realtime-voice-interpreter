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
const REALTIME_URL = process.env.OPENAI_REALTIME_URL || "https://api.openai.com/v1/realtime"; // SDP 교환??베이??URL
const VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";
// 최신 기본 모델 ?�선 ?�용 (?�경변?�로 ?�버?�이??가??
const PRIMARY_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const FALLBACK_MODEL = "gpt-realtime"; // 추�? ?�보

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

// ?�션 ?�성 ?�수 (?�버�?로그 ?�함)
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
      // gpt-5-mini-transcribe ?�재 미�?????공식 지??모델 ?�용
      model: "gpt-4o-mini-transcribe"
    }
  };

  const resp = await fetch(SESSIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "realtime=v1"       // ?�� ?�수
    },
    body: JSON.stringify(body)
  });

  const text = await resp.text();

    if (!resp.ok) {
   console.error("[session:create] OpenAI error", resp.status, text);
   throw new Error(`OpenAI session failed: ${resp.status} ${text}`);
  }

  // ?�떤 경우??HTML/공�? ?�이지가 ?????�으??방�?
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

  // OpenAI ?��? ?�러 ?�식 ?�파
  if (json && json.error) {
    const msg = json.error.message || json.error.code || "Unknown OpenAI error";
    console.error("[session:create] OpenAI error payload:", json);
    throw new Error(`OpenAI session error: ${msg}`);
  }

  const sessionUrl = json.url; // ?��? 구버???��? ?�답???�함?????�음
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

    // 1) 기본 모델 ?�도 ???�패 ???�백
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

    // 2) ?�버가 SDP 교환 (?�라 ???�버 ??OpenAI)
    // ?�션 ?�답??url???�으�?공식 ?�드?�인??+ model 쿼리�??�용
    const sdpUrl = session.sessionUrl || `${REALTIME_URL}?model=${encodeURIComponent(modelTried)}`;
    const answerRes = await fetch(sdpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.ephemeral}`,
        "Content-Type": "application/sdp",
        "Accept": "application/sdp",
        "OpenAI-Beta": "realtime=v1"     // ?�� ?�수
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

// 기본 ?�이지
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../../client/index.html"));
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
