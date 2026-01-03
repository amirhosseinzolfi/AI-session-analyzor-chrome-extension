const recordBtn = document.getElementById("recordBtn");
const recordLabel = document.getElementById("recordLabel");
const clearBtn = document.getElementById("clearBtn");
const sessionsDiv = document.getElementById("sessions");

let isRecording = false;
let recorder = null;
let chunks = [];
let mixedStream = null;
let displayStreamRef = null;
let micStreamRef = null;
let currentSessionId = null;
let recordingStartTime = null;
let refreshTimeoutId = null;
let hasRealtimeSync = false;
let pendingVisibilityRefresh = false;
let analyzingOverlayTimeoutId = null;
let analyzingOverlayTimedOut = false;

import {
  BACKEND_BASE_URL,
  BACKEND_ANALYZE_URL,
  BACKEND_AUDIO_URL,
  AUDIO_STORAGE_PREFIX,
  ANALYZE_TIMEOUT_MS,
  AUDIO_FETCH_TIMEOUT_MS
} from './config.js';

const REFRESH_DEBOUNCE_MS = 200;
const ANALYZING_OVERLAY_TIMEOUT_MS = 45000; // Auto-dismiss waiting overlay after 45 seconds

async function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, payload });
}

function statusBadge(status) {
  const s = (status || "").toLowerCase();
  if (s === "recording") return `<span class="badge" style="background:rgba(239,68,68,0.15);color:#f87171">● در حال ضبط</span>`;
  if (s === "processing") return `<span class="badge" style="background:rgba(251,191,36,0.15);color:#fbbf24">⏳ در حال پردازش</span>`;
  if (s === "done") return `<span class="badge" style="background:rgba(34,197,94,0.15);color:#4ade80">✓ تکمیل شده</span>`;
  if (s === "failed") return `<span class="badge" style="background:rgba(248,113,113,0.15);color:#f87171">✗ ناموفق</span>`;
  return `<span class="badge" style="background:rgba(100,116,139,0.15);color:#94a3b8">${status}</span>`;
}

let legacyAudioMigrationDone = false;

function openSessionReportTab(sessionId) {
  if (!sessionId) return;
  const url = `${chrome.runtime.getURL("report.html")}?sessionId=${encodeURIComponent(sessionId)}`;
  const maybePromise = chrome.tabs?.create({ url });
  if (maybePromise?.catch) {
    maybePromise.catch((error) => console.warn("Failed to open report tab", error));
  }
}

async function persistSessionAudioBlob(sessionId, audioBase64) {
  if (!sessionId || !audioBase64) return;
  try {
    await chrome.storage.local.set({ [`${AUDIO_STORAGE_PREFIX}${sessionId}`]: audioBase64 });
  } catch (error) {
    console.error("Failed to persist session audio", sessionId, error);
  }
}

async function loadSessionAudioBlob(sessionId) {
  if (!sessionId) return null;
  try {
    const key = `${AUDIO_STORAGE_PREFIX}${sessionId}`;
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  } catch (error) {
    console.error("Failed to load session audio", sessionId, error);
    return null;
  }
}

async function clearSessionAudioBlob(sessionId) {
  if (!sessionId) return;
  try {
    await chrome.storage.local.remove(`${AUDIO_STORAGE_PREFIX}${sessionId}`);
  } catch (error) {
    console.error("Failed to clear session audio", sessionId, error);
  }
}

