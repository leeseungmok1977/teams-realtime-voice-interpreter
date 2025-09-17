import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env'), override: true });

const app = express();
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;
const SESSIONS_URL = process.env.OPENAI_REALTIME_SESSIONS_URL || "https://api.openai.com/v1/realtime/sessions";
const REALTIME_URL = process.env.OPENAI_REALTIME_URL || "https://api.openai.com/v1/realtime"; // SDP 援먰솚??踰좎씠??URL
const VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";
// 理쒖떊 湲곕낯 紐⑤뜽 ?곗꽑 ?ъ슜 (?섍꼍蹂?섎줈 ?ㅻ쾭?쇱씠??媛??
const PRIMARY_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-mini-realtime-preview";
const FALLBACK_MODEL = "gpt-4o-mini-realtime-preview"; // 異붽? ?꾨낫

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

// ?몄뀡 ?앹꽦 ?⑥닔 (?붾쾭洹?濡쒓렇 ?ы븿)
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
    turn_detection: {
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 800
    },
    input_audio_transcription: {
      // gpt-5-mini-transcribe ?꾩옱 誘몄?????怨듭떇 吏??紐⑤뜽 ?ъ슜
      model: "gpt-4o-mini-transcribe"
    }
  };

  const resp = await fetch(SESSIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "realtime=v1"       // ?뵶 ?꾩닔
    },
    body: JSON.stringify(body)
  });

  const text = await resp.text();

    if (!resp.ok) {
   console.error("[session:create] OpenAI error", resp.status, text);
   throw new Error(`OpenAI session failed: ${resp.status} ${text}`);
  }

  // ?대뼡 寃쎌슦??HTML/怨듭? ?섏씠吏媛 ?????덉쑝??諛⑹?
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

  // OpenAI ?쒖? ?먮윭 ?뺤떇 ?꾪뙆
  if (json && json.error) {
    const msg = json.error.message || json.error.code || "Unknown OpenAI error";
    console.error("[session:create] OpenAI error payload:", json);
    throw new Error(`OpenAI session error: ${msg}`);
  }

  const sessionUrl = json.url; // ?쇰? 援щ쾭???대? ?묐떟???ы븿?????덉쓬
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
      mode === "ko->en" ? "You are a translation machine. Input: Korean speech. Output: EXACT English translation only. NEVER respond to content, NEVER add your own thoughts, NEVER answer questions. Just translate Korean to English word-for-word."
    : mode === "en->ko" ? "You are a translation machine. Input: English speech. Output: EXACT Korean translation only. NEVER respond to content, NEVER add your own thoughts, NEVER answer questions. Just translate English to Korean word-for-word with polite tone."
    : "You are a translation machine. Auto-detect input language (Korean/English). Output: EXACT translation to opposite language only. NEVER respond to content, NEVER add thoughts, NEVER answer questions. Just translate word-for-word.";

    // 1) 湲곕낯 紐⑤뜽 ?쒕룄 ???ㅽ뙣 ???대갚
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

    // 2) ?쒕쾭媛 SDP 援먰솚 (?대씪 ???쒕쾭 ??OpenAI)
    // ?몄뀡 ?묐떟??url???놁쑝硫?怨듭떇 ?붾뱶?ъ씤??+ model 荑쇰━瑜??ъ슜
    const sdpUrl = session.sessionUrl || `${REALTIME_URL}?model=${encodeURIComponent(modelTried)}`;
    const answerRes = await fetch(sdpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.ephemeral}`,
        "Content-Type": "application/sdp",
        "Accept": "application/sdp",
        "OpenAI-Beta": "realtime=v1"     // ?뵶 ?꾩닔
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

// 湲곕낯 ?섏씠吏
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../../client/index.html"));
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

