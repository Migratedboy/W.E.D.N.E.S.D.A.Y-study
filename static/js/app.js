/* ============================================
   W.E.D.N.E.S.D.A.Y STUDY — Inline JS
   ============================================ */

let currentSubject = 'General';
let sessions = [];
let currentSessionId = null;
let micOn = false;
let recognition = null;
let timerInt = null;
let timerSecs = 0;
let busy = false;

let progressData = { globalStreak: 0, lastStudyDate: null, subjects: {} };
let currentUser = { email: '', username: '', avatar: null };

let reviewCards = [];
let reviewIndex = 0;

let quizQuestions = [];
let quizIndex = 0;
let quizScore = 0;
let quizSelectedIndex = null;
let quizLocked = false;
let quizBusy = false;
let quizAttemptId = null;   // server-side answer key for the current quiz
let quizAnswers = [];        // index of the option chosen per question

const $ = (id) => document.getElementById(id);
const notesEl = $('notes');
const chatInput = $('chatInput');
const chatMsgs = $('chatMsgs');
const responseEl = $('response');
const welcomeEl = $('welcome');
const learningResourcesEl = $('learningResources');
const lrNotifyEl = $('lrNotify');
const lrSheetBackdropEl = $('lrSheetBackdrop');
const lrSheetEl = $('lrSheet');
const lrSheetContentEl = $('lrSheetContent');
const lrSheetCloseBtn = $('lrSheetClose');
const subjLbl = $('subjLbl');
const aiStatus = $('aiStatus');
const timerEl = $('timer');
const timerDisplay = $('timerDisplay');

const originalFetch = window.fetch.bind(window);
window.fetch = function(input, init = {}) {
  const isApi = typeof input === 'string' && input.startsWith('/api/');
  if (isApi) {
    const updatedInit = { credentials: 'same-origin', ...init };
    if (window.DeveloperSettings && typeof window.DeveloperSettings.isPremium === 'function' && window.DeveloperSettings.isPremium()) {
      const headers = new Headers(updatedInit.headers || {});
      headers.set('x-dev-premium', '1');
      updatedInit.headers = headers;
    }
    return originalFetch(input, updatedInit);
  }
  return originalFetch(input, init);
};

(async function init() {
  await checkHealth();
  await fetchMe();
  await fetchProgress();
  await loadSessionsFromServer();
  loadNotes(currentSubject);
  if (sessions.length === 0) await startNewSession();
  else await activateSession(sessions[0].id);
  bindEvents();
})();

async function checkHealth() {
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (d.aiConfigured) {
      aiStatus.textContent = '● AI ONLINE';
      aiStatus.className = 'ok';
      aiStatus.title = 'Endpoint: ' + d.baseUrl + ' | Model: ' + (d.models?.[0] || '?');
    } else {
      aiStatus.textContent = '● NO API KEY';
      aiStatus.className = 'err';
      aiStatus.title = 'Add AI_API_KEY to .env and restart the server';
    }
  } catch (e) {
    aiStatus.textContent = '● OFFLINE';
    aiStatus.className = 'err';
    aiStatus.title = 'Server not reachable. Is study-server.mjs running?';
    console.error('Health check failed:', e);
  }
}

function bindEvents() {
  document.querySelectorAll('.subj').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSubject = btn.dataset.subj;
      subjLbl.textContent = currentSubject;
      document.querySelectorAll('.subj').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadNotes(currentSubject);
    });
  });

  $('saveNotes').addEventListener('click', () => {
    localStorage.setItem('snotes_' + currentSubject, notesEl.value);
    flashInChat('ai', '✅ Notes saved for <strong>' + currentSubject + '</strong>');
  });
  $('clearNotes').addEventListener('click', () => {
    if (confirm('Clear notes for ' + currentSubject + '?')) {
      notesEl.value = '';
      localStorage.removeItem('snotes_' + currentSubject);
    }
  });

  $('sendBtn').addEventListener('click', () => {
    const v = chatInput.value;
    if (v.trim()) { chatInput.value = ''; sendMessage(v); }
  });
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const v = chatInput.value;
      if (v.trim()) { chatInput.value = ''; sendMessage(v); }
    }
  });

  document.querySelectorAll('.qbtn, .welcome-card').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.qbtn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      quickStudy(b.dataset.action);
    });
  });

  $('micBtn').addEventListener('click', toggleMic);

  $('timerBtn').addEventListener('click', () => timerEl.classList.toggle('show'));
  document.querySelectorAll('.timer-btns button[data-mins]').forEach(b => {
    b.addEventListener('click', () => startTimer(parseInt(b.dataset.mins)));
  });
  $('timerStop').addEventListener('click', stopTimer);

  $('recentBtn').addEventListener('click', openRecent);
  $('recentClose').addEventListener('click', closeRecent);
  $('recentOverlay').addEventListener('click', closeRecent);
  $('newChatBtn').addEventListener('click', startNewSession);

  $('progressBtn').addEventListener('click', openProgress);
  $('progressClose').addEventListener('click', closeProgress);
  $('progressOverlay').addEventListener('click', closeProgress);

  $('leaderboardBtn').addEventListener('click', openLeaderboard);
  $('leaderboardClose').addEventListener('click', closeLeaderboard);
  $('leaderboardOverlay').addEventListener('click', closeLeaderboard);

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsOverlay').addEventListener('click', closeSettings);
  $('changeAvatarBtn').addEventListener('click', () => $('avatarFileInput').click());
  $('avatarFileInput').addEventListener('change', handleAvatarFile);
  $('changeUsernameBtn').addEventListener('click', openUsernameEdit);
  $('cancelUsernameBtn').addEventListener('click', closeUsernameEdit);
  $('saveUsernameBtn').addEventListener('click', saveUsername);
  $('newUsernameInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveUsername(); });
  $('logoutBtn').addEventListener('click', logout);

  $('fc-reveal').addEventListener('click', () => {
    $('fc-front').style.display = 'none';
    $('fc-back').style.display = 'flex';
  });
  document.querySelectorAll('.fc-rate-btn').forEach(btn => {
    btn.addEventListener('click', () => rateFlashcard(parseInt(btn.dataset.quality)));
  });
  $('fc-close').addEventListener('click', hideFlashcardOverlay);

  $('quiz-close').addEventListener('click', closeQuiz);
  $('quiz-submit').addEventListener('click', submitQuizAnswer);
  $('quiz-next').addEventListener('click', nextQuizQuestion);
  $('quiz-retry').addEventListener('click', () => startQuiz());
  $('quiz-done').addEventListener('click', closeQuiz);
  $('quiz-overlay').addEventListener('click', e => { if (e.target.id === 'quiz-overlay') closeQuiz(); });
}

function loadNotes(subject) { notesEl.value = localStorage.getItem('snotes_' + subject) || ''; }

async function loadSessionsFromServer() {
  try {
    const r = await fetch('/api/sessions');
    const j = await r.json();
    sessions = (j.sessions || []).map(s => ({
      id: s.id, subject: s.subject, title: s.title, updatedAt: s.updatedAt,
      messages: [], messagesLoaded: false
    }));
  } catch (e) {
    console.error('Failed to load chat sessions:', e);
    sessions = [];
  }
}

function hydrateMessages(rawMsgs) {
  return (rawMsgs || []).map(m => {
    const content = m.content || '';
    if (m.role === 'assistant') {
      const cleaned = content.replace(/<\s*\/?\s*br\s*>/gi, '\n');
      return { role: 'assistant', content, html: renderMarkdown(cleanLatex(cleaned)) };
    }
    return { role: 'user', content, html: escapeHtml(content) };
  });
}

function getSession() { return sessions.find(s => s.id === currentSessionId); }

async function startNewSession() {
  try {
    const r = await fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: currentSubject })
    });
    if (!r.ok) throw new Error('Request failed: ' + r.status);
    const j = await r.json();
    const s = { id: j.session.id, title: j.session.title, subject: j.session.subject, messages: [], messagesLoaded: true, updatedAt: j.session.updatedAt };
    sessions.unshift(s);
    currentSessionId = s.id;
    renderSession();
    closeRecent();
    renderRecentList();
  } catch (e) {
    console.error('Failed to start a new chat:', e);
    showMsgMaybeToast('Could not start a new chat. Check your connection and try again.');
  }
}

async function activateSession(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  currentSessionId = id;
  currentSubject = s.subject || 'General';
  subjLbl.textContent = currentSubject;
  document.querySelectorAll('.subj').forEach(b => b.classList.toggle('active', b.dataset.subj === currentSubject));
  loadNotes(currentSubject);

  if (!s.messagesLoaded) {
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(id) + '/messages');
      const j = await r.json();
      s.messages = hydrateMessages(j.messages);
    } catch (e) {
      console.error('Failed to load chat messages:', e);
      s.messages = s.messages || [];
    }
    s.messagesLoaded = true;
  }

  renderSession();
  closeRecent();
}

async function deleteSession(id) {
  try {
    await fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch (e) {
    console.error('Failed to delete chat on server:', e);
  }
  sessions = sessions.filter(s => s.id !== id);
  if (id === currentSessionId) {
    if (sessions.length) await activateSession(sessions[0].id);
    else await startNewSession();
  }
  renderRecentList();
}

function showMsgMaybeToast(text) {
  flashInChat && flashInChat('ai', '⚠️ ' + escapeHtml(text));
}

function renderSession() {
  const s = getSession();
  chatMsgs.innerHTML = '';
  if (!s || s.messages.length === 0) {
    welcomeEl.style.display = '';
    responseEl.style.display = 'none';
    responseEl.textContent = '';
    addMsg('ai', '👋 Ask me anything! I can explain, quiz you, summarize your notes, or give formulas.');
    return;
  }
  s.messages.forEach(m => addMsg(m.role === 'user' ? 'user' : 'ai', m.html || escapeHtml(m.content)));
  const lastUser = [...s.messages].reverse().find(m => m.role === 'user');
  const lastAi = [...s.messages].reverse().find(m => m.role === 'assistant');
  welcomeEl.style.display = 'none';
  responseEl.style.display = 'block';
  responseEl.textContent = '';

  const title = document.createElement('h3');
  title.textContent = '📖 ' + escapeHtml(lastUser?.content || '');
  const body = document.createElement('div');
  body.className = 'body';
  if (lastAi?.html) body.innerHTML = lastAi.html;

  responseEl.appendChild(title);
  responseEl.appendChild(body);
}

function calcLoaderHTML(label, size) {
  const cls = 'calc-loader' + (size === 'sm' ? ' small' : '');
  return '<div class="' + cls + '">' +
    '<div class="calc-ring"><div class="calc-core"></div></div>' +
    '<div class="calc-label">' + escapeHtml(String(label || 'Calculating').toUpperCase()) +
    '<span class="calc-dots"><span>.</span><span>.</span><span>.</span></span></div>' +
    '</div>';
}

const THINKING_STATUS_MESSAGES = [
  'Generating your explanation...',
  'Thinking deeply...',
  'Analyzing your question...',
  'Building the best explanation...',
  'Connecting concepts...',
  'Almost ready...'
];

function createThinkingBubble() {
  const bubble = document.createElement('div');
  bubble.className = 'smsg ai thinking-bubble';
  bubble.innerHTML = `
    <div class="thinking-card">
      <div class="thinking-title">✨ Wednesday AI</div>
      <div class="thinking-animation-wrapper">
        <div class="thinking-animation"
             data-us-project="MXVvaxQDd4o1qu3kMRSk"
             data-us-fixed="true"
             data-us-dpi="1.2"
             data-us-scale="1"
             style="width:100%;height:100%;min-height:250px;min-width:100%;">
        </div>
      </div>
      <div class="thinking-status-row">
        <div class="status-text">${escapeHtml(THINKING_STATUS_MESSAGES[0])}</div>
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>
      <div class="assistant-markdown"></div>
    </div>
  `;
  return bubble;
}

function startThinkingStatusRotation(bubble) {
  stopThinkingStatusRotation(bubble);
  const statusEl = bubble.querySelector('.status-text');
  if (!statusEl) return;
  let idx = 0;
  statusEl.textContent = THINKING_STATUS_MESSAGES[idx];
  bubble.__thinkingStatusInterval = setInterval(() => {
    idx = (idx + 1) % THINKING_STATUS_MESSAGES.length;
    statusEl.classList.add('status-hidden');
    setTimeout(() => {
      statusEl.textContent = THINKING_STATUS_MESSAGES[idx];
      statusEl.classList.remove('status-hidden');
    }, 220);
  }, 2500);
}

function stopThinkingStatusRotation(bubble) {
  if (bubble && bubble.__thinkingStatusInterval) {
    clearInterval(bubble.__thinkingStatusInterval);
    bubble.__thinkingStatusInterval = null;
  }
}

function ensureUnicornStudioReady() {
  if (window.__USLoadingPromise) return window.__USLoadingPromise;
  if (window.UnicornStudio && typeof window.UnicornStudio.init === 'function') {
    return Promise.resolve(window.UnicornStudio);
  }

  window.__USLoadingPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-us-loader]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.UnicornStudio));
      existing.addEventListener('error', () => reject(new Error('Unicorn Studio script failed to load')));
      return;
    }

    const script = document.createElement('script');
    script.dataset.usLoader = '1';
    script.src = 'https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@v2.2.6/dist/unicornStudio.umd.js';
    script.async = true;
    script.onload = () => resolve(window.UnicornStudio);
    script.onerror = () => reject(new Error('Unicorn Studio script failed to load'));
    (document.head || document.body).appendChild(script);
  });
  return window.__USLoadingPromise;
}

