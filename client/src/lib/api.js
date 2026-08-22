// Empty string = same origin as the page (used for the production build, served by
// the Express server itself). Set VITE_API_BASE in client/.env for the two-process
// dev workflow (Vite on 5173, API server on 4000).
export const API_BASE = import.meta.env.VITE_API_BASE || '';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

export function createRoom({ name, pin }) {
  return request('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
}

export function getRoom(roomId) {
  return request(`/api/rooms/${roomId}`);
}

export function verifyPin(roomId, pin) {
  return request(`/api/rooms/${roomId}/verify-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
}

// Uploaded in ~20MB chunks rather than one request: services that proxy the app
// (e.g. Cloudflare, including free Tunnels) cap individual request bodies at
// ~100MB, which a multi-GB video would exceed in a single-shot upload.
const CHUNK_SIZE = 20 * 1024 * 1024;

function uploadChunk(roomId, uploadId, chunkBlob, hostToken) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('chunk', chunkBlob);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/rooms/${roomId}/upload/chunk?uploadId=${uploadId}`);
    xhr.setRequestHeader('x-host-token', hostToken);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        try {
          reject(new Error(JSON.parse(xhr.responseText).error || 'Chunk upload failed'));
        } catch {
          reject(new Error('Chunk upload failed'));
        }
      }
    };
    xhr.onerror = () => reject(new Error('Chunk upload failed'));
    xhr.send(form);
  });
}

export async function uploadVideo(roomId, file, hostToken, onProgress) {
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let uploaded = 0;

  for (let start = 0; start < file.size; start += CHUNK_SIZE) {
    const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
    await uploadChunk(roomId, uploadId, chunk, hostToken);
    uploaded += chunk.size;
    if (onProgress) onProgress(Math.round((uploaded / file.size) * 100));
  }

  return request(`/api/rooms/${roomId}/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-host-token': hostToken },
    body: JSON.stringify({ uploadId, originalName: file.name }),
  });
}

export function videoUrl(roomId) {
  return `${API_BASE}/api/rooms/${roomId}/video`;
}
