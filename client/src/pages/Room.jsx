import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import Hls from 'hls.js';
import { getRoom, uploadVideo, verifyPin, videoUrl, hlsPlaylistUrl } from '../lib/api';
import { getSocket } from '../lib/socket';

const SYNC_DRIFT_TOLERANCE = 1.5; // seconds
const SYNC_BROADCAST_INTERVAL = 4000; // ms, periodic correction while playing
const REACTION_EMOJIS = ['❤️', '😂', '😮', '👏', '🔥'];
const REACTION_LIFETIME = 2200; // ms, matches the float-up CSS animation

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
  const [playbackMode, setPlaybackMode] = useState('direct');
  const [transcode, setTranscode] = useState(null);
  const [error, setError] = useState('');
  const [reactions, setReactions] = useState([]);

  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [videoEl, setVideoEl] = useState(null);
  const socketRef = useRef(null);
  // Counts DOM events (play/pause/seeked) we're about to trigger ourselves by
  // applying a remote sync, so broadcastPlayback can tell them apart from a
  // genuine local user action and not echo them back to the room. A counter
  // (rather than a fixed timeout) is used because those events can legitimately
  // fire much later than expected on a slow connection — a seek in particular
  // has to fetch the new position over the network before 'seeked' fires.
  const suppressEventsRef = useRef(0);
  const chatEndRef = useRef(null);

  // Load room metadata
  useEffect(() => {
    getRoom(roomId)
      .then((info) => {
        setRoomInfo(info);
        setNeedsPin(info.requiresPin);
        setHasVideo(info.hasVideo);
        setPlaybackMode(info.playbackMode || 'direct');
        setTranscode(info.transcode || null);
      })
      .catch((err) => setError(err.message));
  }, [roomId]);

  const doJoin = useCallback(
    (pin) => {
      const socket = getSocket();
      socketRef.current = socket;

      const applyRemoteSync = (playback) => {
        const v = videoRef.current;
        if (!v || !playback) return;
        if (Math.abs(v.currentTime - playback.time) > SYNC_DRIFT_TOLERANCE) {
          v.currentTime = playback.time;
          suppressEventsRef.current += 1; // expect a 'seeked' once the new position loads
        }
        if (playback.playing && v.paused) {
          suppressEventsRef.current += 1; // expect a 'play'
          v.play().catch(() => {
            // Playback never actually started (e.g. blocked autoplay), so the
            // 'play' event we were expecting never fires — give the credit back.
            suppressEventsRef.current = Math.max(0, suppressEventsRef.current - 1);
          });
        } else if (!playback.playing && !v.paused) {
          suppressEventsRef.current += 1; // expect a 'pause'
          v.pause();
        }
      };

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
          setPlaybackMode(res.playbackMode || 'direct');
          setTranscode(res.transcode || null);
          applyRemoteSync(res.playback);
        });
      };
      const onDisconnect = () => setJoined(false);
      const onParticipants = (list) => setParticipants(list);
      const onVideoReady = (info) => {
        setHasVideo(true);
        setPlaybackMode(info?.playbackMode || 'direct');
        setTranscode(info?.transcode || null);
      };
      const onTranscodeProgress = (payload) => {
        setTranscode((prev) => ({ ...prev, ...payload, status: payload.error ? 'error' : payload.done ? 'done' : 'transcoding' }));
      };
      const onChatMessage = (msg) => setMessages((prev) => [...prev, msg]);
      const onPlaybackSync = (playback) => applyRemoteSync(playback);
      const onReaction = ({ emoji }) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const left = 10 + Math.random() * 80; // percent, keep clear of the edges
        setReactions((prev) => [...prev, { id, emoji, left }]);
        setTimeout(() => {
          setReactions((prev) => prev.filter((r) => r.id !== id));
        }, REACTION_LIFETIME);
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
      socket.on('transcode-progress', onTranscodeProgress);
      socket.on('chat-message', onChatMessage);
      socket.on('playback-sync', onPlaybackSync);
      socket.on('reaction', onReaction);

      socket.connect();

      return () => {
        socket.off('connect', joinRoom);
        socket.off('disconnect', onDisconnect);
        socket.off('participants-update', onParticipants);
        socket.off('video-ready', onVideoReady);
        socket.off('transcode-progress', onTranscodeProgress);
        socket.off('chat-message', onChatMessage);
        socket.off('reaction', onReaction);
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

  // Attach hls.js when the video needed converting (its codec wasn't
  // browser-playable). A direct-mode video just uses a plain <video src>,
  // set in the JSX below, so this effect only has work to do in 'hls' mode.
  //
  // Depends on videoEl (state, set via a callback ref) rather than reading
  // videoRef.current directly: hasVideo can flip true from the initial
  // getRoom() fetch before the name-entry screen is dismissed, i.e. before
  // the <video> tag is even rendered. Since none of [hasVideo, playbackMode,
  // roomId] change again once the video tag actually mounts, an effect keyed
  // on those alone would silently never re-run and never attach. videoEl
  // changes exactly when the DOM node itself appears, so it doesn't miss that.
  useEffect(() => {
    if (!hasVideo || playbackMode !== 'hls') return;
    const v = videoEl;
    if (!v) return;
    const src = hlsPlaylistUrl(roomId);

    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 6 });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(v);
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }
    // Safari plays HLS natively and doesn't need hls.js at all.
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
    }
  }, [videoEl, hasVideo, playbackMode, roomId]);

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
    if (!v) return;
    if (suppressEventsRef.current > 0) {
      suppressEventsRef.current -= 1;
      return;
    }
    socketRef.current?.emit('playback-update', { time: v.currentTime, playing: !v.paused });
  }

  function sendReaction(emoji) {
    socketRef.current?.emit('reaction', { emoji });
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !hostToken) return;
    setUploadProgress(0);
    setError('');
    try {
      const result = await uploadVideo(roomId, file, hostToken, setUploadProgress);
      // Direct-mode videos are playable immediately; HLS-mode ones need the
      // server to finish converting the first segment first — that arrives
      // via the 'video-ready' socket event (broadcast to the host too), so
      // hasVideo isn't set here for that case.
      if (result.playbackMode === 'direct') {
        setHasVideo(true);
      } else {
        setPlaybackMode('hls');
        setTranscode({ status: 'transcoding', percent: 0 });
      }
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
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus />
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
            <div className="player-wrap">
              <video
                ref={(el) => {
                  videoRef.current = el;
                  setVideoEl(el);
                }}
                className="player"
                src={playbackMode === 'direct' ? videoUrl(roomId) : undefined}
                controls
                onPlay={broadcastPlayback}
                onPause={broadcastPlayback}
                onSeeked={broadcastPlayback}
              />
              <div className="reaction-layer" aria-hidden="true">
                {reactions.map((r) => (
                  <span key={r.id} className="reaction-float" style={{ left: `${r.left}%` }}>
                    {r.emoji}
                  </span>
                ))}
              </div>
            </div>
          ) : transcode?.status === 'transcoding' ? (
            <div className="video-placeholder">Processing video for playback… {transcode.percent || 0}%</div>
          ) : (
            <div className="video-placeholder">Waiting for the host to upload the video…</div>
          )}

          {hasVideo && playbackMode === 'hls' && transcode && transcode.status !== 'done' && (
            <p className="transcode-note">
              {transcode.status === 'error'
                ? 'Background conversion hit an error — playback may stop partway through.'
                : `Still converting the rest in the background (${transcode.percent || 0}%) — jumping far ahead may need to buffer.`}
            </p>
          )}

          {hasVideo && (
            <div className="reaction-picker">
              {REACTION_EMOJIS.map((emoji) => (
                <button key={emoji} type="button" className="reaction-btn" onClick={() => sendReaction(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
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
