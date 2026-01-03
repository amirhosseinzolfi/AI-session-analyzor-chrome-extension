import {
  BACKEND_BASE_URL,
  BACKEND_AUDIO_URL,
  ANALYZE_TIMEOUT_MS,
  AUDIO_FETCH_TIMEOUT_MS,
  AUDIO_STORAGE_PREFIX,
  OFFSCREEN_PATH,
  REPORT_PATH
} from './config.js';

const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);
const REPORT_VIEW_URL = chrome.runtime.getURL(REPORT_PATH);
const autoOpenedReportSessions = new Set();

function fetchWithTimeout(url, options = {}, timeoutMs = ANALYZE_TIMEOUT_MS) {
  if (options?.signal) return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function ensureOffscreenDocument() {
  if (!chrome?.offscreen?.hasDocument) return;
  const hasDoc = await chrome.offscreen.hasDocument();
  if (hasDoc) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["BLOBS"],
    justification: "Analyze session audio in a durable context",
  });
}

function dispatchOffscreenAnalysis(job) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage({ action: "OFFSCREEN_ANALYZE_SESSION", payload: job }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.ok) {
          resolve();
        } else {
          reject(new Error(response?.error || "Offscreen document rejected analysis job"));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function openReportTab(sessionId) {
  if (!sessionId || autoOpenedReportSessions.has(sessionId)) return;
  autoOpenedReportSessions.add(sessionId);
  const url = `${REPORT_VIEW_URL}?sessionId=${encodeURIComponent(sessionId)}`;
  try {
    await chrome.tabs.create({ url });
  } catch (error) {
    console.warn("Failed to open report tab", error);
  }
}

async function requestBackendAnalysis({ sessionId, audioBase64, mimeType, userId, userName, durationMinutes }) {
  const response = await fetchWithTimeout(
    `${BACKEND_BASE_URL}/analyze_base64`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        mime_type: mimeType,
        audio_base64: audioBase64,
        user_id: userId,
        user_name: userName,
        duration_minutes: durationMinutes,
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
    throw new Error(data?.error || `HTTP ${response.status}`);
  }

  return data;
}

async function persistSessionAudioBlob(sessionId, audioBase64) {
  if (!sessionId || !audioBase64) return;
  try {
    await chrome.storage.local.set({ [`${AUDIO_STORAGE_PREFIX}${sessionId}`]: audioBase64 });
  } catch (error) {
    console.error("Failed to persist session audio", sessionId, error);
  }
}

async function clearSessionAudioBlob(sessionId) {
  if (!sessionId) return;
  try {
    await chrome.storage.local.remove(`${AUDIO_STORAGE_PREFIX}${sessionId}`);
  } catch (error) {
    console.error("Failed to remove session audio", sessionId, error);
  }
}

async function getUserProfile() {
  const { userProfile } = await chrome.storage.local.get("userProfile");
  if (userProfile?.id && userProfile?.name) return userProfile;
  const profile = {
    id: crypto.randomUUID(),
    name: `User-${new Date().getFullYear()}`,
  };
  await chrome.storage.local.set({ userProfile: profile });
  return profile;
}

async function loadSessionAudioBlob(sessionId) {
  if (!sessionId) return null;
  const key = `${AUDIO_STORAGE_PREFIX}${sessionId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

async function getSessionById(sessionId) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  return sessions.find((s) => s.id === sessionId);
}

async function fetchSessionAudioFromBackend(userId, sessionId) {
  if (!userId || !sessionId) return null;
  try {
    const resp = await fetchWithTimeout(
      `${BACKEND_AUDIO_URL}/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}`,
      {},
      AUDIO_FETCH_TIMEOUT_MS
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch (error) {
    console.warn("Failed to fetch stored audio", sessionId, error);
    return null;
  }
}

async function ensureAudioForSession({ session, providedAudio, mimeType }) {
  if (providedAudio) {
    return { audioBase64: providedAudio, mimeType: mimeType || session.audio_mime_type || "audio/webm" };
  }
  const cached = await loadSessionAudioBlob(session.id);
  if (cached) {
    return { audioBase64: cached, mimeType: session.audio_mime_type || "audio/webm" };
  }
  const downloaded = await fetchSessionAudioFromBackend(session.user_id, session.id);
  if (downloaded?.audio_base64) {
    await persistSessionAudioBlob(session.id, downloaded.audio_base64);
    await updateSession(session.id, {
      has_audio: true,
      audio_mime_type: downloaded.mime_type || "audio/webm",
    });
    return { audioBase64: downloaded.audio_base64, mimeType: downloaded.mime_type || "audio/webm" };
  }
  return { audioBase64: null, mimeType: mimeType || session.audio_mime_type || "audio/webm" };
}

async function processSessionAudioJob(payload = {}) {
  const { sessionId, audioBase64, mimeType, durationMinutes } = payload;
  const session = await getSessionById(sessionId);
  if (!session) {
    console.warn("Session not found for analysis", sessionId);
    return;
  }
  const { audioBase64: readyAudio, mimeType: resolvedMime } = await ensureAudioForSession({
    session,
    providedAudio: audioBase64,
    mimeType,
  });
  if (!readyAudio) {
    await updateSession(sessionId, {
      status: "failed",
      session_report: "فایل صوتی برای تحلیل موجود نیست.",
    });
    return;
  }
  await updateSession(sessionId, {
    status: "processing",
    audio_base64: readyAudio,
    audio_mime_type: resolvedMime,
  });
  autoOpenedReportSessions.delete(sessionId);

  const canUseOffscreen = Boolean(chrome?.offscreen?.hasDocument);
  if (!canUseOffscreen) {
    try {
      const result = await requestBackendAnalysis({
        sessionId,
        audioBase64: readyAudio,
        mimeType: resolvedMime,
        userId: session.user_id,
        userName: session.user_name,
        durationMinutes: durationMinutes,
      });
      const isError = result?.status === "error";
      await updateSession(sessionId, {
        status: isError ? "failed" : "done",
        title: result?.title || session.title || "Session Report",
        session_report:
          result?.session_report || result?.error || (isError ? "مدل خروجی معتبر ارسال نکرد." : ""),
      });
      if (!isError && result?.session_report) {
        await openReportTab(sessionId);
      }
    } catch (error) {
      await updateSession(sessionId, {
        status: "failed",
        session_report: `خطا در تحلیل جلسه: ${error?.message || error}`,
      });
    }
    return;
  }

  try {
    await dispatchOffscreenAnalysis({
      sessionId,
      audioBase64: readyAudio,
      mimeType: resolvedMime,
      userId: session.user_id,
      userName: session.user_name,
      durationMinutes: durationMinutes,
    });
  } catch (error) {
    await updateSession(sessionId, {
      status: "failed",
      session_report: `خطا در آغاز تحلیل: ${error?.message || error}`,
    });
  }
}

function newSessionMeta(profile) {
  return {
    id: crypto.randomUUID(),
    title: "Session",
    created_at: new Date().toISOString(),
    status: "recording",
    session_report: null,
    audio_base64: null,
    user_id: profile.id,
    user_name: profile.name,
    has_audio: false,
    audio_mime_type: "audio/webm",
  };
}

async function pushSession(session) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  sessions.push(session);
  await chrome.storage.local.set({ sessions });
}

async function updateSession(id, patch) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  const idx = sessions.findIndex(s => s.id === id);
  if (idx >= 0) {
    const existing = { ...sessions[idx] };
    const { audio_base64, ...rest } = patch || {};
    if (audio_base64 !== undefined) {
      if (audio_base64) {
        await persistSessionAudioBlob(id, audio_base64);
        existing.has_audio = true;
      } else {
        await clearSessionAudioBlob(id);
        existing.has_audio = false;
      }
    }
    sessions[idx] = { ...existing, ...rest };
    await chrome.storage.local.set({ sessions });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.action === "START_RECORDING") {
        const profile = await getUserProfile();
        const session = newSessionMeta(profile);
        await pushSession(session);
        await chrome.storage.local.set({ activeSessionId: session.id });
        await chrome.action.setBadgeText({ text: "●" });
        await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
            // Return the created session id so the popup can start capturing
            // media with the user's gesture and associate the recording with
            // this session.
            sendResponse({ ok: true, sessionId: session.id });
        return;
      }

      if (msg.action === "STOP_RECORDING") {
        // STOP_RECORDING is used by the popup to set the session status
        // to processing. The popup will still hold the sessionId returned
        // earlier when START_RECORDING was called and will send the
        // final SESSION_REPORT_READY when the backend returns the report.
        const { activeSessionId } = await chrome.storage.local.get("activeSessionId");
        if (!activeSessionId) {
          sendResponse({ ok: false, error: "No active session." });
          return;
        }

        await updateSession(activeSessionId, { status: "processing" });
        // Clear activeSessionId so the UI can start a new recording while
        // this session is being processed by the backend.
        await chrome.storage.local.remove("activeSessionId");
        await chrome.action.setBadgeText({ text: "" });
        sendResponse({ ok: true, sessionId: activeSessionId });
        return;
      }

      if (msg.action === "PROCESS_SESSION_AUDIO") {
        if (!msg.payload?.sessionId) {
          sendResponse({ ok: false, error: "Missing sessionId." });
          return;
        }
        processSessionAudioJob(msg.payload || {}).catch((error) => {
          console.error("Session analysis scheduling failed", error);
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg.action === "OFFSCREEN_ANALYSIS_COMPLETE") {
        const { sessionId, result, error: resultError } = msg.payload || {};
        if (!sessionId) {
          sendResponse({ ok: false, error: "Missing sessionId." });
          return;
        }

        if (resultError) {
          await updateSession(sessionId, {
            status: "failed",
            session_report: `خطا در تحلیل جلسه: ${resultError}`,
          });
          sendResponse({ ok: true });
          return;
        }

        const isError = result?.status === "error";
        await updateSession(sessionId, {
          status: isError ? "failed" : "done",
          title: result?.title || "Session Report",
          session_report:
            result?.session_report || result?.error || (isError ? "مدل خروجی معتبر ارسال نکرد." : ""),
        });

        if (!isError && result?.session_report) {
          await openReportTab(sessionId);
        }

        sendResponse({ ok: true });
        return;
      }

      if (msg.action === "SESSION_REPORT_READY") {
        const { sessionId, title, sessionReport, status, audioBase64, hasAudio } = msg.payload || {};
        if (!sessionId) {
          sendResponse({ ok: false, error: "Missing sessionId." });
          return;
        }
        const resolvedStatus = status === "error" ? "failed" : "done";
        const patch = {
          status: resolvedStatus,
          title: title || "Session Report",
          session_report: sessionReport || "",
        };
        if (typeof hasAudio === "boolean") {
          patch.has_audio = hasAudio;
        }
        if (audioBase64 !== undefined) {
          patch.audio_base64 = audioBase64;
          if (typeof hasAudio !== "boolean") {
            patch.has_audio = Boolean(audioBase64);
          }
        }
        await updateSession(sessionId, patch);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown action." });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true; // keep channel open for async sendResponse
});
