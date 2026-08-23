# Watch Together

Watch your own videos in sync with family and friends, wherever they are. Built for
sharing personal videos (like wedding videos) with relatives over the internet —
one person uploads the video, everyone joins the room link, and playback (play,
pause, seek) stays in sync for everyone, with a chat sidebar and quick emoji
reactions to react together.

## How it works

- **Server** (`/server`): Node.js + Express + Socket.io. Hosts rooms in memory,
  accepts a video upload from the room's host in chunks (works around the ~100MB
  single-request cap that free tunnel/proxy services impose), streams it back out
  with HTTP Range support (so seeking works), and broadcasts play/pause/seek,
  chat, and reactions to everyone in the room over WebSockets. If the uploaded
  file's codec isn't one browsers can play directly (common with `.mkv`, HEVC,
  etc.), it's transcoded to HLS in the background — playback starts as soon as
  the first few seconds are ready rather than waiting for the whole file. Devices
  that drop and regain their connection (flaky wifi, tunnel hiccup) automatically
  resync instead of drifting.
- **Client** (`/client`): React (Vite) app. Create or join a room, upload a video
  (host only), and watch together with a synced player, live chat, and reactions.
- **Desktop app** (`/desktop`): an Electron launcher for Windows — start/stop the
  server and a public link with one click, no terminal window. Shows a shareable
  link and QR code, live "who's watching" status, and minimizes to the system
  tray instead of quitting when you close the window. Doesn't require Node.js to
  be installed separately (it runs the server through Electron's own bundled
  runtime).

Rooms are identified by an unguessable code embedded in the room link, optionally
protected by a PIN. There's no account system — it's built for sharing a link with
family, not for public use.

## Quick start

### Option A: Desktop app (Windows, easiest)

No terminal, no manual steps. From `/desktop`:

```bash
cd desktop
npm install
npm run dist      # builds an installer at desktop/dist/Watch Together Setup *.exe
```

Run the installer, open "Watch Together" from the Start Menu, click **Start Watch
Party**. It shows a shareable link and QR code — send that to your relatives.
Closing the window keeps the party running in the system tray; use the tray
menu's **Quit** to fully stop it.

(For development instead of building an installer: `npm start` in `/desktop` runs
it directly via Electron.)

### Option B: One-command script (macOS/Linux, or Windows without the desktop app)

Installs dependencies, builds the app, starts the server, and opens a Cloudflare
Tunnel — all in one go.

- **macOS**: double-click `start.command` (or run `./start.sh` in Terminal)
- **Linux**: run `./start.sh` in a terminal
- **Windows**: double-click `start.bat`

