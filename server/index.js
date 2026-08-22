const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// In-memory room store. Fine for personal/family use with a single server instance.
// rooms: roomId -> { id, name, pin, hostToken, videoFile, videoOriginalName,
//   playback: { time, playing, updatedAt }, participants: Map(socketId -> name) }
const rooms = new Map();

function roomPublicInfo(room) {
  return {
    id: room.id,
    name: room.name,
    requiresPin: Boolean(room.pin),
    hasVideo: Boolean(room.videoFile),
    videoOriginalName: room.videoOriginalName || null,
  };
}

// --- Room management ---

app.post('/api/rooms', (req, res) => {
  const { name, pin } = req.body || {};
  const id = nanoid(10);
  const hostToken = nanoid(24);
  const room = {
    id,
    name: (name && String(name).trim()) || 'Family Watch Party',
    pin: pin ? String(pin).trim() : null,
    hostToken,
    videoFile: null,
    videoOriginalName: null,
    playback: { time: 0, playing: false, updatedAt: Date.now() },
    participants: new Map(),
  };
  rooms.set(id, room);
  res.json({ roomId: id, hostToken, ...roomPublicInfo(room) });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(roomPublicInfo(room));
});

app.post('/api/rooms/:roomId/verify-pin', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.pin) return res.json({ ok: true });
  const { pin } = req.body || {};
  if (String(pin || '').trim() === room.pin) return res.json({ ok: true });
  return res.status(403).json({ ok: false, error: 'Incorrect PIN' });
});

// --- Video upload (host only, authorized via hostToken from room creation) ---

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${req.params.roomId}-${nanoid(8)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 }, // 8GB cap, adjust as needed
});

app.post('/api/rooms/:roomId/upload', upload.single('video'), (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const hostToken = req.header('x-host-token');
  if (hostToken !== room.hostToken) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'Only the host can upload the video' });
  }
  if (!req.file) return res.status(400).json({ error: 'No video file received' });

  if (room.videoFile) {
    const oldPath = path.join(UPLOAD_DIR, room.videoFile);
    fs.unlink(oldPath, () => {});
  }

  room.videoFile = req.file.filename;
  room.videoOriginalName = req.file.originalname;
  room.playback = { time: 0, playing: false, updatedAt: Date.now() };

  io.to(room.id).emit('video-ready', { videoOriginalName: room.videoOriginalName });
  res.json({ ok: true, videoOriginalName: room.videoOriginalName });
});

// --- Video streaming with HTTP Range support ---

app.get('/api/rooms/:roomId/video', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room || !room.videoFile) return res.status(404).end();

  const filePath = path.join(UPLOAD_DIR, room.videoFile);
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = guessContentType(room.videoFile);

  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  const chunkSize = end - start + 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': contentType,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return (
    {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
    }[ext] || 'application/octet-stream'
  );
}

// --- Realtime sync via Socket.io ---

io.on('connection', (socket) => {
  let joinedRoomId = null;
  let displayName = null;

  socket.on('join-room', ({ roomId, name, pin }, ack) => {
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    if (room.pin && String(pin || '').trim() !== room.pin) {
      return ack?.({ ok: false, error: 'Incorrect PIN' });
    }

    joinedRoomId = roomId;
    displayName = (name && String(name).trim()) || 'Guest';
    socket.join(roomId);
    room.participants.set(socket.id, displayName);

    ack?.({
      ok: true,
      playback: room.playback,
      participants: [...room.participants.values()],
      ...roomPublicInfo(room),
    });

    socket.to(roomId).emit('participants-update', [...room.participants.values()]);
    socket.to(roomId).emit('chat-message', {
      system: true,
      text: `${displayName} joined`,
      ts: Date.now(),
    });
  });

  // Anyone in the room can control playback (simple model for a family watch party).
  socket.on('playback-update', ({ time, playing }) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;
    room.playback = { time, playing, updatedAt: Date.now() };
    socket.to(joinedRoomId).emit('playback-sync', room.playback);
  });

  socket.on('request-sync', (_, ack) => {
    if (!joinedRoomId) return ack?.(null);
    const room = rooms.get(joinedRoomId);
    ack?.(room ? room.playback : null);
  });

  socket.on('chat-message', ({ text }) => {
    if (!joinedRoomId || !text) return;
    io.to(joinedRoomId).emit('chat-message', {
      name: displayName,
      text: String(text).slice(0, 1000),
      ts: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;
    room.participants.delete(socket.id);
    socket.to(joinedRoomId).emit('participants-update', [...room.participants.values()]);
    socket.to(joinedRoomId).emit('chat-message', {
      system: true,
      text: `${displayName} left`,
      ts: Date.now(),
    });
  });
});

// --- Serve the built frontend (if present) so the whole app runs on one port ---
// Run `npm run build` in /client first; without a build, this is skipped and the
// frontend is expected to run separately (e.g. `npm run dev` in /client during development).
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
  console.log('Serving built frontend from client/dist');
}

server.listen(PORT, () => {
  console.log(`Watch-together server listening on port ${PORT}`);
});
