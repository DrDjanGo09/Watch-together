import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { getRoom, uploadVideo, verifyPin, videoUrl } from '../lib/api';
import { getSocket } from '../lib/socket';

const SYNC_DRIFT_TOLERANCE = 1.5; // seconds
const SYNC_BROADCAST_INTERVAL = 4000; // ms, periodic correction while playing

export default function Room() {
  const { roomId } = useParams();
  const location = useLocation();
  const hostToken = location.state?.hostToken || null;
  const isHost = Boolean(hostToken);

  const [roomInfo, setRoomInfo] = useState(null);
  const [needsPin, setNeedsPin] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [displayName, setDisplayName] = useState(location.state?.displayName || '');
  const [nameConfirmed, setNameConfirmed] = useState(Boolean(location.state?.justCreated));
  const [joined, setJoined] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [uploadProgress, setUploadProgress] = useState(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [error, setError] = useState('');

  const videoRef = useRef(null);
  const socketRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const chatEndRef = useRef(null);

  // Load room metadata
  useEffect(() => {
    getRoom(roomId)
      .then((info) => {
        setRoomInfo(info);
        setNeedsPin(info.requiresPin);
        setHasVideo(info.hasVideo);
      })
      .catch((err) => setError(err.message));
  }, [roomId]);

  const doJoin = useCallback(
    (pin) => {
      const socket = getSocket();
      socketRef.current = socket;

      const joinRoom = () => {
        socket.emit('join-room', { roomId, name: displayName, pin }, (res) => {
          if (!res?.ok) {
            setError(res?.error || 'Could not join room');
            socket.disconnect();
            return;
          }
          setJoined(true);
          setParticipants(res.participants || []);
          setHasVideo(res.hasVideo);
          if (videoRef.current && res.playback) {
            applyingRemoteRef.current = true;
            videoRef.current.currentTime = res.playback.time || 0;
            if (res.playback.playing) videoRef.current.play().catch(() => {});
            setTimeout(() => (applyingRemoteRef.current = false), 300);
          }
        });
      };
      const onDisconnect = () => setJoined(false);
      const onParticipants = (list) => setParticipants(list);
      const onVideoReady = () => setHasVideo(true);
      const onChatMessage = (msg) => setMessages((prev) => [...prev, msg]);
      const onPlaybackSync = (playback) => {
        const v = videoRef.current;
        if (!v) return;
        applyingRemoteRef.current = true;
        if (Math.abs(v.currentTime - playback.time) > SYNC_DRIFT_TOLERANCE) {
          v.currentTime = playback.time;
        }
        if (playback.playing && v.paused) v.play().catch(() => {});
        if (!playback.playing && !v.paused) v.pause();
        setTimeout(() => (applyingRemoteRef.current = false), 300);
      };

      // Re-join on every 'connect', not just the first one: the socket auto-
      // reconnects after a dropped connection (flaky wifi, tunnel hiccup), but
      // that reconnect is anonymous until we re-send join-room. Without this,
      // a reconnected device's <video> keeps playing locally (it's a plain
      // HTML5 element, independent of the socket) while silently falling out
      // of sync with everyone else.
      socket.on('connect', joinRoom);
      socket.on('disconnect', onDisconnect);
      socket.on('participants-update', onParticipants);
      socket.on('video-ready', onVideoReady);
      socket.on('chat-message', onChatMessage);
      socket.on('playback-sync', onPlaybackSync);

      socket.connect();

      return () => {
        socket.off('connect', joinRoom);
        socket.off('disconnect', onDisconnect);
        socket.off('participants-update', onParticipants);
        socket.off('video-ready', onVideoReady);
        socket.off('chat-message', onChatMessage);
        socket.off('playback-sync', onPlaybackSync);
      };
    },
    [roomId, displayName]
  );

  useEffect(() => {
    if (!nameConfirmed || !roomInfo || needsPin) return;
    const removeListeners = doJoin(undefined);
    return () => {
      removeListeners();
      socketRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameConfirmed, roomInfo, needsPin]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handlePinSubmit(e) {
    e.preventDefault();
    try {
      await verifyPin(roomId, pinInput);
      setNeedsPin(false);
      if (nameConfirmed) doJoin(pinInput);
    } catch (err) {
      setError(err.message);
    }
  }

  function handleNameSubmit(e) {
    e.preventDefault();
    if (!displayName.trim()) return;
    setNameConfirmed(true);
    if (!needsPin) doJoin(pinInput || undefined);
  }

  function broadcastPlayback() {
    const v = videoRef.current;
    if (!v || applyingRemoteRef.current) return;
    socketRef.current?.emit('playback-update', { time: v.currentTime, playing: !v.paused });
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !hostToken) return;
    setUploadProgress(0);
    setError('');
    try {
      await uploadVideo(roomId, file, hostToken, setUploadProgress);
      setHasVideo(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploadProgress(null);
    }
  }

  function sendChat(e) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    socketRef.current?.emit('chat-message', { text: chatInput.trim() });
    setChatInput('');
  }

  // Periodic gentle correction broadcast while playing (helps late joiners / drift)
  useEffect(() => {
    if (!joined) return;
    const id = setInterval(() => {
      const v = videoRef.current;
      if (v && !v.paused) broadcastPlayback();
    }, SYNC_BROADCAST_INTERVAL);
    return () => clearInterval(id);
  }, [joined]);

  if (!roomInfo && !error) return <div className="page">Loading room…</div>;
  if (error && !roomInfo) return <div className="page error">{error}</div>;

  if (!nameConfirmed) {
    return (
      <div className="page">
        <h2>{roomInfo.name}</h2>
        <form className="card" onSubmit={handleNameSubmit}>
          <label>
            Your name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Aunt Meera" autoFocus />
          </label>
          <button type="submit">Continue</button>
        </form>
      </div>
    );
  }

  if (needsPin) {
    return (
      <div className="page">
        <h2>{roomInfo.name}</h2>
        <form className="card" onSubmit={handlePinSubmit}>
          <label>
            Enter PIN
            <input value={pinInput} onChange={(e) => setPinInput(e.target.value)} autoFocus />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit">Join</button>
        </form>
      </div>
    );
  }

  return (
    <div className="room">
      <div className="room-header">
        <h2>{roomInfo.name}</h2>
        <div className="room-code">
          Room code: <code>{roomId}</code>
          <button
            type="button"
            className="link-btn"
            onClick={() => navigator.clipboard?.writeText(window.location.href)}
          >
            Copy link
          </button>
        </div>
      </div>

      {!joined && <div className="reconnect-banner">Reconnecting… your video keeps playing, but is temporarily out of sync with the room.</div>}

      <div className="room-body">
        <div className="video-column">
          {isHost && !hasVideo && (
            <div className="card">
              <h3>Upload the video</h3>
              <input type="file" accept="video/*" onChange={handleUpload} />
              {uploadProgress !== null && <p>Uploading… {uploadProgress}%</p>}
            </div>
          )}

          {hasVideo ? (
            <video
              ref={videoRef}
              className="player"
              src={videoUrl(roomId)}
              controls
              onPlay={broadcastPlayback}
              onPause={broadcastPlayback}
              onSeeked={broadcastPlayback}
            />
          ) : (
            <div className="video-placeholder">Waiting for the host to upload the video…</div>
          )}
          {error && <p className="error">{error}</p>}
        </div>

        <div className="side-column">
          <div className="card participants">
            <h3>Watching now ({participants.length})</h3>
            <ul>
              {participants.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>

          <div className="card chat">
            <h3>Chat</h3>
            <div className="chat-messages">
              {messages.map((m, i) => (
                <div key={i} className={m.system ? 'chat-system' : 'chat-line'}>
                  {m.system ? m.text : (
                    <>
                      <strong>{m.name}: </strong>
                      {m.text}
                    </>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form onSubmit={sendChat} className="chat-form">
              <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Say something…" />
              <button type="submit">Send</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