Requires [Node.js](https://nodejs.org) (LTS) to already be installed. The script
downloads `cloudflared` automatically if it's missing. When it's running, it
prints a public `https://....trycloudflare.com` link — that's what you share
with your relatives. Press Ctrl+C (or close the window on Windows) to stop
everything when you're done.

Both options use the same underlying mechanism — see
[Sharing it with relatives over the internet](#sharing-it-with-relatives-over-the-internet-cloudflare-tunnel)
below for what that's doing and its limitations (temporary link, your computer
needs to stay on).

## Running locally (manual / development)

### 1. Start the server

```bash
cd server
npm install
npm run dev
```

Runs on `http://localhost:4000` by default. Uploaded videos are stored in
`server/uploads/` (not committed to git). Transcoding incompatible videos
requires `ffmpeg` and `ffprobe` on your `PATH` — if they're not found, the
server just streams the original file as-is instead (see
[Video codec compatibility](#video-codec-compatibility) below).

### 2. Start the client

```bash
cd client
npm install
cp .env.example .env   # points the client at the server URL
npm run dev
```

Runs on `http://localhost:5173` by default.

### 3. Try it out

1. Open the client, create a room (optionally with a PIN), and you'll land in the
   room as the host.
2. Upload your video file.
3. Copy the room link and send it to your relatives. They open it, enter their
   name (and the PIN if you set one), and watch in sync with you.

## Sharing it with relatives over the internet (Cloudflare Tunnel)

The server runs on your own machine (`localhost`), which relatives can't reach
directly. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
exposes it with a public `https://` link, without needing a domain, a static IP,
or opening ports on your router. The desktop app and the one-command scripts both
do this automatically; the steps below are for doing it manually.

This runs on **your machine** (wherever you're running the server) — Cloudflare's
CLI (`cloudflared`) needs to run alongside the app itself.

### 1. Build the app to run on a single port

For tunneling, it's simplest to have one process serving everything (frontend +
API + WebSockets) on one port, instead of the two-process dev setup:

```bash
cd client
npm install
npm run build        # produces client/dist — do NOT create a client/.env file for this

cd ../server
npm install
npm start             # serves the app (frontend + API + sockets) on http://localhost:4000
```

Leave this running. Open `http://localhost:4000` locally to confirm it works
before moving on.

### 2. Install cloudflared

- **macOS**: `brew install cloudflare/cloudflare/cloudflared`
- **Windows**: `winget install --id Cloudflare.cloudflared`
- **Linux**: see [Cloudflare's install docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for your distro (`.deb`/`.rpm`/binary)

### 3. Start the tunnel

In a second terminal, with the server still running:

```bash
cloudflared tunnel --url http://localhost:4000
```

Cloudflared prints a public link like `https://random-two-words.trycloudflare.com`
— that's the link to share with your relatives. No Cloudflare account needed.

**Things to know about this "Quick Tunnel":**
- The link is temporary — it changes every time you stop and restart the
  `cloudflared` command, so re-share it if you restart.
- Your computer needs to stay on and connected for as long as anyone might want
  to watch (the server and the tunnel both run locally).
- Good for a one-off watch party. If you want a permanent link that doesn't change,
  that needs a Cloudflare account (free) and a one-time `cloudflared tunnel login`
  — ask if you want that set up instead.

## Video codec compatibility

Browsers only play certain codecs natively (H.264 video + AAC/MP3 audio is safe
everywhere). A video with anything else — common with `.mkv` files, HEVC, VP9/Opus,
etc. — would otherwise just silently fail to play. To handle this, the server:

1. Probes the uploaded file's actual codec with `ffprobe`.
2. If it's already browser-compatible, streams it as-is (no change from before).
3. Otherwise, transcodes it to HLS in the background with `ffmpeg`. Playback
   becomes available as soon as the first segment is ready (typically seconds,
   not the full transcode time), while the rest keeps converting. The client uses
   `hls.js` for this in Chrome/Firefox (Safari plays HLS natively).

This requires `ffmpeg`/`ffprobe` to be installed and on `PATH` on whichever
machine is running the server. It is **not** currently bundled into the desktop
app's installer (unlike `cloudflared.exe`, which is) — if it's missing, transcoding
is skipped and the original file streams as-is (which may not play for everyone,
depending on the codec).

## Notes & next steps

- Video files are stored on local disk on the server — fine for running on your
  own machine or a small VPS. For a larger file library, swap the storage layer
  for S3-compatible object storage.
- Room state lives in memory, so restarting the server clears active rooms
  (uploaded files on disk are preserved).
- Anyone in a room can control playback (play/pause/seek) — matches a casual
  family watch-party feel. If you want the host to be the only one in control,
  the socket handler in `server/index.js` (`playback-update`) is where to add
  that restriction.
- The Quick Tunnel link is temporary and changes on every restart, and there's no
  automatic recovery if the tunnel connection drops mid-party — both would be
  solved by a named Cloudflare Tunnel (stable URL, free account required) plus
  retry logic in `desktop/launcher.js`.
- `ffmpeg`/`ffprobe` aren't bundled with the desktop app yet (see
  [Video codec compatibility](#video-codec-compatibility)) — bundling them the
  same way `cloudflared.exe` is would remove that manual dependency.
- No voice chat yet — pair with a phone/video call for now if you want to talk
  while watching. WebRTC voice could be added later.