function fetchWithTimeout(url, options = {}, timeoutMs = ANALYZE_TIMEOUT_MS) {
  if (options?.signal) {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const fetchPromise = fetch(url, { ...options, signal: controller.signal });
  return fetchPromise.finally(() => clearTimeout(timeoutId));
}

function formatBackendError(error) {
  if (!error) return "خطای نامشخص";
  if (error.name === "AbortError") {
    return "مهلت ارتباط با سرور به پایان رسید. لطفاً دوباره تلاش کنید.";
  }
  return error.message || String(error);
}

// Backend analysis now runs in the service worker so long requests survive popup closure.

async function analyzeSessionAudio({ sessionId, audioBase64, sessionMeta, mimeType = "audio/webm" }) {
  const response = await fetchWithTimeout(
    BACKEND_ANALYZE_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        mime_type: mimeType,
        audio_base64: audioBase64,
        user_id: sessionMeta?.user_id,
        user_name: sessionMeta?.user_name,
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
    const detail = data?.error || `کد خطا ${response.status}`;
    throw new Error(detail);
  }

  return data;
}

async function migrateLegacySessionAudio(sessions = []) {
  if (legacyAudioMigrationDone) return;
  const cloned = [...sessions];
  let modified = false;
  for (const session of cloned) {
    if (session?.audio_base64) {
      await persistSessionAudioBlob(session.id, session.audio_base64);
      session.has_audio = true;
      session.audio_base64 = null;
      modified = true;
    }
  }
  if (modified) {
    await chrome.storage.local.set({ sessions: cloned });
  }
  legacyAudioMigrationDone = true;
}

async function fetchSessionAudioFromBackend(session) {
  if (!session?.user_id || !session?.id) return null;
  try {
    const userId = encodeURIComponent(session.user_id);
    const sessionId = encodeURIComponent(session.id);
    const resp = await fetchWithTimeout(
      `${BACKEND_AUDIO_URL}/${userId}/${sessionId}`,
      {},
      AUDIO_FETCH_TIMEOUT_MS
    );
    if (!resp.ok) {
      console.warn("Backend could not provide stored audio", resp.status);
      return null;
    }
    const data = await resp.json();
    return data?.audio_base64 || null;
  } catch (error) {
    console.error("Failed to fetch session audio from backend", error);
    return null;
  }
}

async function resolveSessionAudio(session) {
  if (!session) return null;
  if (session.audio_base64) {
    const inlineAudio = session.audio_base64;
    await patchSession(session.id, { audio_base64: inlineAudio });
    return inlineAudio;
  }
  const cached = await loadSessionAudioBlob(session.id);
  if (cached) return cached;
  const downloaded = await fetchSessionAudioFromBackend(session);
  if (downloaded) {
    await persistSessionAudioBlob(session.id, downloaded);
    await patchSession(session.id, { has_audio: true });
    return downloaded;
  }
  return null;
}

function scheduleRefreshSessions() {
  if (refreshTimeoutId) clearTimeout(refreshTimeoutId);
  refreshTimeoutId = setTimeout(async () => {
    if (document.visibilityState === "visible") {
      pendingVisibilityRefresh = false;
      await refreshSessions();
    } else {
      pendingVisibilityRefresh = true;
    }
  }, REFRESH_DEBOUNCE_MS);
}

function initRealtimeSessionSync() {
  if (hasRealtimeSync) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.sessions || changes.activeSessionId) {
      scheduleRefreshSessions();
    }
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && pendingVisibilityRefresh) {
      pendingVisibilityRefresh = false;
      await refreshSessions();
    }
  });

  hasRealtimeSync = true;
}