function initUnicornStudio() {
  const u = window.UnicornStudio;
  if (u && typeof u.init === 'function') {
    try { u.init(); } catch (err) { console.warn('[UnicornStudio] init failed:', err); }
  }
}

function morphThinkingBubbleIntoResponse(bubble, html) {
  if (!bubble) return;
  const wrapper = bubble.querySelector('.thinking-animation-wrapper');
  const row = bubble.querySelector('.thinking-status-row');
  const markdownEl = bubble.querySelector('.assistant-markdown');
  if (wrapper) wrapper.classList.add('hidden');
  if (row) row.classList.add('status-hidden');
  if (markdownEl) {
    markdownEl.innerHTML = html;
    markdownEl.classList.add('visible');
  }
  stopThinkingStatusRotation(bubble);
}

function addMsg(role, html) {
  const d = document.createElement('div');
  d.className = 'smsg ' + role;
  d.innerHTML = html;
  chatMsgs.appendChild(d);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  return d;
}
function flashInChat(role, html) {
  const d = addMsg(role, html);
  setTimeout(() => d.remove(), 3500);
}

async function sendMessage(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;

  let s = getSession();
  if (!s) { await startNewSession(); s = getSession(); }

  addMsg('user', escapeHtml(text));
  s.messages.push({ role: 'user', content: text, html: escapeHtml(text) });
  if (s.messages.length === 1) {
    s.title = text.length > 42 ? text.slice(0, 42) + '…' : text;
  }
  s.updatedAt = Date.now();

  const isPremium = !!(window.DeveloperSettings && typeof window.DeveloperSettings.isPremium === 'function' && window.DeveloperSettings.isPremium());

  const thinking = createThinkingBubble();
  chatMsgs.appendChild(thinking);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  startThinkingStatusRotation(thinking);
  ensureUnicornStudioReady()
    .then(() => { window.requestAnimationFrame(() => initUnicornStudio()); })
    .catch(err => console.warn('[UnicornStudio] load failed:', err));

  welcomeEl.style.display = 'none';
  responseEl.style.display = 'block';
  responseEl.innerHTML = '<h3>📖 ' + escapeHtml(text) + '</h3><div class="body"><em style="color:rgba(255,255,255,0.4)">Thinking…<span class="stcursor"></span></em></div>';
  clearLearningResources();

  const history = s.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
  const sysp = 'You are an expert tutor. Subject: ' + currentSubject +
               '. Give clear, structured answers with examples, bullet points, and headers. Use markdown formatting.' +
               (notesEl.value.trim() ? ' Student notes: ' + notesEl.value.trim().slice(0, 600) : '');

  if (isPremium) {
    try {
      const showProgress = (msg) => {
        const statusEl = thinking.querySelector('.status-text');
        if (statusEl) statusEl.textContent = msg;
        responseEl.innerHTML = '<h3>📖 ' + escapeHtml(text) + '</h3><div class="body">' + calcLoaderHTML(msg, 'lg') + '</div>';
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
      };
      const raw = await premiumLoop(text, sysp, showProgress);
      const cleaned = String(raw).replace(/<\s*\/?\s*br\s*>/gi, '\n');
      const html = renderMarkdown(cleanLatex(cleaned));
      morphThinkingBubbleIntoResponse(thinking, html);
      responseEl.innerHTML = '<h3>📖 ' + escapeHtml(text) + '</h3><div class="body">' + html + '</div>';
      s.messages.push({ role: 'assistant', content: cleaned, html });
      s.updatedAt = Date.now();
      renderRecentList();
      trackProgress(currentSubject, text.substring(0, 50));
      extractAndSaveFlashcards(cleaned, currentSubject);
      try {
        renderLearningResourcesLoading();
        const topic = determineTopic(text, currentSubject);
        const resources = await fetchLearningResources(topic);
        presentLearningResources(resources);
      } catch (resErr) {
        console.error('[LearningResources] failed - explanation above is unaffected:', resErr);
        renderLearningResourcesError(resErr.message);
      }
    } catch (e) {
      const errHtml = '❌ <strong>AI Error:</strong> ' + escapeHtml(e.message);
      morphThinkingBubbleIntoResponse(thinking, errHtml);
      responseEl.innerHTML = '<h3>📖 ' + escapeHtml(text) + '</h3><div class="body">' + errHtml + '</div>';
    }
    busy = false;
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
    return;
  }

  try {
    const r = await fetch('/api/study', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, subject: currentSubject, systemPrompt: sysp, history, stream: true, sessionId: currentSessionId })
    });

    let data;
    const ctype = r.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream') && r.body) {
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', full = '', streamError = null, lastRender = 0, streamStarted = false;

      const renderPartial = () => {
        const partial = full.replace(/<\s*\/?\s*br\s*>/gi, '\n');
        const partialHtml = renderMarkdown(cleanLatex(partial)) + '<span class="stcursor"></span>';
        if (!streamStarted) {
          streamStarted = true;
          morphThinkingBubbleIntoResponse(thinking, partialHtml);
        } else {
          const markdownEl = thinking.querySelector('.assistant-markdown');
          if (markdownEl) markdownEl.innerHTML = partialHtml;
        }
        responseEl.innerHTML = '<h3>📖 ' + escapeHtml(text) + '</h3><div class="body">' + partialHtml + '</div>';
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          try {
            const evt = JSON.parse(t.slice(5).trim());
            if (evt.delta) full += evt.delta;
            if (evt.error) streamError = evt.error;
          } catch { /* ignore malformed lines */ }
        }
        const now = Date.now();
        if (full && now - lastRender > 80) { renderPartial(); lastRender = now; }
      }
      data = (streamError && !full) ? { error: streamError } : { reply: full };
    } else {
      data = await r.json().catch(() => ({}));
    }

    if (data.error) {
      const errHtml = '❌ <strong>AI Error:</strong> ' + escapeHtml(data.error);
      morphThinkingBubbleIntoResponse(thinking, errHtml);
      responseEl.innerHTML = '<h3>📖 ' + escapeHtml(text) + '</h3><div class="body">' + errHtml + '</div>';
    } else {
      const cleaned = (data.reply || '').replace(/<\s*\/?\s*br\s*>/gi, '\n');
      const html = renderMarkdown(cleanLatex(cleaned));
      morphThinkingBubbleIntoResponse(thinking, html);
      responseEl.innerHTML = '<h3>📖 ' + escapeHtml(text) + '</h3><div class="body">' + html + '</div>';
      s.messages.push({ role: 'assistant', content: cleaned, html });
      s.updatedAt = Date.now();
      renderRecentList();
      trackProgress(currentSubject, text.substring(0, 50));
      extractAndSaveFlashcards(cleaned, currentSubject);
    }
  } catch (e) {
    const errHtml = '❌ <strong>Connection error:</strong> ' + escapeHtml(e.message) + '<br><small>Is the server running on port 4174?</small>';
    morphThinkingBubbleIntoResponse(thinking, errHtml);
    responseEl.innerHTML = '<h3>📖 ' + escapeHtml(text) + '</h3><div class="body">' + errHtml + '</div>';
  }
  busy = false;
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
}

function determineTopic(userMessage, subject) {
  const cleaned = String(userMessage || '').replace(/\s+/g, ' ').trim();
  const short = cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
  return short ? (subject + ': ' + short) : subject;
}

const LR_MOBILE_QUERY = window.matchMedia('(max-width: 700px)');
function isLearningResourcesMobile() { return LR_MOBILE_QUERY.matches; }

let lrCurrentData = null;
let lrCurrentId = null;
const lrDismissed = new Set();
let lrSheetRenderedFor = null;

function clearLearningResources() {
  learningResourcesEl.classList.remove('show');
  learningResourcesEl.innerHTML = '';
  lrCurrentData = null;
  lrCurrentId = null;
  lrSheetRenderedFor = null;
  hideLearningResourcesNotify();
  closeLearningResourcesSheet(true);
}

async function fetchLearningResources(topic) {
  const r = await fetch('/api/learning-resources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || 'Could not load learning resources.');
  return data;
}

function renderLearningResourcesLoading() {
  if (isLearningResourcesMobile()) return;
  learningResourcesEl.innerHTML =
    '<div class="lr-header"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3Z"/></svg> AI LEARNING RESOURCES</div>' +
    '<div class="lr-loading"><span class="stcursor"></span> Searching YouTube for the best explanations…</div>';
  learningResourcesEl.classList.add('show');
}

function renderLearningResourcesError(message) {
  if (isLearningResourcesMobile()) return;
  learningResourcesEl.innerHTML =
    '<div class="lr-header">🎥 AI LEARNING RESOURCES</div>' +
    '<div class="lr-error">Couldn\'t load video recommendations: ' + escapeHtml(message) + '</div>';
  learningResourcesEl.classList.add('show');
}

const LR_PLACEHOLDER_SVG =
  '<div class="lr-thumb-fallback" aria-hidden="true">' +
    '<svg viewBox="0 0 48 48" width="30" height="30" fill="none">' +
      '<circle cx="24" cy="24" r="21" fill="rgba(255,255,255,0.14)" stroke="currentColor" stroke-width="1.5"/>' +
      '<path d="M19 15l15 9-15 9V15z" fill="currentColor"/>' +
    '</svg>' +
  '</div>';

function youtubeThumbFallback(img) {
  const chain = (img.getAttribute('data-thumbs') || '').split('|').filter(Boolean);
  const nextIdx = parseInt(img.getAttribute('data-idx') || '0', 10) + 1;
  if (nextIdx < chain.length) {
    img.setAttribute('data-idx', String(nextIdx));
    img.src = chain[nextIdx];
    return;
  }
  const wrap = img.parentElement;
  if (wrap) {
    img.remove();
    wrap.classList.add('lr-thumb-placeholder');
    wrap.insertAdjacentHTML('afterbegin', LR_PLACEHOLDER_SVG);
  }
}

function renderThumbHtml(video, thumbClass) {
  const chain = (Array.isArray(video.thumbnails) && video.thumbnails.length)
    ? video.thumbnails
    : [video.thumbnail].filter(Boolean);
  const durHtml = video.duration ? '<span class="lr-dur">' + escapeHtml(video.duration) + '</span>' : '';
  const idAttr = video.videoId ? ' data-video-id="' + escapeHtml(video.videoId) + '"' : '';
  if (!chain.length) {
    return '<div class="' + thumbClass + ' lr-thumb-placeholder"' + idAttr + '>' + LR_PLACEHOLDER_SVG + durHtml + '</div>';
  }
  return '<div class="' + thumbClass + '"' + idAttr + '>' +
    '<img src="' + escapeHtml(chain[0]) + '" alt="" loading="lazy" ' +
      'data-thumbs="' + chain.map(escapeHtml).join('|') + '" data-idx="0" ' +
      '>'+
    durHtml +
  '</div>';
}

function buildLearningResourcesHtml(data, opts) {
  opts = opts || {};
  const header = opts.showHeader === false ? '' : '<div class="lr-header"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3Z"/></svg> AI LEARNING RESOURCES</div>';
  const best = data.best;
  if (!best) {
    return header + '<div class="lr-error">No matching videos found for this topic.</div>';
  }

  const altsHtml = (data.alternatives || []).map(v => (
    '<a class="lr-alt" href="' + v.url + '" target="_blank" rel="noopener noreferrer">' +
      renderThumbHtml(v, 'lr-alt-thumb') +
      '<div class="lr-alt-info">' +
        '<div class="lr-alt-title">' + escapeHtml(v.title) + '</div>' +
        '<div class="lr-alt-channel">' + escapeHtml(v.channel) + '</div>' +
      '</div>' +
    '</a>'
  )).join('');

  return header +
    '<div class="lr-best">' +
      renderThumbHtml(best, 'lr-best-thumb') +
      '<div class="lr-best-info">' +
        '<span class="lr-best-tag"><svg class="ico lr-tag-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3Z"/></svg> BEST VIDEO</span>' +
        '<div class="lr-best-title">' + escapeHtml(best.title) + '</div>' +
        '<div class="lr-best-channel">' + escapeHtml(best.channel) + '</div>' +
        (best.why ? '<div class="lr-best-why"><b>Why AI recommends it:</b> ' + escapeHtml(best.why) + '</div>' : '') +
        '<a class="lr-watch-btn" href="' + best.url + '" target="_blank" rel="noopener noreferrer"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l12 8-12 8Z"/></svg> WATCH</a>' +
      '</div>' +
    '</div>' +
    (altsHtml ? '<div class="lr-alts"><div class="lr-alts-label">MORE VIDEOS ON THIS TOPIC</div><div class="lr-alt-list">' + altsHtml + '</div></div>' : '');
}

function renderLearningResources(data, targetEl, opts) {
  targetEl = targetEl || learningResourcesEl;
  targetEl.innerHTML = buildLearningResourcesHtml(data, opts);
  if (targetEl === learningResourcesEl) targetEl.classList.add('show');
}

// Thumbnails are injected as markup, so per-image error handlers would need a
// script attribute (which the CSP forbids). One delegated listener on the
// document handles every present and future thumbnail instead.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.hasAttribute('data-thumbs')) youtubeThumbFallback(img);
}, true);

