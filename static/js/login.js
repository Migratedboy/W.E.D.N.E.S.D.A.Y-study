let mode = 'login';
let pendingEmail = '';

const originalFetch = window.fetch.bind(window);
window.fetch = function(input, init = {}) {
  if (typeof input === 'string' && input.startsWith('/api/')) {
    init = { credentials: 'same-origin', ...init };
  }
  return originalFetch(input, init);
};

function setMode(m) {
  mode = m;
  document.getElementById('tab-login').classList.toggle('active', m === 'login');
  document.getElementById('tab-signup').classList.toggle('active', m === 'signup');
  document.getElementById('submit-btn').textContent = m === 'login' ? 'Log in' : 'Create account';
  const emailInput = document.getElementById('email');
  if (m === 'login') {
    document.getElementById('email-label').textContent = 'Email or username';
    emailInput.placeholder = 'you@example.com or username';
    emailInput.autocomplete = 'username';
  } else {
    document.getElementById('email-label').textContent = 'Email';
    emailInput.placeholder = 'you@example.com';
    emailInput.autocomplete = 'email';
  }
  showMsg('');
}

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text || '';
  el.className = 'msg ' + (text ? (ok ? 'ok' : 'error') : '');
}

async function api(path, data) {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

async function submitCredentials() {
  const identifier = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!identifier || !password) return showMsg((mode === 'login' ? 'Email/username' : 'Email') + ' and password are required.');
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  try {
    const payload = mode === 'login' ? { identifier: identifier, password: password } : { email: identifier, password: password };
    const j = await api('/api/auth/' + (mode === 'login' ? 'login' : 'signup'), payload);
    pendingEmail = j.email || identifier;
    document.getElementById('step-credentials').classList.add('hidden');
    document.getElementById('step-code').classList.remove('hidden');
    document.getElementById('code-hint').textContent = 'Enter the 6-digit code sent to ' + pendingEmail;
    showMsg(j.message || 'Code sent.', true);
    document.getElementById('code').focus();
  } catch (e) { showMsg(e.message); }
  btn.disabled = false;
}

async function submitCode() {
  const code = document.getElementById('code').value.trim();
  if (code.length !== 6) return showMsg('Enter the 6-digit code.');
  try {
    const j = await api('/api/auth/verify', { email: pendingEmail, code: code });
    if (j.needsUsername) {
      document.getElementById('step-code').classList.add('hidden');
      document.getElementById('step-username').classList.remove('hidden');
      showMsg('');
      document.getElementById('username').focus();
      return;
    }
    showMsg('Success! Loading your study space...', true);
    location.href = '/';
  } catch (e) { showMsg(e.message); }
}

async function submitUsername() {
  const username = document.getElementById('username').value.trim();
  if (username.length < 3) return showMsg('Username must be at least 3 characters.');
  try {
    await api('/api/auth/set-username', { email: pendingEmail, username: username });
    showMsg('Success! Loading your study space...', true);
    location.href = '/';
  } catch (e) { showMsg(e.message); }
}

async function resendCode() {
  try {
    const j = await api('/api/auth/resend', { email: pendingEmail });
    showMsg(j.message || 'New code sent.', true);
  } catch (e) { showMsg(e.message); }
}

function backToStart() {
  document.getElementById('step-code').classList.add('hidden');
  document.getElementById('step-credentials').classList.remove('hidden');
  showMsg('');
}

document.getElementById('password').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitCredentials(); });
document.getElementById('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitCode(); });
document.getElementById('username').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitUsername(); });

// ============================================================
// Event wiring
// ============================================================
// These were inline onclick attributes in the markup. They are bound here
// because the app's CSP forbids inline script.
document.getElementById('tab-login').addEventListener('click', () => setMode('login'));
document.getElementById('tab-signup').addEventListener('click', () => setMode('signup'));
document.getElementById('submit-btn').addEventListener('click', submitCredentials);
document.getElementById('verify-btn').addEventListener('click', submitCode);
document.getElementById('resend-btn').addEventListener('click', resendCode);
document.getElementById('back-btn').addEventListener('click', backToStart);
document.getElementById('username-btn').addEventListener('click', submitUsername);