async function refreshSessions() {
  const stored = await chrome.storage.local.get(["sessions", "activeSessionId"]);
  let sessions = stored.sessions || [];
  const activeSessionId = stored.activeSessionId ?? null;

  await migrateLegacySessionAudio(sessions);

  if (activeSessionId) {
    isRecording = true;
    recordBtn.classList.add("recording");
    recordLabel.textContent = "توقف ضبط";
  } else {
    isRecording = false;
    recordBtn.classList.remove("recording");
    recordLabel.textContent = "شروع ضبط";
  }

  sessionsDiv.innerHTML = "";
  if (!sessions.length) {
    sessionsDiv.innerHTML = `<div class="empty-state">هنوز جلسهای ثبت نشده. ضبط را شروع کنید!</div>`;
    return;
  }

  let hasProcessing = false;
  const currentSessionIds = new Set();

  for (const s of sessions.slice().reverse()) {
    currentSessionIds.add(s.id);
    if (s.status === "processing") hasProcessing = true;

    const card = document.createElement("div");
    card.className = "card";
    card.style.cursor = s.status === "done" ? "pointer" : "default";
    
    const title = s.title || "جلسه";
    const date = new Date(s.created_at).toLocaleString('fa-IR');
    
    const actionButtons = [
      `<button class="icon-btn regen-btn" data-id="${s.id}" title="بازتحلیل دوباره">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <polyline points="1 4 1 10 7 10"></polyline>
           <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
         </svg>
       </button>`,
    ];
    if (s.status === "done" && s.session_report) {
      actionButtons.push(
        `<button class="icon-btn download-btn" data-title="${encodeURIComponent(title)}" data-report="${encodeURIComponent(s.session_report)}" title="دانلود">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>
        <button class="icon-btn copy-btn" data-report="${encodeURIComponent(s.session_report)}" title="کپی گزارش">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>`
      );
    }
    actionButtons.push(
      `<button class="icon-btn delete-btn" data-id="${s.id}" title="حذف جلسه">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <polyline points="3 6 5 6 21 6"></polyline>
           <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
         </svg>
       </button>`
    );
    card.innerHTML = `
      <div><strong>${title}</strong></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
        <div class="muted">${date}</div>
        <div style="display:flex;align-items:center;gap:6px;flex-direction:row-reverse">
          ${actionButtons.join("")}
          ${statusBadge(s.status)}
        </div>
      </div>
    `;
    if (s.status === "done" && s.session_report) {
      card.addEventListener('click', (e) => {
        if (!e.target.closest('.icon-btn')) {
          openSessionReportTab(s.id);
        }
      });
    }
    card.querySelector('.regen-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      regenerateSession(s.id);
    });
    card.querySelector('.delete-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('این جلسه حذف شود؟')) {
        const { sessions = [] } = await chrome.storage.local.get('sessions');
        const filtered = sessions.filter(session => session.id !== s.id);
        await chrome.storage.local.set({ sessions: filtered });
        await clearSessionAudioBlob(s.id);
        await refreshSessions();
      }
    });
    if (s.status === "done" && s.session_report) {
      const copyBtn = card.querySelector('.copy-btn');
      const downloadBtn = card.querySelector('.download-btn');
      
      downloadBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        // Redirect to report page with download flag to use its HTML/CSS for the PDF
        const url = `${chrome.runtime.getURL("report.html")}?sessionId=${encodeURIComponent(s.id)}&download=1`;
        chrome.tabs.create({ url });
      });
      
      copyBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const report = decodeURIComponent(copyBtn.dataset.report);
        navigator.clipboard.writeText(report).then(() => {
          copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
          setTimeout(() => {
            copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
          }, 1500);
        });
      });
      
      downloadBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        // Redirect to report page with download flag to use its HTML/CSS for the PDF
        const url = `${chrome.runtime.getURL("report.html")}?sessionId=${encodeURIComponent(s.id)}&download=1`;
        chrome.tabs.create({ url });
      });
      
      copyBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const report = decodeURIComponent(copyBtn.dataset.report);
        navigator.clipboard.writeText(report).then(() => {
          copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
          setTimeout(() => {
            copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
          }, 1500);
        });
      });
    }
    
    sessionsDiv.appendChild(card);
  }

  if (hasProcessing) {
    showAnalyzingOverlay();
  } else {
    hideAnalyzingOverlay();
  }
}

async function getSessionById(id) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  return sessions.find(s => s.id === id) || null;
}

async function patchSession(id, patch) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) return;
  const sessionCopy = { ...sessions[idx] };
  const { audio_base64, ...rest } = patch || {};

  if (audio_base64 !== undefined) {
    delete sessionCopy.audio_base64;
    if (typeof audio_base64 === "string" && audio_base64.length) {
      await persistSessionAudioBlob(id, audio_base64);
      sessionCopy.has_audio = true;
    } else if (audio_base64 === null) {
      await clearSessionAudioBlob(id);
      sessionCopy.has_audio = false;
    }
    if (sessionCopy.has_audio === undefined) {
      sessionCopy.has_audio = false;
    }
  }

  sessions[idx] = { ...sessionCopy, ...rest };
  await chrome.storage.local.set({ sessions });
}

async function regenerateSession(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session) {
    alert("جلسه موردنظر یافت نشد.");
    return;
  }

  const audioBase64 = await resolveSessionAudio(session);
  if (!audioBase64) {
    alert("فایل صوتی این جلسه در دسترس نیست و از سرور نیز یافت نشد.");
    return;
  }
  await patchSession(sessionId, { status: "processing" });
  await refreshSessions();
  try {
    const response = await chrome.runtime.sendMessage({
      action: "PROCESS_SESSION_AUDIO",
      payload: {
        sessionId,
        audioBase64,
        mimeType: session.audio_mime_type || "audio/webm",
        isRegeneration: true,
      },
    });
    if (!response?.ok) {
      throw new Error(response?.error || "بازتحلیل آغاز نشد.");
    }
  } catch (error) {
    const readable = formatBackendError(error);
    console.error("Regeneration dispatch failed", readable);
    await chrome.runtime.sendMessage({
      action: "SESSION_REPORT_READY",
      payload: {
        sessionId,
        title: session.title,
        sessionReport: `خطا در بازتحلیل جلسه: ${readable}`,
        status: "error",
        audioBase64: audioBase64 || null,
      },
    });
    alert(readable);
  } finally {
    await refreshSessions();
  }
}