function presentLearningResources(data) {
  lrCurrentData = data;
  lrCurrentId = 'lr_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  lrSheetRenderedFor = null;

  if (!isLearningResourcesMobile()) {
    renderLearningResources(data, learningResourcesEl);
    return;
  }
  if (lrDismissed.has(lrCurrentId)) return;
  showLearningResourcesNotify(data);
}

function showLearningResourcesNotify(data) {
  const hasVideo = !!data.best;
  lrNotifyEl.innerHTML =
    '<span class="lr-notify-icon" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3Z"/></svg></span>' +
    '<div class="lr-notify-body">' +
      '<div class="lr-notify-title">' + (hasVideo ? 'Need the best YouTube video for this topic?' : 'No matching videos found') + '</div>' +
      '<div class="lr-notify-sub">' + (hasVideo ? 'Watch the highest-rated educational video chosen by AI.' : 'Try rephrasing your question for better matches.') + '</div>' +
    '</div>' +
    '<div class="lr-notify-actions">' +
      (hasVideo ? '<button type="button" class="lr-notify-view" id="lrNotifyView">View</button>' : '') +
      '<button type="button" class="lr-notify-dismiss" id="lrNotifyDismiss" aria-label="Dismiss recommendation"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>' +
    '</div>';
  lrNotifyEl.style.display = '';
  lrNotifyEl.classList.add('show');
  const viewBtn = document.getElementById('lrNotifyView');
  if (viewBtn) viewBtn.addEventListener('click', openLearningResourcesSheet);
  document.getElementById('lrNotifyDismiss').addEventListener('click', () => {
    if (lrCurrentId) lrDismissed.add(lrCurrentId);
    hideLearningResourcesNotify();
  });
}

function hideLearningResourcesNotify() {
  lrNotifyEl.classList.remove('show');
  lrNotifyEl.innerHTML = '';
  lrNotifyEl.style.display = 'none';
}

let lrSheetLastFocus = null;
function openLearningResourcesSheet() {
  if (!lrCurrentData) return;
  if (lrSheetRenderedFor !== lrCurrentId) {
    renderLearningResources(lrCurrentData, lrSheetContentEl, { showHeader: false });
    lrSheetRenderedFor = lrCurrentId;
  }
  lrSheetLastFocus = document.activeElement;
  lrSheetBackdropEl.classList.add('show');
  lrSheetEl.classList.add('show');
  document.body.style.overflow = 'hidden';
  lrSheetEl.focus();
  document.addEventListener('keydown', lrSheetKeydownHandler);
}

function closeLearningResourcesSheet(skipFocusRestore) {
  lrSheetBackdropEl.classList.remove('show');
  lrSheetEl.classList.remove('show');
  lrSheetEl.style.transform = '';
  document.body.style.overflow = '';
  document.removeEventListener('keydown', lrSheetKeydownHandler);
  if (!skipFocusRestore && lrSheetLastFocus && typeof lrSheetLastFocus.focus === 'function') {
    lrSheetLastFocus.focus();
  }
}

function lrSheetKeydownHandler(e) {
  if (e.key === 'Escape') { closeLearningResourcesSheet(); return; }
  if (e.key === 'Tab') {
    const focusable = lrSheetEl.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

(function () {
  let startY = null, currentY = null, dragging = false;
  lrSheetEl.addEventListener('touchstart', e => {
    if (e.target.closest('#lrSheetContent') && lrSheetContentEl.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    dragging = true;
  }, { passive: true });
  lrSheetEl.addEventListener('touchmove', e => {
    if (!dragging) return;
    currentY = e.touches[0].clientY;
    const delta = Math.max(0, currentY - startY);
    lrSheetEl.style.transform = 'translateY(' + delta + 'px)';
  }, { passive: true });
  lrSheetEl.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    const delta = (currentY && startY) ? currentY - startY : 0;
    if (delta > 90) { closeLearningResourcesSheet(); }
    else { lrSheetEl.style.transform = ''; }
    startY = null; currentY = null;
  });
  lrSheetBackdropEl.addEventListener('click', () => closeLearningResourcesSheet());
  lrSheetCloseBtn.addEventListener('click', () => closeLearningResourcesSheet());
})();

LR_MOBILE_QUERY.addEventListener('change', () => {
  if (!lrCurrentData) return;
  closeLearningResourcesSheet(true);
  hideLearningResourcesNotify();
  learningResourcesEl.classList.remove('show');
  learningResourcesEl.innerHTML = '';
  presentLearningResources(lrCurrentData);
});

function quickStudy(action) {
  if (action === 'flashcard') { startFlashcardReview(); return; }
  if (action === 'quiz') { startQuiz(); return; }

  const notes = notesEl.value.trim().slice(0, 500);
  const map = {
    explain:   notes ? 'Explain this simply step-by-step: ' + notes : 'Explain the key concepts of ' + currentSubject + ' step by step',
    summary:   notes ? 'Summarize these notes: ' + notes : 'Summarize the most important topics in ' + currentSubject,
    formula:   'List the key formulas and equations for ' + currentSubject + ' with brief explanations'
  };
  sendMessage(map[action] || '');
}

function extractAndSaveFlashcards(text, subject) {
  const cards = [];
  const lines = text.split('\n');
  const skipWords = ['front', 'question', 'category', 'topic', 'section', 'answer'];
  for (let line of lines) {
    if (!line.startsWith('|') || line.includes('---')) continue;

    const parts = line.split('|').map(p => p.trim()).filter(p => p);
    if (parts.length < 2) continue;

    const lowerParts = parts.map(p => p.toLowerCase());
    if (skipWords.some(w => lowerParts.some(p => p === w || p.startsWith(w + ':')))) continue;

    let front = parts[0].replace(/^\d+[️⃣\d\s]*\s*/, '').trim();
    let back = parts[1].replace(/^Answer:\s*/i, '').trim();

    if (front && back && front.length > 3 && back.length > 3 && front.split(' ').length > 1) {
      cards.push({ front, back, subject: subject });
    }
  }
  
  if (cards.length > 0) {
    cards.forEach(card => {
      fetch('/api/flashcards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card)
      }).catch(err => console.error('Failed to save flashcard:', err));
    });
    flashInChat('ai', `✅ Saved <strong>${cards.length}</strong> flashcards to your deck! Click "🃏 Flashcards" to review.`);
  }
}

async function startFlashcardReview() {
  try {
    const res = await fetch(`/api/flashcards?subject=${encodeURIComponent(currentSubject)}&due=true`);
    const data = await res.json();
    reviewCards = data.flashcards || [];
    
    if (reviewCards.length === 0) {
      const allRes = await fetch(`/api/flashcards?subject=${encodeURIComponent(currentSubject)}`);
      const allData = await allRes.json();
      reviewCards = allData.flashcards || [];
    }

    if (reviewCards.length === 0) {
      flashInChat('ai', '🃏 No flashcards found for <strong>' + currentSubject + '</strong>. Generating some now...');
      const notes = notesEl.value.trim().slice(0, 500);
      const prompt = notes ? 'Make 5 flashcards (front/back format) from: ' + notes : 'Make 5 flashcards for ' + currentSubject;
      sendMessage(prompt);
      return;
    }

    reviewIndex = 0;
    showFlashcardOverlay();
    renderReviewCard();
  } catch (err) {
    console.error('Error loading flashcards:', err);
    flashInChat('ai', '❌ Error loading flashcards. Make sure your server.js is updated!');
  }
}

function showFlashcardOverlay() { $('flashcard-overlay').style.display = 'flex'; }
function hideFlashcardOverlay() { $('flashcard-overlay').style.display = 'none'; }

function renderReviewCard() {
  const progress = $('fc-progress');
  const frontEl = $('fc-front');
  const backEl = $('fc-back');
  
  if (reviewIndex >= reviewCards.length) {
    $('fc-front-text').textContent = '🎉 Session Complete!';
    $('fc-reveal').style.display = 'none';
    frontEl.style.display = 'flex';
    backEl.style.display = 'none';
    progress.textContent = 'Great job!';
    setTimeout(hideFlashcardOverlay, 2500);
    return;
  }

  const card = reviewCards[reviewIndex];
  progress.textContent = `${reviewIndex + 1} / ${reviewCards.length}`;
  
  $('fc-front-text').textContent = card.front;
  $('fc-back-front-text').textContent = card.front;
  $('fc-back-text').textContent = card.back;
  
  frontEl.style.display = 'flex';
  backEl.style.display = 'none';
  $('fc-reveal').style.display = 'inline-block';
}

function rateFlashcard(quality) {
  const card = reviewCards[reviewIndex];
  fetch('/api/flashcards/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: card.id, quality: quality })
  }).then(() => {
    reviewIndex++;
    renderReviewCard();
    trackProgress(card.subject, "Flashcard: " + card.front.substring(0, 30));
  }).catch(err => {
    console.error('Failed to rate card:', err);
    reviewIndex++;
    renderReviewCard();
  });
}

async function askAI(message, systemPrompt, temperature = 0.4, persist = true, maxTokens = null, onProgress = null, signal = null, images = null) {
  const r = await fetch('/api/study', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, subject: currentSubject, systemPrompt, history: [], temperature, noSave: !persist, stream: true, ...(maxTokens ? { maxTokens } : {}), ...(images && images.length ? { images } : {}) }),
    ...(signal ? { signal } : {})
  });

  const ctype = r.headers.get('content-type') || '';
  let data;
  if (ctype.includes('text/event-stream') && r.body) {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', full = '', streamError = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(t.slice(5).trim());
          if (evt.delta) { full += evt.delta; if (typeof onProgress === 'function') onProgress(full); }
          if (evt.error) streamError = evt.error;
        } catch { /* ignore malformed lines */ }
      }
    }
    data = (streamError && !full) ? { error: streamError } : { reply: full };
    askAI.lastWasFallback = false;
  } else {
    data = await r.json().catch(() => ({}));
    askAI.lastWasFallback = Boolean(data.fallback || data.model === 'offline-fallback');
  }

  if (data.error) throw new Error(data.error);
  return data.reply || '';
}

