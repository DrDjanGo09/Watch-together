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

export function uploadVideo(roomId, file, hostToken, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('video', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/rooms/${roomId}/upload`);
    xhr.setRequestHeader('x-host-token', hostToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Upload failed'));
      } catch {
        reject(new Error('Upload failed'));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(form);
  });
}

export function videoUrl(roomId) {
  return `${API_BASE}/api/rooms/${roomId}/video`;
}
