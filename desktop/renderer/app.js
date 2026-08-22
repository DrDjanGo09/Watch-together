const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const toggleBtn = document.getElementById('toggle-btn');
const shareCard = document.getElementById('share-card');
const errorCard = document.getElementById('error-card');
const errorText = document.getElementById('error-text');
const qrImg = document.getElementById('qr');
const linkInput = document.getElementById('link-input');
const copyBtn = document.getElementById('copy-btn');
const openBtn = document.getElementById('open-btn');
const logEl = document.getElementById('log');

let running = false;

function setStatus(state, label) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = label;
}

function applyStatus({ state, url, qrDataUrl, error }) {
  errorCard.classList.add('hidden');
  if (state === 'starting') {
    setStatus('starting', 'Starting…');
    toggleBtn.textContent = 'Starting…';
    toggleBtn.disabled = true;
    shareCard.classList.add('hidden');
    running = false;
  } else if (state === 'running') {
    setStatus('running', 'Running');
    toggleBtn.textContent = 'Stop Watch Party';
    toggleBtn.disabled = false;
    running = true;
    shareCard.classList.remove('hidden');
    linkInput.value = url;
    qrImg.src = qrDataUrl;
  } else if (state === 'error') {
    setStatus('error', 'Something went wrong');
    toggleBtn.textContent = 'Start Watch Party';
    toggleBtn.disabled = false;
    running = false;
    shareCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
    errorText.textContent = error || 'Unknown error';
  } else {
    setStatus('idle', 'Not running');
    toggleBtn.textContent = 'Start Watch Party';
    toggleBtn.disabled = false;
    running = false;
    shareCard.classList.add('hidden');
  }
}

toggleBtn.addEventListener('click', async () => {
  if (running) {
    toggleBtn.disabled = true;
    await window.watchTogether.stop();
  } else {
    await window.watchTogether.start();
  }
});

copyBtn.addEventListener('click', async () => {
  await window.watchTogether.copyLink(linkInput.value);
  copyBtn.textContent = 'Copied!';
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
});

openBtn.addEventListener('click', () => {
  window.watchTogether.openLink(linkInput.value);
});

window.watchTogether.onStatus(applyStatus);
window.watchTogether.onLog((line) => {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
});