const DEPTH_KEYWORDS = [
  'explain in depth', 'explain in detail', 'in depth', 'in-depth', 'deep dive',
  'comprehensive', 'thorough', 'elaborate', 'walk me through', 'step by step',
  'step-by-step', 'derive', 'proof', 'prove that', 'compare and contrast',
  'pros and cons', 'essay', 'analyze', 'analysis'
];
const INITIAL_LENGTH_THRESHOLD = 400;

function needsReviewPass(message, initial) {
  const lowerMessage = String(message || '').toLowerCase();
  const wantsDepth = DEPTH_KEYWORDS.some(kw => lowerMessage.includes(kw));
  const isLongAnswer = String(initial || '').length > INITIAL_LENGTH_THRESHOLD;
  return wantsDepth || isLongAnswer;
}

async function premiumLoop(message, systemPrompt, onProgress, signal = null, images = null) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};

  notify('Generating initial explanation…');
  // Images only matter for the FIRST pass - the review/rewrite passes below work
  // off the text of that initial explanation, so there's no need (or way, without
  // re-uploading) to re-attach them on every subsequent call.
  const initial = await askAI(message, systemPrompt, 0.4, true, null, null, signal, images);

  if (askAI.lastWasFallback) return initial;
  if (!needsReviewPass(message, initial)) return initial;

  notify('Reviewing for gaps…');
  const reviewPrompt =
    'You are reviewing a tutor\'s explanation written for a student question.\n\n' +
    'Question: ' + message + '\n\n' +
    'Explanation to review:\n' + initial + '\n\n' +
    'List any missing concepts, inaccuracies, unclear points, or weaknesses in this explanation. ' +
    'Be specific and concise. If it is already excellent, say so briefly.';
  const review = await askAI(reviewPrompt, 'You are a strict but constructive academic reviewer.', 0.3, true, null, null, signal);

  if (askAI.lastWasFallback) return initial;

  notify('Refining the explanation…');
  const rewritePrompt =
    'Original question: ' + message + '\n\n' +
    'Original explanation:\n' + initial + '\n\n' +
    'Reviewer feedback:\n' + review + '\n\n' +
    'Rewrite the explanation to address the feedback, filling any gaps and fixing any weaknesses. ' +
    'Keep the same tone and formatting style as the original (markdown, headers, bullet points, examples).';
  const improved = await askAI(rewritePrompt, systemPrompt, 0.4, true, null, null, signal);

  if (askAI.lastWasFallback) return initial;
  return improved;
}

function salvagePartialJsonArray(raw) {
  const start = raw.indexOf('[');
  if (start === -1) return null;
  const objects = [];
  let i = start + 1;
  const n = raw.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(raw[i])) i++;
    if (i >= n || raw[i] === ']') break;
    if (raw[i] !== '{') break;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < n; j++) {
      const c = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
      }
    }
    if (depth !== 0) break;
    try { objects.push(JSON.parse(raw.slice(i, j))); } catch {}
    i = j;
  }
  return objects.length ? objects : null;
}

function extractJson(raw) {
  let s = String(raw).trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  if (/&(?:quot|amp|lt|gt|#39|apos|#\d+);/.test(s)) {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = s;
    s = decoder.value;
  }
  const stripTrailingCommas = (str) => str.replace(/,(\s*[\]}])/g, '$1');
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(stripTrailingCommas(s)); } catch {}
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
    try { return JSON.parse(stripTrailingCommas(arrMatch[0])); } catch {}
  }
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
  const salvaged = salvagePartialJsonArray(s);
  if (salvaged) return salvaged;
  return null;
}

async function startQuiz() {
  quizQuestions = [];
  quizIndex = 0;
  quizScore = 0;
  quizSelectedIndex = null;
  quizLocked = false;
  quizAttemptId = null;
  quizAnswers = [];

  $('quiz-overlay').style.display = 'flex';
  $('quiz-loading').style.display = 'flex';
  $('quiz-loading').innerHTML = '<div class="stcursor"></div><span>Generating your quiz…</span>';
  $('quiz-body').style.display = 'none';
  $('quiz-summary').style.display = 'none';
  $('quiz-progress').textContent = 'Generating…';
  $('quiz-score').textContent = 'Score: 0';

  const notes = notesEl.value.trim().slice(0, 500);

  try {
    // The server generates the questions AND keeps the answer key, so the score
    // can't be self-reported. It returns the questions with the answers stripped;
    // grading happens in awardQuizXp() below.
    const r = await fetch('/api/quiz/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: currentSubject, notes })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('Request failed: ' + r.status));
    if (!Array.isArray(data.questions) || !data.questions.length) throw new Error('Could not parse quiz response.');

    quizAttemptId = data.attemptId;
    // correctIndex is intentionally absent from the payload: the answer key stays
    // on the server. The client submits the chosen indices and /api/quiz/complete
    // returns the authoritative score.
    quizQuestions = data.questions;
    renderQuizQuestion();
  } catch (err) {
    console.error('Quiz generation error:', err);
    $('quiz-loading').innerHTML = '❌ Could not generate a quiz.<br><small style="color:var(--text-dim)">' +
      escapeHtml(err.message || 'Unknown error') + '</small><br><button class="quiz-retry-btn" id="quiz-retry-inline" style="margin-top:14px;">Try Again</button>';
    const retryBtn = document.getElementById('quiz-retry-inline');
    if (retryBtn) retryBtn.addEventListener('click', () => startQuiz());
  }
}

function renderQuizQuestion() {
  $('quiz-loading').style.display = 'none';
  $('quiz-body').style.display = 'flex';
  $('quiz-feedback').className = 'quiz-feedback';
  $('quiz-feedback').style.display = 'none';
  $('quiz-next').style.display = 'none';
  $('quiz-submit').style.display = 'inline-block';
  $('quiz-submit').textContent = 'Submit Answer';
  $('quiz-submit').disabled = true;
  quizSelectedIndex = null;
  quizLocked = false;

  const q = quizQuestions[quizIndex];
  $('quiz-progress').textContent = `Question ${quizIndex + 1} / ${quizQuestions.length}`;
  $('quiz-score').textContent = 'Score: graded at the end';
  $('quiz-question').textContent = q.question;

  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const optionsEl = $('quiz-options');
  optionsEl.innerHTML = '';
  q.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'quiz-option';
    const letter = document.createElement('span');
    letter.className = 'quiz-opt-letter';
    letter.textContent = (letters[i] || i + 1);
    const textSpan = document.createElement('span');
    textSpan.textContent = opt;
    btn.appendChild(letter);
    btn.appendChild(textSpan);
    btn.addEventListener('click', () => selectQuizOption(i));
    optionsEl.appendChild(btn);
  });
}

function selectQuizOption(i) {
  if (quizLocked) return;
  quizSelectedIndex = i;
  document.querySelectorAll('#quiz-options .quiz-option').forEach((el, idx) => {
    el.classList.toggle('selected', idx === i);
  });
  $('quiz-submit').disabled = false;
}

function submitQuizAnswer() {
  if (quizLocked || quizSelectedIndex === null) return;
  quizLocked = true;
  $('quiz-submit').disabled = true;

  // The answer key lives on the server, so the client cannot mark this answer
  // locally. Record the choice, reveal nothing, and let finishQuiz() show the
  // authoritative result once the whole quiz has been graded.
  quizAnswers[quizIndex] = quizSelectedIndex;
  document.querySelectorAll('#quiz-options .quiz-option').forEach((el, idx) => {
    if (idx === quizSelectedIndex) el.classList.add('selected');
    el.classList.add('locked');
  });
  $('quiz-submit').style.display = 'none';
  $('quiz-next').style.display = 'inline-block';
  $('quiz-next').textContent = (quizIndex + 1 >= quizQuestions.length) ? 'See Results →' : 'Next Question →';
}

function nextQuizQuestion() {
  quizIndex++;
  if (quizIndex >= quizQuestions.length) finishQuiz();
  else renderQuizQuestion();
}

async function finishQuiz() {
  $('quiz-body').style.display = 'none';
  $('quiz-summary').style.display = 'flex';
  $('quiz-progress').textContent = 'Complete';
  $('quiz-summary-score').textContent = '…';
  $('quiz-summary-label').textContent = 'GRADING';

  const result = await awardQuizXp();
  const correct = result ? result.correct : 0;
  const total = result ? result.total : quizQuestions.length;
  quizScore = correct;

  $('quiz-summary-score').textContent = correct + ' / ' + total;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  let label = 'QUIZ COMPLETE';
  if (!result) label = '⚠️ COULD NOT GRADE';
  else if (pct === 100) label = '🏆 PERFECT SCORE!';
  else if (pct >= 80) label = '🔥 GREAT JOB!';
  else if (pct >= 50) label = '👍 GOOD EFFORT';
  else label = '📚 KEEP PRACTICING';
  $('quiz-summary-label').textContent = label;

  if (result) {
    trackProgress(currentSubject, 'Quiz: ' + correct + '/' + total);
    if (result.xpAwarded > 0) {
      const note = document.createElement('div');
      note.id = 'quiz-xp-note';
      note.style.cssText = 'margin-top:10px; font-size:12.5px; font-weight:600; color:var(--green); text-align:center;';
      note.textContent = '+' + result.xpAwarded + ' XP earned';
      $('quiz-summary-label').insertAdjacentElement('afterend', note);
    }
  }
}

async function awardQuizXp() {
  if (!quizAttemptId) return null;
  try {
    const answers = quizQuestions.map((_, i) => (typeof quizAnswers[i] === 'number' ? quizAnswers[i] : -1));
    const r = await fetch('/api/quiz/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId: quizAttemptId, answers })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('Request failed: ' + r.status));
    // The attempt is single-use; don't let a second submit reuse the id.
    quizAttemptId = null;
    if (data.progress) { progressData = data.progress; renderProgress(); }
    return {
      correct: Number(data.score?.correct ?? data.correct ?? 0),
      total: Number(data.score?.total ?? data.total ?? quizQuestions.length),
      xpAwarded: Number(data.xpAwarded || 0)
    };
  } catch (e) {
    console.error('Failed to grade quiz', e);
    return null;
  }
}

function closeQuiz() { $('quiz-overlay').style.display = 'none'; }

async function fetchProgress() {
  try {
    const r = await fetch('/api/progress');
    progressData = await r.json();
    renderProgress();
  } catch (e) { console.error('Failed to fetch progress', e); }
}

async function trackProgress(subject, topic) {
  try {
    const r = await fetch('/api/progress/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, topic })
    });
    const data = await r.json();
    if (data.progress) { progressData = data.progress; renderProgress(); }
  } catch (e) { console.error('Failed to track progress', e); }
}

function renderProgress() {
  $('globalStreak').textContent = progressData.globalStreak || 0;
  const list = $('subjectProgressList');
  list.innerHTML = '';
  
  const subjects = progressData.subjects || {};
  if (Object.keys(subjects).length === 0) {
    const empty = document.createElement('div');
    empty.className = 'rchat-empty';
    empty.textContent = 'No progress tracked yet. Start studying to see your stats!';
    list.appendChild(empty);
    return;
  }

  for (const [subject, info] of Object.entries(subjects)) {
    const topicsCount = info.topicsCovered ? info.topicsCovered.length : 0;
    const daysCount = info.studyDays ? info.studyDays.length : 0;
    const xp = info.xp || 0;
    const progressWidth = Math.min(topicsCount * 10, 100);
    const recentTopics = info.topicsCovered && info.topicsCovered.length > 0 
      ? info.topicsCovered.slice(-3).join(', ') 
      : 'None yet';

    const item = document.createElement('div');
    item.className = 'subj-progress-item';

    const header = document.createElement('div');
    header.className = 'subj-progress-header';
    const name = document.createElement('span');
    name.className = 'subj-progress-name';
    name.textContent = subject;
    const stats = document.createElement('span');
    stats.className = 'subj-progress-stats';
    stats.textContent = `${daysCount} days • ${xp} XP`;
    header.appendChild(name);
    header.appendChild(stats);

    const barBg = document.createElement('div');
    barBg.className = 'subj-progress-bar-bg';
    const barFill = document.createElement('div');
    barFill.className = 'subj-progress-bar-fill';
    barFill.style.width = `${progressWidth}%`;
    barBg.appendChild(barFill);

    const topics = document.createElement('div');
    topics.className = 'subj-progress-topics';
    const title = document.createElement('strong');
    title.textContent = 'RECENT TOPICS';
    const text = document.createElement('span');
    text.textContent = recentTopics;
    topics.appendChild(title);
    topics.appendChild(text);

    item.appendChild(header);
    item.appendChild(barBg);
    item.appendChild(topics);
    list.appendChild(item);
  }
}

