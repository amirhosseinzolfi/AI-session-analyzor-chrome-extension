const BACKEND_BASE_URL = "http://82.115.13.132:15306";
const BACKEND_ANALYZE_URL = `${BACKEND_BASE_URL}/analyze_base64`;
const ANALYZE_TIMEOUT_MS = 240000; // 4 minutes to mirror backend upper bound

function fetchWithTimeout(url, options = {}, timeoutMs = ANALYZE_TIMEOUT_MS) {
  if (options?.signal) return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function runBackendAnalysis(payload = {}) {
  const { sessionId, audioBase64, mimeType = "audio/webm", userId, userName } = payload;
  if (!sessionId || !audioBase64) {
    throw new Error("Missing audio payload for analysis");
  }

  const response = await fetchWithTimeout(
    BACKEND_ANALYZE_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        mime_type: mimeType,
        audio_base64: audioBase64,
        user_id: userId,
        user_name: userName,
      }),
    },
    ANALYZE_TIMEOUT_MS
  );

  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    console.warn("Failed to parse backend response", error);
  }

  if (!response.ok) {
    throw new Error(data?.error || `کد خطا ${response.status}`);
  }

  return {
    sessionId,
    title: data?.title || "Session Report",
    session_report: data?.session_report || data?.error || "",
    status: data?.status || "ok",
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "OFFSCREEN_ANALYZE_SESSION") {
    (async () => {
      try {
        const result = await runBackendAnalysis(msg.payload || {});
        await chrome.runtime.sendMessage({
          action: "OFFSCREEN_ANALYSIS_COMPLETE",
          payload: { sessionId: result.sessionId, result },
        });
        sendResponse({ ok: true });
      } catch (error) {
        await chrome.runtime.sendMessage({
          action: "OFFSCREEN_ANALYSIS_COMPLETE",
          payload: { sessionId: msg.payload?.sessionId, error: error?.message || String(error) },
        });
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }
});
