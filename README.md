# Watch Together

Watch your own videos in sync with family and friends, wherever they are. Built for
sharing personal videos (like wedding videos) with relatives over the internet —
one person uploads the video, everyone joins the room link, and playback (play,
pause, seek) stays in sync for everyone, with a chat sidebar to react together.

## How it works

- **Server** (`/server`): Node.js + Express + Socket.io. Hosts rooms in memory,
  accepts a video upload from the room's host, streams it back out with HTTP
  Range support (so seeking works), and broadcasts play/pause/seek events to
  everyone in the room over WebSockets.
- **Client** (`/client`): React (Vite) app. Create or join a room, upload a video
  (host only), and watch together with a synced player and live chat.

Rooms are identified by an unguessable code embedded in the room link, optionally
protected by a PIN. There's no account system — it's built for sharing a link with
family, not for public use.

## Running locally

### 1. Start the server

```bash
cd server
npm install
npm run dev
```

Runs on `http://localhost:4000` by default. Uploaded videos are stored in
`server/uploads/` (not committed to git).

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
or opening ports on your router.

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
  that needs a Cloudflare account and a domain — ask if you want that set up instead.

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
- No voice chat yet — pair with a phone/video call for now if you want to talk
  while watching. WebRTC voice could be added later.