function openProgress() { renderProgress(); $('progressPanel').classList.add('show'); $('progressOverlay').classList.add('show'); }
function closeProgress() { $('progressPanel').classList.remove('show'); $('progressOverlay').classList.remove('show'); }

async function openLeaderboard() {
  $('leaderboardPanel').classList.add('show');
  $('leaderboardOverlay').classList.add('show');
  const content = $('leaderboardContent');
  content.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'rchat-empty';
  loading.textContent = 'Loading leaderboard…';
  content.appendChild(loading);
  try {
    const r = await fetch('/api/leaderboard');
    if (!r.ok) throw new Error('Request failed: ' + r.status);
    const data = await r.json();
    renderLeaderboard(data);
  } catch (e) {
    console.error('Failed to load leaderboard', e);
    content.textContent = '';
    const errorEl = document.createElement('div');
    errorEl.className = 'rchat-empty';
    errorEl.textContent = 'Could not load the leaderboard. Check your connection and try again.';
    content.appendChild(errorEl);
  }
}
function closeLeaderboard() {
  $('leaderboardPanel').classList.remove('show');
  $('leaderboardOverlay').classList.remove('show');
}

function createAvatarElement(avatar, cls) {
  const wrapper = document.createElement('div');
  wrapper.className = cls;
  if (typeof avatar === 'string' && /^(https:\/\/|data:image\/(png|jpe?g|webp);base64,)/i.test(avatar)) {
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = '';
    wrapper.appendChild(img);
  } else {
    wrapper.innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></svg>';
  }
  return wrapper;
}

function renderLeaderboard(data) {
  const content = $('leaderboardContent');
  content.textContent = '';
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const you = data && typeof data === 'object' ? data.you : null;

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'rchat-empty';
    empty.textContent = 'No XP earned yet. Start studying to be first on the board!';
    content.appendChild(empty);
  } else {
    entries.forEach(e => {
      const isYou = you && e.username === you.username && e.xp === you.xp && e.rank === you.rank;
      const row = document.createElement('div');
      row.className = 'lb-row' + (e.rank <= 3 ? ' lb-rank-' + e.rank : '') + (isYou ? ' lb-you' : '');

      const rank = document.createElement('div');
      rank.className = 'lb-rank';
      rank.textContent = e.rank <= 3 ? ['🥇', '🥈', '🥉'][e.rank - 1] : '#' + e.rank;

      const avatar = createAvatarElement(e.avatar, 'lb-avatar');
      const name = document.createElement('div');
      name.className = 'lb-name';
      name.textContent = e.username + (isYou ? ' (you)' : '');

      const streak = document.createElement('div');
      streak.className = 'lb-streak';
      streak.textContent = '🔥' + (e.streak || 0);

      const xp = document.createElement('div');
      xp.className = 'lb-xp';
      xp.textContent = (e.xp || 0) + ' XP';

      row.append(rank, avatar, name, streak, xp);
      content.appendChild(row);
    });
  }

  if (you && !entries.some(e => e.username === you.username && e.xp === you.xp && e.rank === you.rank)) {
    const label = document.createElement('div');
    label.className = 'lb-refresh-note';
    label.textContent = 'YOUR RANK';
    content.appendChild(label);

    const row = document.createElement('div');
    row.className = 'lb-row lb-you';

    const rank = document.createElement('div');
    rank.className = 'lb-rank';
    rank.textContent = '#' + you.rank;

    const avatar = createAvatarElement(you.avatar, 'lb-avatar');
    const name = document.createElement('div');
    name.className = 'lb-name';
    name.textContent = you.username + ' (you)';

    const streak = document.createElement('div');
    streak.className = 'lb-streak';
    streak.textContent = '🔥' + (you.streak || 0);

    const xp = document.createElement('div');
    xp.className = 'lb-xp';
    xp.textContent = (you.xp || 0) + ' XP';

    row.append(rank, avatar, name, streak, xp);
    content.appendChild(row);
  }

  if (data && data.generatedAt) {
    const note = document.createElement('div');
    note.className = 'lb-refresh-note';
    const d = new Date(data.generatedAt);
    note.textContent = 'Last updated ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' at ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    content.appendChild(note);
  }
}

async function fetchMe() {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) return;
    const data = await r.json();
    currentUser = { email: data.email || '', username: data.username || '', avatar: data.avatar || null };
    applyAvatarToUI();
    $('settingsEmailDisplay').textContent = currentUser.email || '—';
    $('settingsUsernameDisplay').textContent = currentUser.username || '—';
  } catch (e) { console.error('Failed to fetch profile', e); }
}

function applyAvatarToUI() {
  const iconEl = $('settingsAvatarIcon');
  const previewEl = $('settingsAvatarPreview');
  const safeAvatar = typeof currentUser.avatar === 'string' && /^(https:\/\/|data:image\/(png|jpe?g|webp);base64,)/i.test(currentUser.avatar)
    ? currentUser.avatar : null;

  if (iconEl) {
    iconEl.textContent = '';
    if (safeAvatar) {
      const img = document.createElement('img');
      img.src = safeAvatar; img.alt = '';
      img.style.width = '100%'; img.style.height = '100%';
      img.style.objectFit = 'cover'; img.style.display = 'block';
      iconEl.appendChild(img);
    } else {
      iconEl.innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></svg>';
    }
  }

  if (previewEl) {
    previewEl.textContent = '';
    if (safeAvatar) {
      const img = document.createElement('img');
      img.src = safeAvatar; img.alt = '';
      previewEl.appendChild(img);
    } else {
      previewEl.innerHTML = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></svg>';
    }
  }
}

function openSettings() {
  $('settingsPanel').classList.add('show');
  $('settingsOverlay').classList.add('show');
  $('settingsEmailDisplay').textContent = currentUser.email || '—';
  $('settingsUsernameDisplay').textContent = currentUser.username || '—';
  setSettingsMsg('');
  closeUsernameEdit();
}
function closeSettings() {
  $('settingsPanel').classList.remove('show');
  $('settingsOverlay').classList.remove('show');
}

function setSettingsMsg(text, ok) {
  const el = $('settingsMsg');
  el.textContent = text || '';
  el.className = 'msg' + (text ? (ok ? ' ok' : ' error') : '');
}

function handleAvatarFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { setSettingsMsg('Please choose an image file.'); return; }

  const img = new Image();
  const reader = new FileReader();
  reader.onload = ev => { img.src = ev.target.result; };
  img.onload = async () => {
    const size = 80;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const s = Math.min(img.width, img.height);
    const sx = (img.width - s) / 2, sy = (img.height - s) / 2;
    ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);

    setSettingsMsg('Uploading…', true);
    try {
      const r = await fetch('/api/auth/avatar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: dataUrl })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Upload failed');
      currentUser.avatar = j.avatar;
      applyAvatarToUI();
      setSettingsMsg('Profile picture updated!', true);
    } catch (err) {
      setSettingsMsg(err.message);
    }
  };
  reader.readAsDataURL(file);
}

function openUsernameEdit() {
  $('usernameEditRow').style.display = 'block';
  $('newUsernameInput').value = currentUser.username || '';
  $('newUsernameInput').focus();
}
function closeUsernameEdit() { $('usernameEditRow').style.display = 'none'; }

async function saveUsername() {
  const username = $('newUsernameInput').value.trim();
  if (username.length < 3) { setSettingsMsg('Username must be at least 3 characters.'); return; }
  try {
    const r = await fetch('/api/auth/change-username', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not update username');
    currentUser.username = j.username;
    $('settingsUsernameDisplay').textContent = currentUser.username;
    closeUsernameEdit();
    setSettingsMsg('Username updated!', true);
  } catch (e) {
    setSettingsMsg(e.message);
  }
}

async function logout() {
  if (!confirm('Log out of your account?')) return;
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (e) { console.error('Logout request failed', e); }
  location.href = '/';
}

function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Speech recognition not supported. Try Chrome/Edge.'); return; }
  if (micOn) {
    try { recognition && recognition.stop(); } catch {}
    micOn = false;
    $('micBtn').classList.remove('listening');
    return;
  }
  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.onresult = e => {
    const transcript = e.results[0][0].transcript;
    chatInput.value = transcript;
    sendMessage(transcript);
    chatInput.value = '';
  };
  recognition.onend = () => { micOn = false; $('micBtn').classList.remove('listening'); };
  recognition.onerror = () => { micOn = false; $('micBtn').classList.remove('listening'); };
  recognition.start();
  micOn = true;
  $('micBtn').classList.add('listening');
}

