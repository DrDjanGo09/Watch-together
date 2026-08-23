const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

// Codecs the HTML5 <video> element can play directly in Chrome/Firefox/Edge
// without any conversion — matches most phone/camera exports, so this keeps
// the common case exactly as fast as plain progressive streaming.
const COMPATIBLE_VIDEO_CODECS = new Set(['h264']);
const COMPATIBLE_AUDIO_CODECS = new Set(['aac', 'mp3']);

let ffmpegAvailable = null; // cached tri-state: null = not checked yet

function checkAvailable() {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    const ffmpeg = spawnSync('ffmpeg', ['-version']);
    const ffprobe = spawnSync('ffprobe', ['-version']);
    ffmpegAvailable = ffmpeg.status === 0 && ffprobe.status === 0;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

// Inspects the uploaded file's actual codecs. If ffprobe is unavailable or
// the file can't be parsed, fails open (treats it as compatible) rather than
// forcing a transcode we can't reliably justify — direct streaming is the
// fallback behavior this app already had before transcoding existed.
function probeCompatibility(filePath) {
  return new Promise((resolve) => {
    if (!checkAvailable()) return resolve({ compatible: true, duration: 0 });

    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve({ compatible: true, duration: 0 }));
    proc.on('exit', (code) => {
      if (code !== 0) return resolve({ compatible: true, duration: 0 });
      try {
        const data = JSON.parse(out);
        const streams = data.streams || [];
        const videoStream = streams.find((s) => s.codec_type === 'video');
        const audioStream = streams.find((s) => s.codec_type === 'audio');
        const duration = parseFloat(data.format?.duration) || 0;

        const videoOk = !videoStream || COMPATIBLE_VIDEO_CODECS.has(videoStream.codec_name);
        const audioOk = !audioStream || COMPATIBLE_AUDIO_CODECS.has(audioStream.codec_name);
        resolve({ compatible: videoOk && audioOk, duration });
      } catch {
        resolve({ compatible: true, duration: 0 });
      }
    });
  });
}

const SEGMENT_RE = /^seg\d{5}\.ts$/;

function isValidSegmentName(name) {
  return SEGMENT_RE.test(name);
}

// Transcodes to HLS (H.264/AAC segments + a growing playlist) so playback
// can start as soon as the first segment exists, while the rest of the video
// keeps converting in the background. hls_playlist_type "event" tells the
// muxer to append segments to the playlist as they finish rather than
// rewriting it, which is what lets a player follow it while it's still growing.
function startHlsTranscode(filePath, outputDir, { duration, onFirstSegment, onProgress, onDone, onError }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const playlistPath = path.join(outputDir, 'playlist.m3u8');

  const proc = spawn('ffmpeg', [
    '-y',
    '-i', filePath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(outputDir, 'seg%05d.ts'),
    playlistPath,
  ]);

  let firstSegmentFired = false;
  let watcher = null;

  function checkFirstSegment() {
    if (firstSegmentFired) return;
    fs.readFile(playlistPath, 'utf8', (err, content) => {
      if (err) return;
      if (content.includes('.ts')) {
        firstSegmentFired = true;
        if (watcher) watcher.close();
        onFirstSegment?.();
      }
    });
  }

  // Poll rather than fs.watch: network filesystems and some editors don't
  // reliably fire watch events on every write, and this file is tiny.
  watcher = setInterval(checkFirstSegment, 500);

  const TIME_RE = /time=(\d+):(\d+):(\d+)\.\d+/;
  proc.stderr.on('data', (chunk) => {
    const match = chunk.toString().match(TIME_RE);
    if (match && duration > 0) {
      const [, h, m, s] = match;
      const elapsed = Number(h) * 3600 + Number(m) * 60 + Number(s);
      onProgress?.(Math.min(99, Math.round((elapsed / duration) * 100)));
    }
  });

  proc.on('exit', (code) => {
    clearInterval(watcher);
    if (code === 0) {
      // Covers very short videos that finish before the first poll tick —
      // done synchronously (not via checkFirstSegment's async fs.readFile)
      // so onFirstSegment is guaranteed to run before onDone below, not
      // racing it and clobbering 'done' back to 'ready' moments later.
      if (!firstSegmentFired) {
        try {
          const content = fs.readFileSync(playlistPath, 'utf8');
          if (content.includes('.ts')) {
            firstSegmentFired = true;
            onFirstSegment?.();
          }
        } catch {
          // playlist never got any content — fall through, onDone below still fires
        }
      }
      onDone?.();
    } else {
      onError?.(new Error(`ffmpeg exited with code ${code}`));
    }
  });
  proc.on('error', (err) => {
    clearInterval(watcher);
    onError?.(err);
  });

  return proc;
}

module.exports = { checkAvailable, probeCompatibility, startHlsTranscode, isValidSegmentName };