recordBtn.addEventListener("click", async () => {
  if (isRecording) {
    recordBtn.disabled = true;
    await send("STOP_RECORDING");
    if (recorder) recorder.stop();
    return;
  }

  recordBtn.disabled = true;
  try {
    const res = await send("START_RECORDING");
    if (!res?.ok || !res.sessionId) {
      alert(res?.error || "شروع جلسه با خطا مواجه شد.");
      recordBtn.disabled = false;
      return;
    }
    currentSessionId = res.sessionId;
    recordingStartTime = Date.now();

    // Request microphone first
    try {
      micStreamRef = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100
        }
      });
      // console.log("Microphone captured");
    } catch (e) {
      console.warn("Microphone not available:", e);
      micStreamRef = null;
    }

    // Request screen/tab with system audio
    displayStreamRef = await navigator.mediaDevices.getDisplayMedia({ 
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100
      },
      preferCurrentTab: false,
      systemAudio: "include"
    });
    // console.log("Display captured");

    const audioCtx = new AudioContext({ sampleRate: 44100 });
    const destination = audioCtx.createMediaStreamDestination();

    let hasAudio = false;
    
    // Mix display audio (system/tab audio)
    const displayAudioTracks = displayStreamRef.getAudioTracks();
    if (displayAudioTracks.length > 0) {
      // console.log(`Display audio tracks: ${displayAudioTracks.length}`);
      // displayAudioTracks.forEach((track, i) => {
      //   console.log(`Display track ${i}: ${track.label}`);
      // });
      const displaySource = audioCtx.createMediaStreamSource(displayStreamRef);
      displaySource.connect(destination);
      hasAudio = true;
    } else {
      console.warn("No display audio tracks found");
    }
    
    // Mix microphone audio
    if (micStreamRef?.getAudioTracks().length) {
      // console.log(`Microphone tracks: ${micStreamRef.getAudioTracks().length}`);
      const micSource = audioCtx.createMediaStreamSource(micStreamRef);
      micSource.connect(destination);
      hasAudio = true;
    }

    if (!hasAudio) {
      alert("خطا: هیچ منبع صوتی در دسترس نیست. لطفاً هنگام انتخاب صفحه، گزینه 'Share audio' را فعال کنید.");
      displayStreamRef?.getTracks()?.forEach(t => t.stop());
      micStreamRef?.getTracks()?.forEach(t => t.stop());
      await send("STOP_RECORDING");
      recordBtn.disabled = false;
      await refreshSessions();
      return;
    }

    mixedStream = destination.stream;
    chunks = [];
    
    const options = { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = "audio/webm";
    }
    
    recorder = new MediaRecorder(mixedStream, options);
    // console.log("MediaRecorder created with:", options.mimeType);

    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) {
        chunks.push(e.data);
        // console.log(`Chunk ${chunks.length}: ${e.data.size} bytes`);
      }
    };

    recorder.onstop = async () => {
      // console.log(`Recording stopped. Total chunks: ${chunks.length}`);
      const durationMinutes = (Date.now() - recordingStartTime) / 60000;
      displayStreamRef?.getTracks()?.forEach(t => t.stop());
      micStreamRef?.getTracks()?.forEach(t => t.stop());

      if (chunks.length === 0) {
        alert("خطا: هیچ صدایی ضبط نشد. لطفاً دوباره تلاش کنید.");
        await chrome.runtime.sendMessage({
          action: "SESSION_REPORT_READY",
          payload: { sessionId: currentSessionId, title: "جلسه", sessionReport: "خطا: صدا ضبط نشد", status: "error", audioBase64: null }
        });
        recorder = null;
        chunks = [];
        currentSessionId = null;
        recordBtn.disabled = false;
        await refreshSessions();
        return;
      }

      const blob = new Blob(chunks, { type: "audio/webm" });
      // console.log(`Blob created: ${blob.size} bytes`);
      
      if (blob.size === 0) {
        alert("خطا: فایل صوتی خالی است.");
        await chrome.runtime.sendMessage({
          action: "SESSION_REPORT_READY",
          payload: { sessionId: currentSessionId, title: "جلسه", sessionReport: "خطا: فایل صوتی خالی", status: "error", audioBase64: null }
        });
        recorder = null;
        chunks = [];
        currentSessionId = null;
        recordBtn.disabled = false;
        await refreshSessions();
        return;
      }

      const base64 = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result.split(',')[1]);
        r.readAsDataURL(blob);
      });

      // console.log(`Base64 encoded: ${base64.length} characters`);

      try {
        const response = await chrome.runtime.sendMessage({
          action: "PROCESS_SESSION_AUDIO",
          payload: {
            sessionId: currentSessionId,
            audioBase64: base64,
            mimeType: "audio/webm",
            durationMinutes: durationMinutes,
          },
        });
        if (!response?.ok) {
          throw new Error(response?.error || "ارسال فایل برای تحلیل ناموفق بود.");
        }
      } catch (error) {
        const readable = formatBackendError(error);
        console.error("Failed to dispatch audio for analysis", readable);
        await chrome.runtime.sendMessage({
          action: "SESSION_REPORT_READY",
          payload: {
            sessionId: currentSessionId,
            title: "خطا در تحلیل",
            sessionReport: `خطا در ارسال فایل برای تحلیل: ${readable}`,
            status: "error",
            audioBase64: null,
          },
        });
        alert(readable);
      } finally {
        recorder = null;
        chunks = [];
        currentSessionId = null;
        recordBtn.disabled = false;
        await refreshSessions();
      }
    };

    recorder.start(100);
    // console.log("Recording started");
    recordBtn.disabled = false;
    await refreshSessions();

  } catch (e) {
    console.error("Recording error:", e);
    if (e.name === "NotAllowedError") {
      alert("خطا: دسترسی به صفحه یا میکروفون رد شد.");
    } else {
      alert("خطا: " + (e?.message || e));
    }
    await send("STOP_RECORDING");
    recordBtn.disabled = false;
    await refreshSessions();
  }
});