function startTimer(mins) {
  stopTimer();
  timerSecs = mins * 60;
  updateTimer();
  timerEl.classList.add('show');
  timerInt = setInterval(() => {
    timerSecs--;
    updateTimer();
    if (timerSecs <= 0) {
      stopTimer();
      flashInChat('ai', '⏰ <strong>Timer done!</strong> Take a short break!');
    }
  }, 1000);
}
function stopTimer() { if (timerInt) clearInterval(timerInt); timerInt = null; }
function updateTimer() {
  const m = Math.floor(timerSecs / 60), s = timerSecs % 60;
  timerDisplay.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function openRecent() { renderRecentList(); $('recentPanel').classList.add('show'); $('recentOverlay').classList.add('show'); }
function closeRecent() { $('recentPanel').classList.remove('show'); $('recentOverlay').classList.remove('show'); }
function renderRecentList() {
  const list = $('recentList');
  if (sessions.length === 0) {
    list.innerHTML = '<div class="rchat-empty">No saved chats yet.<br>Start a conversation to see it here.</div>';
    return;
  }
  list.innerHTML = '';
  sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt).forEach(s => {
    const item = document.createElement('div');
    item.className = 'rchat-item' + (s.id === currentSessionId ? ' active' : '');
    const dateStr = new Date(s.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    item.innerHTML =
      '<div class="rchat-title">' + escapeHtml(s.title) + '</div>' +
      '<div class="rchat-meta">' + escapeHtml(s.subject) + ' · ' + dateStr + '</div>' +
      '<button class="rchat-delete" title="Delete"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>';
    item.addEventListener('click', e => {
      if (e.target.classList.contains('rchat-delete')) {
        e.stopPropagation(); deleteSession(s.id); return;
      }
      activateSession(s.id);
    });
    list.appendChild(item);
  });
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
}

function renderMarkdown(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/###\s+(.+)/g, '<h3 style="color:#ffffff;margin:14px 0 6px;font-size:1.05em;">$1</h3>')
    .replace(/##\s+(.+)/g, '<h2 style="color:#ffffff;margin:16px 0 8px;font-size:1.2em;">$1</h2>')
    .replace(/#\s+(.+)/g, '<h1 style="color:#ffffff;margin:18px 0 10px;font-size:1.4em;">$1</h1>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#ffffff">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^[\-\*]\s+(.+)$/gm, '<div style="padding-left:14px;margin:2px 0;">• $1</div>')
    .replace(/^\d+\.\s+(.+)$/gm, '<div style="padding-left:14px;margin:2px 0;">$&</div>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>')
    .replace(/<p><\/p>/g, '')
    .replace(/<p>(<h[1-3])/g, '$1')
    .replace(/(<\/h[1-3]>)<\/p>/g, '$1')
    .replace(/<p>(<div)/g, '$1')
    .replace(/(<\/div>)<\/p>/g, '$1');
}

function cleanLatex(text) {
  if (!text) return text;
  return String(text)
    .replace(/\\\[([\s\S]*?)\\\]/g, ' $1 ')
    .replace(/\\\(([\s\S]*?)\\\)/g, ' $1 ')
    .replace(/\$\$([\s\S]*?)\$\$/g, ' $1 ')
    .replace(/\$([^$\n]+)\$/g, ' $1 ')
    .replace(/\\dfrac\{([^{}]+)\}\{([^{}]+)\}/g, '($1/$2)')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1/$2)')
    .replace(/\\sqrt\[([^\]]+)\]\{([^{}]+)\}/g, '√[$1]($2)')
    .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
    .replace(/\\text\{([^{}]+)\}/g, '$1')
    .replace(/\\mathrm\{([^{}]+)\}/g, '$1')
    .replace(/\\boxed\{([^{}]+)\}/g, '[$1]')
    .replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β').replace(/\\gamma/g, 'γ')
    .replace(/\\delta/g, 'δ').replace(/\\epsilon/g, 'ε').replace(/\\theta/g, 'θ')
    .replace(/\\lambda/g, 'λ').replace(/\\mu/g, 'μ').replace(/\\pi/g, 'π')
    .replace(/\\sigma/g, 'σ').replace(/\\tau/g, 'τ').replace(/\\phi/g, 'φ')
    .replace(/\\omega/g, 'ω').replace(/\\Gamma/g, 'Γ').replace(/\\Delta/g, 'Δ')
    .replace(/\\Theta/g, 'Θ').replace(/\\Lambda/g, 'Λ').replace(/\\Pi/g, 'Π')
    .replace(/\\Sigma/g, 'Σ').replace(/\\Phi/g, 'Φ').replace(/\\Psi/g, 'Ψ')
    .replace(/\\Omega/g, 'Ω')
    .replace(/\\times/g, '×').replace(/\\div/g, '÷').replace(/\\cdot/g, '·')
    .replace(/\\pm/g, '±').replace(/\\mp/g, '∓')
    .replace(/\\leq/g, '≤').replace(/\\geq/g, '≥').replace(/\\neq/g, '≠')
    .replace(/\\approx/g, '≈').replace(/\\equiv/g, '≡')
    .replace(/\\infty/g, '∞').replace(/\\partial/g, '∂')
    .replace(/\\sum/g, 'Σ').replace(/\\prod/g, 'Π').replace(/\\int/g, '∫')
    .replace(/\\rightarrow/g, '→').replace(/\\to\b/g, '→')
    .replace(/\\leftarrow/g, '←').replace(/\\Rightarrow/g, '⇒')
    .replace(/\\forall/g, '∀').replace(/\\exists/g, '∃')
    .replace(/\\in\b/g, '∈').replace(/\\notin/g, '∉')
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/\\\\/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

(function () {
  const mobileMQ = window.matchMedia('(max-width: 700px)');
  const subjectsEl = document.getElementById('subjects');
  const chatSectionEl = document.getElementById('chatSection');
  const mobileSubjectBar = document.getElementById('mobileSubjectBar');
  const mobileChatDock = document.getElementById('mobileChatDock');

  const subjectsHome = { parent: subjectsEl.parentNode, next: subjectsEl.nextSibling };
  const chatHome = { parent: chatSectionEl.parentNode, next: chatSectionEl.nextSibling };

  function applyLayout(e) {
    if (e.matches) {
      mobileSubjectBar.appendChild(subjectsEl);
      mobileChatDock.appendChild(chatSectionEl);
    } else {
      subjectsHome.next ? subjectsHome.parent.insertBefore(subjectsEl, subjectsHome.next) : subjectsHome.parent.appendChild(subjectsEl);
      chatHome.next ? chatHome.parent.insertBefore(chatSectionEl, chatHome.next) : chatHome.parent.appendChild(chatSectionEl);
    }
  }
  mobileMQ.addEventListener('change', applyLayout);
  applyLayout(mobileMQ);
})();

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('recentPanel').classList.contains('show')) closeRecent();
    if ($('progressPanel').classList.contains('show')) closeProgress();
    if ($('leaderboardPanel').classList.contains('show')) closeLeaderboard();
    if (timerEl.classList.contains('show')) timerEl.classList.remove('show');
    if ($('flashcard-overlay').style.display === 'flex') hideFlashcardOverlay();
    if ($('quiz-overlay').style.display === 'flex') closeQuiz();
    if ($('premiumOverlay').classList.contains('show') && window.PremiumModal) window.PremiumModal.close();
    if ($('premiumWorkspace').classList.contains('show') && window.PremiumWorkspace) window.PremiumWorkspace.close();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    localStorage.setItem('snotes_' + currentSubject, notesEl.value);
    flashInChat('ai', '💾 Notes saved');
  }
});

// ---------- Dev panel: local feature-flag tool ----------
(function () {
  const DEV_KEY = 'devSettings';
  const PANEL_POS_KEY = 'devPanelPos';

  function loadSettings() {
    try {
      const raw = localStorage.getItem(DEV_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(DEV_KEY, JSON.stringify(s)); } catch {}
  }

  let settings = Object.assign({ premium: false, collapsed: false }, loadSettings());

  function applyPremiumClass() {
    document.body.classList.toggle('premium-mode', !!settings.premium);
    ['sidebar', 'chatSection', 'learningResources'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('beam-border', !!settings.premium);
    });
  }

  function syncTempPremiumBtn() {
    const btn = document.getElementById('tempPremiumToggleBtn');
    if (!btn) return;
    const label = btn.querySelector('.subscribe-label');
    if (settings.premium) {
      btn.classList.add('subscribed');
      btn.classList.remove('beam-border');
      if (label) label.textContent = 'Subscribed';
    } else {
      btn.classList.remove('subscribed');
      btn.classList.add('beam-border');
      if (label) label.textContent = 'Subscribe';
    }
  }

  window.DeveloperSettings = {
    isPremium() { return !!settings.premium; },
    setPremium(value) {
      settings.premium = !!value;
      saveSettings(settings);
      applyPremiumClass();
      const toggle = document.getElementById('devPremiumToggle');
      if (toggle) toggle.checked = settings.premium;
      syncTempPremiumBtn();
    }
  };

  const panel = document.getElementById('devPanel');
  const header = document.getElementById('devPanelHeader');
  const collapseBtn = document.getElementById('devPanelCollapseBtn');
  const closeBtn = document.getElementById('devPanelCloseBtn');
  const premiumToggle = document.getElementById('devPremiumToggle');

  applyPremiumClass();
  if (premiumToggle) premiumToggle.checked = settings.premium;
  if (settings.collapsed) panel.classList.add('collapsed');
  syncTempPremiumBtn();

  const tempPremiumBtn = document.getElementById('tempPremiumToggleBtn');
  if (tempPremiumBtn) {
    tempPremiumBtn.addEventListener('click', () => {
      if (settings.premium) {
        // Already premium -> open the workspace directly
        if (window.PremiumWorkspace) window.PremiumWorkspace.open();
      } else {
        if (window.PremiumModal) window.PremiumModal.open();
      }
    });
  }

  try {
    const pos = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      panel.style.left = pos.left + 'px';
      panel.style.top = pos.top + 'px';
      panel.style.right = 'auto';
    }
  } catch {}

  function openDevPanel() { panel.classList.add('show'); }
  function closeDevPanel() { panel.classList.remove('show'); }
  function toggleDevPanel() { panel.classList.contains('show') ? closeDevPanel() : openDevPanel(); }

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      toggleDevPanel();
    }
  });

  closeBtn.addEventListener('click', closeDevPanel);
  collapseBtn.addEventListener('click', () => {
    settings.collapsed = !settings.collapsed;
    saveSettings(settings);
    panel.classList.toggle('collapsed', settings.collapsed);
    collapseBtn.textContent = settings.collapsed ? '+' : '–';
  });
  if (settings.collapsed) collapseBtn.textContent = '+';

  premiumToggle.addEventListener('change', () => {
    window.DeveloperSettings.setPremium(premiumToggle.checked);
  });

  let dragging = false, offsetX = 0, offsetY = 0;
  header.addEventListener('mousedown', e => {
    if (e.target.closest('.dev-icon-btn')) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    panel.style.right = 'auto';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    let left = e.clientX - offsetX;
    let top = e.clientY - offsetY;
    left = Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, left));
    top = Math.max(4, Math.min(window.innerHeight - 40, top));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({
        left: parseInt(panel.style.left, 10),
        top: parseInt(panel.style.top, 10)
      }));
    } catch {}
  });
})();

