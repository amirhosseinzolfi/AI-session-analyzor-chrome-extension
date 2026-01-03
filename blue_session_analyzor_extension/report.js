const STATUS_TEXT = {
  processing: "⏳ در حال پردازش",
  done: "✅ تکمیل شده",
  failed: "❌ خطا در تحلیل",
};

const statusChip = document.getElementById("statusChip");
const titleEl = document.getElementById("reportTitle");
const createdAtEl = document.getElementById("createdAt");
const userNameEl = document.getElementById("userName");
const loaderEl = document.getElementById("loader");
const contentEl = document.getElementById("reportContent");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");
const regenBtn = document.getElementById("regenBtn");
const toastEl = document.getElementById("toast");

const params = new URLSearchParams(window.location.search || window.location.hash.replace(/^#/, ""));
const sessionId = params.get("sessionId");
let currentSession = null;
let regenInFlight = false;

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Enhanced Markdown renderer for beautiful report formatting
 */
function renderMarkdown(md = "") {
  let html = escapeHtml(md);
  
  // Code blocks (```code```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang ? `<span class="code-lang">${lang}</span>` : '';
    return `<pre class="code-block">${langLabel}<code>${code.trim()}</code></pre>`;
  });
  
  // Inline code (`code`)
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  
  // Headers with icons
  html = html.replace(/^#### (.*)$/gim, '<h4>$1</h4>');
  html = html.replace(/^### (.*)$/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gim, '<h1>$1</h1>');
  
  // Bold text
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // Italic text
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // Blockquotes (> text)
  html = html.replace(/^&gt; (.*)$/gim, '<blockquote><p>$1</p></blockquote>');
  
  // Horizontal rules
  html = html.replace(/^(-{3,}|_{3,}|\*{3,})$/gim, '<hr>');
  
  // Numbered lists
  html = html.replace(/^(\d+)\. (.*)$/gim, '<li class="numbered" data-num="$1">$2</li>');
  
  // Bullet lists with different markers
  html = html.replace(/^[-•●] (.*)$/gim, '<li>$1</li>');
  
  // Wrap consecutive list items in ul/ol tags
  html = html.replace(/(<li class="numbered"[^>]*>[\s\S]*?<\/li>\n?)+/g, '<ol class="styled-list">$&</ol>');
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (match) => {
    if (!match.includes('class="numbered"')) {
      return `<ul class="styled-list">${match}</ul>`;
    }
    return match;
  });
  
  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  
  // Paragraphs - split by double newlines
  const blocks = html.split(/\n\n+/);
  html = blocks.map(block => {
    block = block.trim();
    if (!block) return '';
    // Don't wrap if already has block-level element
    if (/^<(h[1-6]|ul|ol|li|pre|blockquote|hr|div|table|p)/i.test(block)) {
      return block;
    }
    // Convert single newlines to <br> within paragraphs
    block = block.replace(/\n/g, '<br>');
    return `<p>${block}</p>`;
  }).join('\n');
  
  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  
  // Fix nested lists (remove extra ul/ol if inside another)
  html = html.replace(/<\/ul>\s*<ul[^>]*>/g, '');
  html = html.replace(/<\/ol>\s*<ol[^>]*>/g, '');
  
  return html;
}

function updateStatusChip(status = "processing") {
  statusChip.classList.remove("processing", "done", "failed");
  statusChip.classList.add(status);
  
  // Update the inner HTML to include the animated dot
  const statusText = STATUS_TEXT[status] || status;
  statusChip.innerHTML = `<span class="status-dot"></span>${statusText}`;
}

function showToast(message) {
  // Update toast content with icon
  toastEl.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
    </svg>
    <span>${message}</span>
  `;
  toastEl.classList.remove("hidden");
  toastEl.classList.add("visible");
  setTimeout(() => {
    toastEl.classList.remove("visible");
    setTimeout(() => toastEl.classList.add("hidden"), 300);
  }, 2500);
}

function toggleLoader(show) {
  loaderEl.classList.toggle("hidden", !show);
  contentEl.classList.toggle("hidden", show);
}

async function loadSession(sessionId) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  return sessions.find((s) => s.id === sessionId);
}

function renderSession(session) {
  currentSession = session;
  titleEl.textContent = session.title || "گزارش جلسه";
  userNameEl.textContent = session.user_name ? session.user_name : "کاربر نامشخص";
  createdAtEl.textContent = session.created_at
    ? new Date(session.created_at).toLocaleString("fa-IR", {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : "زمان نامشخص";

  updateStatusChip(session.status || "processing");

  if (!session.session_report) {
    toggleLoader(true);
    return;
  }

  toggleLoader(false);
  
  // Render markdown with enhanced formatting
  const renderedContent = renderMarkdown(session.session_report);
  contentEl.innerHTML = renderedContent;
  
  // Add animation to content sections
  setTimeout(() => {
    const sections = contentEl.querySelectorAll('h2, h3');
    sections.forEach((section, index) => {
      section.style.animationDelay = `${index * 0.1}s`;
    });
  }, 100);
}

async function hydrate() {
  if (!sessionId) {
    loaderEl.innerHTML = `
      <div class="error-message">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <strong>شناسه جلسه ارسال نشده است</strong>
        <p>لطفاً از طریق لیست جلسات وارد شوید.</p>
      </div>
    `;
    return;
  }
  const session = await loadSession(sessionId);
  if (!session) {
    loaderEl.innerHTML = `
      <div class="error-message">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <strong>جلسه‌ای یافت نشد</strong>
        <p>جلسه‌ای با این شناسه در سیستم موجود نیست.</p>
      </div>
    `;
    return;
  }
  renderSession(session);

  // Auto-trigger PDF download if requested via URL parameter
  if (params.get("download") === "1" && session.session_report) {
    setTimeout(() => downloadBtn.click(), 800);
  }
}

copyBtn.addEventListener("click", async () => {
  if (!currentSession?.session_report) {
    showToast("گزارش هنوز آماده نیست.");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentSession.session_report);
    showToast("کپی شد ✅");
  } catch (error) {
    console.error("Copy failed", error);
    showToast("کپی ناموفق بود");
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!currentSession?.session_report) {
    showToast("گزارش هنوز آماده نیست ⏳");
    return;
  }
  
  const title = currentSession.title || "Session Report";
  const container = document.querySelector(".report-container") || document.body;
  
  // Update button state
  downloadBtn.disabled = true;
  const originalHTML = downloadBtn.innerHTML;
  downloadBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" class="animate-spin">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
    در حال تولید...
  `;
  
  try {
    showToast("در حال آماده‌سازی PDF... 📄");
    // Ensure the utility function exists before calling
    if (typeof generateSessionPdf !== 'function') {
      throw new Error("PDF Utility (pdf_utils.js) not loaded.");
    }
    await generateSessionPdf(container, `${title}.pdf`);
    showToast("PDF با موفقیت دانلود شد ✅");
  } catch (error) {
    console.error("PDF generation failed", error);
    showToast("خطا در تولید PDF ❌");
    
    // Fallback to Markdown download
    setTimeout(() => {
      showToast("در حال دانلود نسخه متنی...");
      const blob = new Blob([`# ${title}\n\n${currentSession.session_report}`], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title}.md`;
      a.click();
      URL.revokeObjectURL(url);
    }, 1500);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = originalHTML;
  }
});

regenBtn.addEventListener("click", async () => {
  if (!sessionId || regenInFlight) return;
  regenInFlight = true;
  regenBtn.disabled = true;
  const originalHTML = regenBtn.innerHTML;
  regenBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" class="animate-spin">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
    در حال ارسال...
  `;
  try {
    const response = await chrome.runtime.sendMessage({
      action: "PROCESS_SESSION_AUDIO",
      payload: { sessionId, isRegeneration: true },
    });
    if (!response?.ok) {
      throw new Error(response?.error || "بازتحلیل آغاز نشد");
    }
    showToast("بازتحلیل آغاز شد ✨");
  } catch (error) {
    console.error("Regeneration failed", error);
    showToast(error?.message || "بازتحلیل ناموفق بود ❌");
  } finally {
    regenInFlight = false;
    regenBtn.disabled = false;
    regenBtn.innerHTML = originalHTML;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.sessions) return;
  if (!sessionId) return;
  hydrate();
});

hydrate();
