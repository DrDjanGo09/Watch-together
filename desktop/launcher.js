const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { fork, spawn } = require('child_process');
const QRCode = require('qrcode');

const PORT = 4000;
const TUNNEL_URL_RE = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

// Framework-free core of the desktop launcher: starts the server + a
// Cloudflare tunnel and reports back over a plain onLog callback, so it can
// run either inside Electron's main process or standalone under plain Node
// (for testing) without pulling in the `electron` module.
const STATUS_POLL_INTERVAL = 3000; // ms

function createLauncher({ resourceRoot, userDataDir, onLog, onRoomStatus }) {
  let serverProc = null;
  let tunnelProc = null;
  let statusInterval = null;

  function log(line) {
    if (onLog) onLog(line);
  }

  function fetchStatus() {
    http
      .get(`http://localhost:${PORT}/api/status`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (onRoomStatus) onRoomStatus(data.rooms || []);
          } catch {
            // transient — server may be mid-restart, just skip this tick
          }
        });
      })
      .on('error', () => {});
  }

  function startStatusPolling() {
    stopStatusPolling();
    fetchStatus();
    statusInterval = setInterval(fetchStatus, STATUS_POLL_INTERVAL);
  }

  function stopStatusPolling() {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
  }

  function resourcePath(...segments) {
    return path.join(resourceRoot, ...segments);
  }

  function downloadFile(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('Too many redirects downloading cloudflared'));
      https
        .get(url, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            resolve(downloadFile(res.headers.location, dest, redirects + 1));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve(dest)));
          file.on('error', reject);
        })
        .on('error', reject);
    });
  }

  async function ensureCloudflared() {
    const bundled = resourcePath('cloudflared.exe');
    if (fs.existsSync(bundled)) return bundled;

    const dest = path.join(userDataDir, 'cloudflared.exe');
    if (fs.existsSync(dest)) return dest;

    log('Downloading cloudflared (first run only)...');
    await downloadFile(
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
      dest
    );
    return dest;
  }

  function waitForServer(retries = 40) {
    return new Promise((resolve, reject) => {
      const attempt = (remaining) => {
        const req = http.get(`http://localhost:${PORT}/api/rooms/__healthcheck__`, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', () => {
          if (remaining <= 0) return reject(new Error('Server did not start in time'));
          setTimeout(() => attempt(remaining - 1), 250);
        });
      };
      attempt(retries);
    });
  }

  function startServerProcess() {
    return new Promise((resolve, reject) => {
      const entry = resourcePath('server', 'index.js');
      if (!fs.existsSync(entry)) {
        reject(new Error(`Server entry not found at ${entry}`));
        return;
      }
      serverProc = fork(entry, [], {
        cwd: path.dirname(entry),
        env: { ...process.env, PORT: String(PORT) },
        silent: true,
      });
      serverProc.stdout.on('data', (d) => log(`[server] ${d.toString().trim()}`));
      serverProc.stderr.on('data', (d) => log(`[server] ${d.toString().trim()}`));
      serverProc.on('exit', (code) => {
        log(`[server] exited (code ${code})`);
        serverProc = null;
      });
      serverProc.on('error', reject);

      waitForServer().then(resolve).catch(reject);
    });
  }

  async function startTunnel() {
    const cloudflaredPath = await ensureCloudflared();
    return new Promise((resolve, reject) => {
      tunnelProc = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${PORT}`]);
      let resolved = false;
      const onData = (d) => {
        const text = d.toString();
        log(`[tunnel] ${text.trim()}`);
        const match = text.match(TUNNEL_URL_RE);
        if (match && !resolved) {
          resolved = true;
          resolve(match[0]);
        }
      };
      tunnelProc.stdout.on('data', onData);
      tunnelProc.stderr.on('data', onData);
      tunnelProc.on('exit', (code) => {
        log(`[tunnel] exited (code ${code})`);
        tunnelProc = null;
        if (!resolved) reject(new Error('Tunnel closed before a link was issued'));
      });
      tunnelProc.on('error', reject);

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Timed out waiting for a tunnel link'));
        }
      }, 30000);
    });
  }

  function stopAll() {
    stopStatusPolling();
    if (tunnelProc) {
      tunnelProc.removeAllListeners('exit');
      tunnelProc.kill();
      tunnelProc = null;
    }
    if (serverProc) {
      serverProc.removeAllListeners('exit');
      serverProc.kill();
      serverProc = null;
    }
  }

  async function start() {
    log('Starting local server...');
    await startServerProcess();
    startStatusPolling();
    log('Server is up. Opening a public tunnel...');
    const url = await startTunnel();
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
    return { url, qrDataUrl };
  }

  function isRunning() {
    return Boolean(serverProc || tunnelProc);
  }

  return { start, stop: stopAll, isRunning };
}

module.exports = { createLauncher, PORT };