// ============================================================
// PremiumModal — Aurora glass upgrade screen
// ============================================================
(function () {
  const PREMIUM_FEATURES = [
    { icon: 'zap',    title: 'Faster Responses',   desc: 'Priority AI processing, skip the queue' },
    { icon: 'spark',  title: 'Advanced Models',     desc: 'Smarter, more accurate study answers' },
    { icon: 'infin',  title: 'Unlimited Messages',  desc: 'No daily caps or cool-downs' },
    { icon: 'play',   title: 'Curated Videos',      desc: 'Hand-matched lessons for every topic' },
    { icon: 'repeat', title: 'Loop Engineering',    desc: 'AI reviews & rewrites its own answers' },
    { icon: 'chart',  title: 'Progress Analytics',  desc: 'Deeper streaks & mastery insights' }
  ];
  const PREMIUM_CHECKLIST = [
    'Unlimited Messages', 'Priority Responses', 'Advanced Models',
    'Curated Videos', 'Loop Engineering', 'Progress Analytics'
  ];
  const ICONS = {
    zap:   '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
    infin: '<path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.32-8-12.414-8-5.096 0-5.096 8 0 8 5.094 0 7.319-8 12.414-8Z"/>',
    play:  '<circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4V8z"/>',
    repeat:'<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    chart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    check: '<path d="M20 6 9 17l-5-5"/>'
  };
  function svg(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  function escAttr(s) { return String(s).replace(/"/g, '&quot;').toLowerCase(); }

  const overlay   = document.getElementById('premiumOverlay');
  const grid      = document.getElementById('premiumCardsGrid');
  const checklist = document.getElementById('premiumChecklist');
  const searchEl  = document.getElementById('premiumSearchInput');
  const closeBtn  = document.getElementById('premiumModalClose');
  const ctaBtn    = document.getElementById('premiumCtaBtn');
  const ctaLabel  = document.getElementById('premiumCtaLabel');
  if (!overlay || !grid || !checklist || !searchEl || !closeBtn || !ctaBtn) return;

  function renderCards() {
    grid.innerHTML = PREMIUM_FEATURES.map(f =>
      '<div class="premium-card" data-title="' + escAttr(f.title) + '" data-desc="' + escAttr(f.desc) + '">' +
        '<div class="premium-card-icon">' + svg(ICONS[f.icon] || '') + '</div>' +
        '<h4>' + f.title + '</h4><p>' + f.desc + '</p>' +
      '</div>'
    ).join('') + '<p class="premium-cards-empty" id="premiumCardsEmpty">No features match your search.</p>';
  }
  function renderChecklist() {
    checklist.innerHTML = PREMIUM_CHECKLIST.map(item =>
      '<li><span class="check-badge">' + svg(ICONS.check) + '</span><span>' + item + '</span></li>'
    ).join('');
  }
  function filterCards(q) {
    q = (q || '').trim().toLowerCase();
    let visible = 0;
    grid.querySelectorAll('.premium-card').forEach(card => {
      const match = !q || card.dataset.title.includes(q) || card.dataset.desc.includes(q);
      card.classList.toggle('is-hidden', !match);
      if (match) visible++;
    });
    const empty = document.getElementById('premiumCardsEmpty');
    if (empty) empty.classList.toggle('show', visible === 0);
  }
  function syncCtaState() {
    const isPremium = !!(window.DeveloperSettings && window.DeveloperSettings.isPremium());
    ctaBtn.classList.toggle('is-subscribed', isPremium);
    ctaLabel.textContent = isPremium ? '✓ You\u2019re Premium — Open Workspace' : 'Upgrade to Premium';
  }

  function openPremiumModal() {
    renderCards();
    renderChecklist();
    searchEl.value = '';
    filterCards('');
    syncCtaState();
    overlay.classList.add('show');
    setTimeout(() => searchEl.focus(), 250);
  }
  function closePremiumModal() {
    overlay.classList.remove('show');
  }

  closeBtn.addEventListener('click', closePremiumModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closePremiumModal(); });
  searchEl.addEventListener('input', () => filterCards(searchEl.value));
  ctaBtn.addEventListener('click', () => {
    if (!window.DeveloperSettings) return;
    const nowPremium = !window.DeveloperSettings.isPremium();
    window.DeveloperSettings.setPremium(nowPremium);
    syncCtaState();
    if (nowPremium) {
      setTimeout(() => {
        closePremiumModal();
        if (window.PremiumWorkspace) window.PremiumWorkspace.open();
      }, 500);
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay.classList.contains('show')) searchEl.focus();
      else openPremiumModal();
    }
  });

  window.PremiumModal = { open: openPremiumModal, close: closePremiumModal };
})();

// ============================================================
// PremiumWorkspace — Full-screen immersive AI laboratory
// ============================================================
(function () {
  const root = document.createElement('div');
  root.id = 'premiumWorkspace';
  root.innerHTML = `
    <div class="pw-ambient" aria-hidden="true">
      <div class="pw-blob emerald"></div>
      <div class="pw-blob cyan"></div>
      <div class="pw-blob purple"></div>
      <div class="pw-blob blue"></div>
      <div class="pw-blob magenta"></div>
    </div>
    <div class="pw-scroll">
      <div class="pw-layout">
        <aside class="pw-sidebar" id="pwSidebar">
          <div class="pw-side-section">Workspace</div>
          <div class="pw-side-item active" data-view="home">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>
            <span>Home</span>
          </div>
          <div class="pw-side-item" data-view="recent">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l4 2"/></svg>
            <span>Recent Chats</span>
          </div>
          <div class="pw-side-item" data-view="projects">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            <span>Projects</span>
          </div>
          <div class="pw-side-item" data-view="bookmarks">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            <span>Bookmarks</span>
          </div>
          <div class="pw-side-section">Library</div>
          <div class="pw-side-item" data-view="templates">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 9h5"/><path d="M14 13h5"/></svg>
            <span>Templates</span>
          </div>
          <div class="pw-side-item" data-view="settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span>Settings</span>
          </div>
        </aside>
        <main class="pw-main">
          <div class="pw-topbar">
            <div class="pw-brand">
              <span class="pw-brand-pulse"></span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 1.9 5.9 6.1.6-4.7 4 1.4 6L12 16.9 7.3 19.5l1.4-6L4 9.5l6.1-.6z"/></svg>
              PREMIUM WORKSPACE
            </div>
            <div class="pw-topbar-right">
              <div class="pw-ai-status is-ready" id="pwAiStatus">
                <span class="pw-ai-dot"></span>
                <span id="pwAiLabel">AI Ready</span>
              </div>
              <button class="pw-exit-btn" id="pwExitBtn" aria-label="Exit Premium Workspace">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>
          </div>

          <div class="pw-view active" data-view="home">
            <div class="pw-hero">
              <span class="pw-hero-eyebrow">Premium AI Workspace</span>
              <h1>Your personal AI studio for<br><span class="grad">deep learning, coding, writing, research, and creativity.</span></h1>
              <p>An exclusive environment for powerful AI tools, designed for focused, intelligent work.</p>
            </div>

            <div class="pw-tools-grid" id="pwToolsGrid"></div>

            <div class="pw-suggested-label">Try one of these</div>
            <div class="pw-suggested" id="pwSuggested"></div>

            <div class="pw-composer-wrap">
              <div class="pw-attach-chips" id="pwAttachChips"></div>
              <div class="pw-composer" id="pwComposer">
                <input type="file" id="pwFileInput" multiple style="display:none">
                <input type="file" id="pwImageInput" accept="image/*" multiple style="display:none">
                <textarea id="pwPrompt" placeholder="What would you like to build today?" rows="1"></textarea>
                <div class="pw-composer-icons">
                  <button class="pw-icon-btn" id="pwAttachBtn" title="Attach file" aria-label="Attach file">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  </button>
                  <button class="pw-icon-btn" id="pwVoiceBtn" title="Voice input" aria-label="Voice input">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
                  </button>
                  <button class="pw-icon-btn" id="pwImageBtn" title="Upload image" aria-label="Upload image">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>
                  </button>
                </div>
                <button class="pw-send-btn" id="pwSendBtn" aria-label="Send" disabled>
                  <svg id="pwSendIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                </button>
              </div>
            </div>

            <div class="pw-widgets-title">Dashboard</div>
            <div class="pw-widgets" id="pwWidgets"></div>

            <div class="pw-response-area" id="pwResponseArea"></div>
          </div>

          <div class="pw-view" data-view="recent">
            <h2 class="pw-section-title">Recent Chats</h2>
            <div class="pw-list" id="pwRecentList"></div>
          </div>
          <div class="pw-view" data-view="projects">
            <h2 class="pw-section-title">Projects</h2>
            <div class="pw-add-row">
              <input type="text" id="pwNewProject" placeholder="Create a new project…" maxlength="40">
              <button id="pwAddProject">Add</button>
            </div>
            <div class="pw-list" id="pwProjectsList"></div>
          </div>
          <div class="pw-view" data-view="bookmarks">
            <h2 class="pw-section-title">Bookmarks</h2>
            <div class="pw-list" id="pwBookmarksList"></div>
          </div>
          <div class="pw-view" data-view="templates">
            <h2 class="pw-section-title">Templates</h2>
            <div class="pw-templates-grid" id="pwTemplatesGrid"></div>
          </div>
          <div class="pw-view" data-view="settings">
            <h2 class="pw-section-title">Settings</h2>
            <div class="pw-settings-row">
              <div>
                <div class="pw-settings-row-label">Aurora intensity</div>
                <div class="pw-settings-row-sub">Ambient lighting strength throughout the workspace</div>
              </div>
              <button class="pw-settings-btn">Adjust</button>
            </div>
            <div class="pw-settings-row">
              <div>
                <div class="pw-settings-row-label">Voice & audio</div>
                <div class="pw-settings-row-sub">Microphone, voice replies, ambient sounds</div>
              </div>
              <button class="pw-settings-btn">Configure</button>
            </div>
            <div class="pw-settings-row">
              <div>
                <div class="pw-settings-row-label">Reset workspace</div>
                <div class="pw-settings-row-sub">Clear local projects, bookmarks, and templates</div>
              </div>
              <button class="pw-settings-btn danger">Reset</button>
            </div>
          </div>
        </main>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  // ---------- State ----------
  const state = {
    projects: JSON.parse(localStorage.getItem('pwProjects') || '[]'),
    bookmarks: JSON.parse(localStorage.getItem('pwBookmarks') || '[]'),
    selectedTool: null
  };

  // ---------- Tool cards ----------
  const TOOLS = [
    { id: 'deep-research', icon: '🧠', title: 'Deep Research', desc: 'Multi-source synthesis' },
    { id: 'gpt-55',        icon: '⚡', title: 'GPT-5.5 Unlimited', desc: 'Most powerful model' },
    { id: 'smart-notes',   icon: '📚', title: 'Smart Notes', desc: 'Organize everything' },
    { id: 'essay-writer',  icon: '📝', title: 'Essay Writer', desc: 'Polished long-form' },
    { id: 'coding',        icon: '💻', title: 'Coding Assistant', desc: 'Pair programming' },
    { id: 'problem-solver',icon: '🧮', title: 'Problem Solver', desc: 'Step-by-step logic' },
    { id: 'image-gen',     icon: '🖼', title: 'Image Generator', desc: 'Stunning visuals' },
    { id: 'voice-tutor',   icon: '🎙', title: 'Voice Tutor', desc: 'Speak to learn' },
    { id: 'analytics',     icon: '📊', title: 'Study Analytics', desc: 'Track mastery' },
    { id: 'flashcards',    icon: '🧩', title: 'Flashcards', desc: 'Spaced repetition' }
  ];

  function renderTools() {
    const grid = root.querySelector('#pwToolsGrid');
    grid.innerHTML = TOOLS.map(t => `
      <button class="pw-tool-card${state.selectedTool === t.id ? ' selected' : ''}" data-tool="${t.id}">
        <span class="pw-tool-icon">${t.icon}</span>
        <h4>${t.title}</h4>
        <p>${t.desc}</p>
      </button>
    `).join('');
    grid.querySelectorAll('.pw-tool-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.tool;
        state.selectedTool = state.selectedTool === id ? null : id;
        renderTools();
      });
    });
  }

  // ---------- Suggested prompts ----------
  const SUGGESTED = [
    'Explain this concept visually',
    'Generate study notes',
    'Solve this coding problem',
    'Create flashcards',
    'Summarize my PDF'
  ];
  function renderSuggested() {
    const wrap = root.querySelector('#pwSuggested');
    wrap.innerHTML = SUGGESTED.map(s => `<button class="pw-suggested-card">${s}</button>`).join('');
    wrap.querySelectorAll('.pw-suggested-card').forEach(card => {
      card.addEventListener('click', () => {
        const ta = root.querySelector('#pwPrompt');
        ta.value = card.textContent;
        ta.focus();
        updateSendButton();
        autoResize(ta);
      });
    });
  }

  // ---------- Widgets ----------
  function renderWidgets() {
    const grid = root.querySelector('#pwWidgets');
    const widgets = [
      { label: "Today's Study Time", value: '2h 14m', sub: '+34m vs yesterday' },
      { label: 'Weekly Progress', value: '78%', sub: '6 of 8 goals' },
      { label: 'AI Usage', value: '142', sub: 'requests this week' },
      { label: 'Projects', value: state.projects.length.toString(), sub: state.projects.length ? 'Active workspace' : 'No projects yet' },
      { label: 'Recent Files', value: '8', sub: 'Updated today' },
      { label: 'Bookmarks', value: state.bookmarks.length.toString(), sub: 'Saved items' }
    ];
    grid.innerHTML = widgets.map(w => `
      <div class="pw-widget">
        <div class="pw-widget-label">${w.label}</div>
        <div class="pw-widget-value">${w.value}</div>
        <div class="pw-widget-sub">${w.sub}</div>
      </div>
    `).join('');
  }

  // ---------- Composer ----------
  const promptEl    = root.querySelector('#pwPrompt');
  const sendBtn     = root.querySelector('#pwSendBtn');
  const sendIcon    = root.querySelector('#pwSendIcon');
  const attachBtn   = root.querySelector('#pwAttachBtn');
  const imageBtn    = root.querySelector('#pwImageBtn');
  const voiceBtn    = root.querySelector('#pwVoiceBtn');
  const fileInput   = root.querySelector('#pwFileInput');
  const imageInput  = root.querySelector('#pwImageInput');
  const chipsWrap   = root.querySelector('#pwAttachChips');

  const SEND_ICON = '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>';
  const STOP_ICON = '<rect x="6" y="6" width="12" height="12" rx="2"/>';

  let pwAttachedFiles = [];
  let pwGenerating = false;
  let pwAbortController = null;

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(180, el.scrollHeight) + 'px';
  }

  function updateSendButton() {
    if (pwGenerating) {
      sendBtn.classList.add('ready', 'stop');
      sendBtn.disabled = false;
      sendIcon.innerHTML = STOP_ICON;
      sendBtn.setAttribute('aria-label', 'Stop');
      sendBtn.title = 'Stop generating';
      return;
    }
    sendBtn.classList.remove('stop');
    sendIcon.innerHTML = SEND_ICON;
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.title = 'Send';
    const hasContent = promptEl.value.trim().length > 0 || pwAttachedFiles.length > 0;
    sendBtn.classList.toggle('ready', hasContent);
    sendBtn.disabled = !hasContent;
  }

  function renderChips() {
    chipsWrap.innerHTML = pwAttachedFiles.map((f, i) => `
      <span class="pw-chip" data-i="${i}">
        <span>${escapeHtml(f.name.length > 24 ? f.name.slice(0, 21) + '…' : f.name)}</span>
        <button type="button" aria-label="Remove ${escapeHtml(f.name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </span>
    `).join('');
    chipsWrap.querySelectorAll('.pw-chip button').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.parentElement.dataset.i);
        pwAttachedFiles.splice(i, 1);
        renderChips();
        updateSendButton();
      });
    });
  }

  function addFiles(fileList) {
    Array.from(fileList).forEach(f => pwAttachedFiles.push(f));
    renderChips();
    updateSendButton();
  }

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  imageBtn.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', () => { addFiles(imageInput.files); imageInput.value = ''; });

  // ---------- Voice input ----------
  let pwRecognition = null;
  let pwListening = false;
  function togglePwVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Speech recognition not supported. Try Chrome/Edge.'); return; }
    if (pwListening) {
      try { pwRecognition && pwRecognition.stop(); } catch {}
      return;
    }
    pwRecognition = new SR();
    pwRecognition.lang = 'en-US';
    pwRecognition.interimResults = false;
    pwRecognition.onresult = e => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join(' ');
      promptEl.value = (promptEl.value.trim() + ' ' + transcript).trim();
      updateSendButton();
      autoResize(promptEl);
    };
    pwRecognition.onend = () => { pwListening = false; voiceBtn.classList.remove('listening'); };
    pwRecognition.onerror = () => { pwListening = false; voiceBtn.classList.remove('listening'); };
    pwRecognition.start();
    pwListening = true;
    voiceBtn.classList.add('listening');
  }
  voiceBtn.addEventListener('click', togglePwVoice);

  promptEl.addEventListener('input', () => { updateSendButton(); autoResize(promptEl); });
  promptEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendBtn.click();
    }
  });
  sendBtn.addEventListener('click', () => {
    if (pwGenerating) {
      if (pwAbortController) pwAbortController.abort();
      return;
    }
    submitPremiumPrompt();
  });
  function autoResizeInit() { autoResize(promptEl); }

  // ---------- View switching ----------
  function switchView(view) {
    root.querySelectorAll('.pw-side-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === view);
    });
    root.querySelectorAll('.pw-view').forEach(v => {
      v.classList.toggle('active', v.dataset.view === view);
    });
    if (view === 'recent') renderRecent();
    if (view === 'projects') renderProjects();
    if (view === 'bookmarks') renderBookmarks();
    if (view === 'templates') renderTemplates();
  }
  root.querySelectorAll('.pw-side-item').forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });

  function renderRecent() {
    const list = root.querySelector('#pwRecentList');
    if (sessions.length === 0) {
      list.innerHTML = '<div class="pw-empty-state">No recent chats yet.</div>';
      return;
    }
    list.innerHTML = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(s => `
      <div class="pw-list-item" data-sid="${s.id}">
        <div class="pw-list-item-main">
          <div class="pw-list-item-title">${escapeHtml(s.title || 'New chat')}</div>
          <div class="pw-list-item-sub">${escapeHtml(s.subject)} · ${new Date(s.updatedAt).toLocaleDateString()}</div>
        </div>
        <button class="pw-list-item-del" aria-label="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    `).join('');
    list.querySelectorAll('.pw-list-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.pw-list-item-del')) {
          deleteSession(el.dataset.sid);
          renderRecent();
          return;
        }
        activateSession(el.dataset.sid).then(() => {
          switchView('home');
          closePremiumWorkspace();
        });
      });
    });
  }

  function renderProjects() {
    const list = root.querySelector('#pwProjectsList');
    if (state.projects.length === 0) {
      list.innerHTML = '<div class="pw-empty-state">No projects yet. Create one above to get started.</div>';
      return;
    }
    list.innerHTML = state.projects.map(p => `
      <div class="pw-list-item">
        <div class="pw-list-item-main">
          <div class="pw-list-item-title">${escapeHtml(p.name)}</div>
          <div class="pw-list-item-sub">Created ${new Date(p.createdAt).toLocaleDateString()}</div>
        </div>
        <button class="pw-list-item-del" data-id="${p.id}" aria-label="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    `).join('');
    list.querySelectorAll('.pw-list-item-del').forEach(btn => {
      btn.addEventListener('click', () => {
        state.projects = state.projects.filter(p => p.id !== btn.dataset.id);
        localStorage.setItem('pwProjects', JSON.stringify(state.projects));
        renderProjects(); renderWidgets();
      });
    });
  }

  const newProjectInput = root.querySelector('#pwNewProject');
  const addProjectBtn = root.querySelector('#pwAddProject');
  function addProject() {
    const name = newProjectInput.value.trim();
    if (!name) return;
    state.projects.push({ id: 'p_' + Date.now(), name, createdAt: Date.now() });
    localStorage.setItem('pwProjects', JSON.stringify(state.projects));
    newProjectInput.value = '';
    renderProjects(); renderWidgets();
  }
  addProjectBtn.addEventListener('click', addProject);
  newProjectInput.addEventListener('keydown', e => { if (e.key === 'Enter') addProject(); });

  function renderBookmarks() {
    const list = root.querySelector('#pwBookmarksList');
    if (state.bookmarks.length === 0) {
      list.innerHTML = '<div class="pw-empty-state">No bookmarks yet. Bookmark AI responses to see them here.</div>';
      return;
    }
    list.innerHTML = state.bookmarks.map(b => `
      <div class="pw-list-item">
        <div class="pw-list-item-main">
          <div class="pw-list-item-title">${escapeHtml(b.title)}</div>
          <div class="pw-list-item-sub">Saved ${new Date(b.savedAt).toLocaleDateString()}</div>
        </div>
        <button class="pw-list-item-del" data-id="${b.id}" aria-label="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    `).join('');
    list.querySelectorAll('.pw-list-item-del').forEach(btn => {
      btn.addEventListener('click', () => {
        state.bookmarks = state.bookmarks.filter(b => b.id !== btn.dataset.id);
        localStorage.setItem('pwBookmarks', JSON.stringify(state.bookmarks));
        renderBookmarks(); renderWidgets();
      });
    });
  }

  function renderTemplates() {
    const grid = root.querySelector('#pwTemplatesGrid');
    const templates = [
      { title: 'Deep-dive explanation', desc: 'Detailed breakdown with examples and visuals.' },
      { title: 'Quick summary', desc: 'Concise 5-bullet summary of any topic.' },
      { title: 'Practice quiz', desc: '10-question quiz with instant feedback.' },
      { title: 'Flashcard deck', desc: 'Generate 20 spaced-repetition flashcards.' }
    ];
    grid.innerHTML = templates.map(t => `
      <div class="pw-template-card">
        <h4>${t.title}</h4>
        <p>${t.desc}</p>
      </div>
    `).join('');
    grid.querySelectorAll('.pw-template-card').forEach((card, i) => {
      card.addEventListener('click', () => {
        promptEl.value = templates[i].title + ': ' + (notesEl.value.trim().slice(0, 200) || currentSubject);
        updateSendButton(); autoResize(promptEl);
        switchView('home');
        promptEl.focus();
      });
    });
  }

  // ---------- AI status & prompt submission ----------
  const aiStatus = root.querySelector('#pwAiStatus');
  const aiLabel  = root.querySelector('#pwAiLabel');
  function setAiStatus(thinking) {
    aiStatus.classList.toggle('is-thinking', !!thinking);
    aiStatus.classList.toggle('is-ready', !thinking);
    aiLabel.textContent = thinking ? 'Thinking…' : 'AI Ready';
  }

  // Reads image Files as base64 data URLs so they can actually be sent to a
  // vision-capable model, instead of only sending the filename as text (which is
  // all the AI used to receive - it correctly had no idea what the image showed).
  const PW_MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB raw file size cap per image
  const PW_MAX_IMAGES = 3;
  async function filesToImageDataUrls(files) {
    const urls = [];
    for (const f of files.slice(0, PW_MAX_IMAGES)) {
      if (f.size > PW_MAX_IMAGE_BYTES) continue;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read ' + f.name));
          reader.readAsDataURL(f);
        });
        urls.push(dataUrl);
      } catch (e) {
        console.error('[Attach] failed to read image:', e);
      }
    }
    return urls;
  }

  async function submitPremiumPrompt() {
    if (pwGenerating) return;
    let text = promptEl.value.trim();
    const files = pwAttachedFiles.slice();
    if (!text && files.length === 0) return;

    const imageFiles = files.filter(f => f.type && f.type.startsWith('image/'));
    const otherFiles = files.filter(f => !(f.type && f.type.startsWith('image/')));
    const images = imageFiles.length ? await filesToImageDataUrls(imageFiles) : [];

    if (otherFiles.length) {
      text = (text ? text + '\n\n' : '') + 'Attached file(s): ' + otherFiles.map(f => f.name).join(', ');
    }
    if (images.length && !text) {
      text = 'What is in this image?';
    }
    promptEl.value = '';
    pwAttachedFiles = [];
    renderChips();
    autoResize(promptEl);

    const area = root.querySelector('#pwResponseArea');
    const card = document.createElement('div');
    card.className = 'pw-response-card';
    card.innerHTML = `
      <div class="pw-response-user">
        <span>You · <strong>${escapeHtml(text.slice(0, 80))}${text.length > 80 ? '…' : ''}</strong></span>
        <button class="pw-bookmark-btn" aria-label="Bookmark" title="Bookmark this response">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        </button>
      </div>
      <div class="pw-body" data-stage="thinking">
        <div class="pw-thinking-row">${calcLoaderHTML('Thinking deeply', 'lg')}</div>
      </div>
    `;
    area.prepend(card);

    const bodyEl = card.querySelector('.pw-body');
    const bookBtn = card.querySelector('.pw-bookmark-btn');
    bookBtn.addEventListener('click', () => {
      const saved = bookBtn.classList.toggle('saved');
      if (saved) {
        state.bookmarks.unshift({ id: 'b_' + Date.now(), title: text.slice(0, 80), savedAt: Date.now() });
        localStorage.setItem('pwBookmarks', JSON.stringify(state.bookmarks));
        renderWidgets();
      }
    });

    setAiStatus(true);
    pwGenerating = true;
    pwAbortController = new AbortController();
    updateSendButton();
    const sysp = 'You are an expert tutor. Subject: ' + currentSubject + '. Give clear, structured answers with examples, bullet points, and headers. Use markdown formatting.' +
      (notesEl.value.trim() ? ' Student notes: ' + notesEl.value.trim().slice(0, 600) : '');
    try {
      const reply = await premiumLoop(text, sysp, (msg) => {
        bodyEl.innerHTML = '<div class="pw-thinking-row">' + calcLoaderHTML(msg, 'lg') + '</div>';
      }, pwAbortController.signal, images);
      const cleaned = String(reply).replace(/<\s*\/?\s*br\s*>/gi, '\n');
      const html = renderMarkdown(cleanLatex(cleaned));
      bodyEl.classList.remove('pw-thinking-row');
      bodyEl.innerHTML = html;
    } catch (e) {
      if (e.name === 'AbortError') {
        bodyEl.innerHTML = '⏹ Stopped.';
      } else {
        bodyEl.innerHTML = '❌ <strong>AI Error:</strong> ' + escapeHtml(e.message);
      }
    }
    pwGenerating = false;
    pwAbortController = null;
    updateSendButton();
    setAiStatus(false);
  }

  // ---------- Open / close ----------
  function openPremiumWorkspace() {
    if (!window.DeveloperSettings || !window.DeveloperSettings.isPremium()) {
      if (window.PremiumModal) { window.PremiumModal.open(); return; }
    }
    renderTools();
    renderSuggested();
    renderWidgets();
    autoResizeInit();
    updateSendButton();
    root.classList.remove('closing');
    root.classList.add('show');
    document.body.style.overflow = 'hidden';
    setTimeout(() => promptEl.focus(), 400);
  }

  function closePremiumWorkspace() {
    root.classList.add('closing');
    document.body.style.overflow = '';
    setTimeout(() => {
      root.classList.remove('show');
      root.classList.remove('closing');
    }, 350);
  }

  root.querySelector('#pwExitBtn').addEventListener('click', closePremiumWorkspace);

  window.PremiumWorkspace = { open: openPremiumWorkspace, close: closePremiumWorkspace };
})();