clearBtn.addEventListener("click", async () => {
  if (confirm("همه جلسات حذف شوند؟ این عملیات قابل بازگشت نیست.")) {
    const { sessions = [] } = await chrome.storage.local.get("sessions");
    await Promise.all((sessions || []).map(session => clearSessionAudioBlob(session.id)));
    await chrome.storage.local.set({ sessions: [] });
    await refreshSessions();
  }
});

initRealtimeSessionSync();
refreshSessions();

function scheduleAnalyzingOverlayTimeout() {
  if (analyzingOverlayTimeoutId) return;
  analyzingOverlayTimeoutId = setTimeout(() => {
    analyzingOverlayTimeoutId = null;
    analyzingOverlayTimedOut = true;
    hideAnalyzingOverlay({ resetTimeoutState: false });
  }, ANALYZING_OVERLAY_TIMEOUT_MS);
}

function resetAnalyzingOverlayTimeoutState() {
  if (analyzingOverlayTimeoutId) {
    clearTimeout(analyzingOverlayTimeoutId);
    analyzingOverlayTimeoutId = null;
  }
  analyzingOverlayTimedOut = false;
}

function showAnalyzingOverlay() {
  if (analyzingOverlayTimedOut) return;
  if (!document.getElementById('analyzingOverlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'analyzingOverlay';
    overlay.className = 'analyzing-overlay';
    overlay.innerHTML = `
      <div class="analyzing-content">
        <div class="ai-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
        </div>
        <div class="analyzing-text">تحلیل جلسه با هوش مصنوعی</div>
        <div class="analyzing-subtext">
          <div class="dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
          لطفاً صبر کنید
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  scheduleAnalyzingOverlayTimeout();
}

function hideAnalyzingOverlay({ resetTimeoutState = true } = {}) {
  if (resetTimeoutState) {
    resetAnalyzingOverlayTimeoutState();
  }
  const overlay = document.getElementById('analyzingOverlay');
  if (overlay) {
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.remove(), 300);
  }
}
