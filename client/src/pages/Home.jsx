import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom } from '../lib/api';

export default function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const room = await createRoom({ name: name || 'Family Watch Party', pin });
      navigate(`/room/${room.roomId}`, {
        state: { hostToken: room.hostToken, justCreated: true, displayName: name || 'Host' },
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleJoin(e) {
    e.preventDefault();
    if (!joinCode.trim()) return;
    navigate(`/room/${joinCode.trim()}`);
  }

  return (
    <div className="page">
      <h1>Watch Together</h1>
      <p className="subtitle">Share your personal videos with family and watch in sync, wherever they are.</p>

      <div className="cards">
        <form className="card" onSubmit={handleCreate}>
          <h2>Start a watch party</h2>
          <label>
            Room name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Priya & Raj's Wedding"
              maxLength={80}
            />
          </label>
          <label>
            PIN (optional)
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="4-6 digits, optional"
              maxLength={10}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create Room'}
          </button>
        </form>

        <form className="card" onSubmit={handleJoin}>
          <h2>Join a watch party</h2>
          <label>
            Room code
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Paste the room code"
            />
          </label>
          <button type="submit">Join Room</button>
        </form>
      </div>
    </div>
  );
}
