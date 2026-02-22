const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn, exec } = require('child_process');

const PORT = 3000;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CONFIG_PATH = path.join(__dirname, 'server.config.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const activeDownloads = new Map();

function nowId() {
  return String(Date.now()) + '_' + Math.random().toString(36).slice(2, 8);
}

function defaultDownloadDir() {
  return path.join(os.homedir(), 'Downloads');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function getDownloadDir() {
  const cfg = loadConfig();
  const dir = cfg.downloadDir && String(cfg.downloadDir).trim() ? String(cfg.downloadDir).trim() : defaultDownloadDir();
  ensureDir(dir);
  return dir;
}

function setDownloadDir(dir) {
  const nextDir = dir && String(dir).trim() ? String(dir).trim() : defaultDownloadDir();
  ensureDir(nextDir);
  const cfg = loadConfig();
  cfg.downloadDir = nextDir;
  saveConfig(cfg);
  return nextDir;
}

function sanitizeFilename(name) {
  const s = String(name || 'video')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || ('video_' + Date.now());
}

function uniqueOutputPath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  let n = 1;
  while (true) {
    const candidate = `${base} (${n})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
    n += 1;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTimeSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function broadcastProgress(downloadId, payload) {
  const msg = JSON.stringify({ type: 'progress', downloadId, ...payload });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch (e) {}
    }
  });
}

function ffmpegHeadersArg(headers) {
  const lines = [];
  if (headers.referer) lines.push(`Referer: ${headers.referer}`);
  if (headers.origin) lines.push(`Origin: ${headers.origin}`);
  if (headers.cookie) lines.push(`Cookie: ${headers.cookie}`);
  if (headers.userAgent) lines.push(`User-Agent: ${headers.userAgent}`);
  if (!lines.length) return null;
  return lines.join('\r\n') + '\r\n';
}

async function fetchText(url, headers, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

function parseMasterM3U8(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const variants = [];
  const audioGroups = {};
  const subtitleGroups = {};

  function parseAttributeList(raw) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    let m;
    while ((m = re.exec(raw || '')) !== null) {
      const key = m[1];
      const value = m[2];
      out[key] = value && value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value;
    }
    return out;
  }

  function appendQueryParams(sourceUrl, targetUrl) {
    try {
      const source = new URL(sourceUrl, targetUrl);
      const target = new URL(targetUrl, source);
      if (!source.search || source.search === '?') return target.href;
      const sourceParams = new URLSearchParams(source.search);
      const targetParams = new URLSearchParams(target.search);
      let changed = false;
      sourceParams.forEach((value, key) => {
        if (!targetParams.has(key)) {
          targetParams.append(key, value);
          changed = true;
        }
      });
      if (!changed) return target.href;
      target.search = targetParams.toString();
      return target.href;
    } catch (e) {
      return targetUrl;
    }
  }

  function resolveWithMasterParams(targetUrl) {
    try {
      const absolute = targetUrl.startsWith('http') ? targetUrl : new URL(targetUrl, baseUrl).href;
      return appendQueryParams(baseUrl, absolute);
    } catch (e) {
      return targetUrl;
    }
  }

  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const attrs = parseAttributeList(line.replace(/^#EXT-X-MEDIA:/i, ''));
    const type = String(attrs.TYPE || '').toUpperCase();
    const groupId = attrs['GROUP-ID'];
    const uri = attrs.URI;
    const lang = attrs.LANGUAGE;
    const name = attrs.NAME;
    const isDefault = String(attrs.DEFAULT || '').toUpperCase() === 'YES';
    if (!type || !groupId || !uri) continue;
    const abs = resolveWithMasterParams(uri);
    const track = {
      url: abs,
      language: lang || 'und',
      name: name || (lang || 'Default'),
      isDefault
    };
    if (type === 'AUDIO') {
      if (!audioGroups[groupId]) audioGroups[groupId] = [];
      audioGroups[groupId].push(track);
    } else if (type === 'SUBTITLES') {
      if (!subtitleGroups[groupId]) subtitleGroups[groupId] = [];
      subtitleGroups[groupId].push(track);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributeList(lines[i].replace(/^#EXT-X-STREAM-INF:/i, ''));
    const bw = parseInt(attrs.BANDWIDTH || '0', 10) || 0;
    const res = attrs.RESOLUTION || 'unknown';
    const audioGroup = attrs.AUDIO || null;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j] || lines[j].startsWith('#')) continue;
      const variantUrl = resolveWithMasterParams(lines[j]);
      const gid = audioGroup;
      const tracks = gid && audioGroups[gid] ? audioGroups[gid] : [];
      const defaultTrack = tracks.find(t => t.isDefault) || tracks[0] || null;
      variants.push({
        bandwidth: bw,
        resolution: res,
        url: variantUrl,
        audioUrl: defaultTrack ? defaultTrack.url : null,
        audioGroupId: gid
      });
      break;
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { variants, audioGroups, subtitleGroups };
}

function parseDashMpd(text, mpdUrl) {
  const qualities = [];
  const audioTracks = [];
  const adaptationRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
  let videoIdx = 0;
  let audioIdx = 0;

  function attrs(s) {
    const out = {};
    const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(s || '')) !== null) out[m[1]] = m[2];
    return out;
  }

  let a;
  while ((a = adaptationRe.exec(text)) !== null) {
    const asAttrs = attrs(a[1]);
    const body = a[2] || '';
    const mime = (asAttrs.mimeType || '').toLowerCase();
    const contentType = (asAttrs.contentType || '').toLowerCase();
    const isVideo = contentType === 'video' || mime.startsWith('video/');
    const isAudio = contentType === 'audio' || mime.startsWith('audio/');
    if (!isVideo && !isAudio) continue;

    const repRe = /<Representation\b([^>]*?)\/?>/gi;
    let r;
    while ((r = repRe.exec(body)) !== null) {
      const rep = attrs(r[1]);
      const bw = parseInt(rep.bandwidth || '0', 10) || 0;
      const width = parseInt(rep.width || '0', 10) || 0;
      const height = parseInt(rep.height || '0', 10) || 0;
      const id = rep.id || null;
      const label = height ? `${height}p` : 'Unknown';
      if (isVideo) {
        qualities.push({
          label: `DASH ${label} (${Math.round(bw / 1000)} kbps)`,
          url: mpdUrl,
          bandwidth: bw,
          resolution: (width && height) ? `${width}x${height}` : 'unknown',
          dashVideoIndex: videoIdx,
          dashVideoId: id,
          dashAudioIndex: null,
          dashAudioId: null,
          audioUrl: null,
          format: ((rep.mimeType || asAttrs.mimeType || '').includes('webm') ? 'webm' : 'mp4')
        });
        videoIdx += 1;
      } else if (isAudio) {
        audioTracks.push({
          url: mpdUrl,
          language: asAttrs.lang || 'und',
          name: (asAttrs.lang || 'audio').toUpperCase(),
          isDefault: audioIdx === 0,
          dashAudioIndex: audioIdx,
          dashAudioId: id
        });
        audioIdx += 1;
      }
    }
  }

  if (audioTracks.length > 0) {
    for (const q of qualities) {
      q.dashAudioIndex = audioTracks[0].dashAudioIndex;
      q.dashAudioId = audioTracks[0].dashAudioId;
    }
  }

  return { qualities, audioTracks };
}

async function ffprobeDuration(inputUrl, headersArg) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1'];
    if (headersArg) args.push('-headers', headersArg);
    args.push(inputUrl);

    const p = spawn('ffprobe', args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.on('close', () => {
      const n = Number(String(out).trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
    p.on('error', () => resolve(null));
  });
}

function openPath(targetPath, selectFile) {
  const p = String(targetPath || '');
  if (process.platform === 'win32') {
    const cmd = selectFile ? `explorer /select,"${p}"` : `explorer "${p}"`;
    exec(cmd, () => {});
  } else if (process.platform === 'darwin') {
    const cmd = selectFile ? `open -R "${p}"` : `open "${p}"`;
    exec(cmd, () => {});
  } else {
    const toOpen = selectFile ? path.dirname(p) : p;
    exec(`xdg-open "${toOpen}"`, () => {});
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/server-info', (req, res) => {
  res.json({
    downloadDir: getDownloadDir(),
    ffmpeg: true,
    ffprobe: true,
    platform: process.platform
  });
});

app.get('/download-dir', (req, res) => {
  res.json({ dir: getDownloadDir() });
});

app.post('/download-dir', (req, res) => {
  try {
    const next = setDownloadDir(req.body && req.body.dir ? req.body.dir : '');
    res.json({ success: true, dir: next });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.get('/open-folder', (req, res) => {
  const dir = getDownloadDir();
  openPath(dir, false);
  res.json({ success: true });
});

app.get('/open-file/:filename', (req, res) => {
  const fp = path.join(getDownloadDir(), path.basename(req.params.filename || ''));
  if (!fs.existsSync(fp)) return res.status(404).json({ success: false, error: 'File not found' });
  openPath(fp, true);
  res.json({ success: true });
});

app.get('/play/:filename', (req, res) => {
  const fp = path.join(getDownloadDir(), path.basename(req.params.filename || ''));
  if (!fs.existsSync(fp)) return res.status(404).send('File not found');

  const stat = fs.statSync(fp);
  const range = req.headers.range;
  const ext = path.extname(fp).toLowerCase();
  const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const size = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': size,
      'Content-Type': contentType
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType
    });
    fs.createReadStream(fp).pipe(res);
  }
});

app.get('/downloads', (req, res) => {
  const dir = getDownloadDir();
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => /\.(mp4|webm|mkv|mov|avi|m4a|mp3)$/i.test(f))
      .map(f => {
        const fp = path.join(dir, f);
        const st = fs.statSync(fp);
        return {
          filename: f,
          size: st.size,
          sizeText: formatBytes(st.size),
          modifiedAt: st.mtimeMs
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch (e) {}
  res.json({ files });
});

app.get('/active-downloads', (req, res) => {
  const active = Array.from(activeDownloads.values()).map(d => ({
    downloadId: d.downloadId,
    filename: d.filename,
    sourceUrl: d.sourceUrl,
    status: d.status,
    percent: d.percent || 0,
    currentTime: d.currentTime || '0:00',
    totalTime: d.totalTime || '--:--',
    speed: d.speed || '--',
    eta: d.eta || '--'
  }));
  res.json({ active });
});

app.post('/qualities', async (req, res) => {
  const { url, referer, origin, cookie, userAgent } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const headers = {
    'User-Agent': userAgent || DEFAULT_UA
  };
  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;

  try {
    const text = await fetchText(url, headers);
    const isHls = text.includes('#EXTM3U');
    const isDash = /<\s*MPD\b/i.test(text);

    if (!isHls && !isDash) {
      return res.json({ qualities: [{ label: 'Default', url, bandwidth: 0, resolution: 'unknown' }], audioTracks: [], audioGroupMap: null, subtitleTracks: [] });
    }

    if (isDash) {
      const dash = parseDashMpd(text, url);
      if (dash.qualities.length > 0) {
        return res.json({ qualities: dash.qualities, audioTracks: dash.audioTracks, audioGroupMap: null, subtitleTracks: [] });
      }
      return res.json({ qualities: [{ label: 'DASH Default', url, bandwidth: 0, resolution: 'unknown' }], audioTracks: [], audioGroupMap: null, subtitleTracks: [] });
    }

    if (text.includes('#EXT-X-STREAM-INF:')) {
      const { variants, audioGroups, subtitleGroups } = parseMasterM3U8(text, url);
      const qualities = variants.map(v => {
        const h = Number((v.resolution || '').split('x')[1] || 0);
        let label = 'unknown';
        if (h >= 2160) label = '2160p';
        else if (h >= 1440) label = '1440p';
        else if (h >= 1080) label = '1080p';
        else if (h >= 720) label = '720p';
        else if (h >= 480) label = '480p';
        else if (h >= 360) label = '360p';
        else if (h >= 240) label = '240p';
        label = `${label} (${Math.round((v.bandwidth || 0) / 1000)} kbps)`;
        return { label, url: v.url, bandwidth: v.bandwidth || 0, resolution: v.resolution || 'unknown', audioUrl: v.audioUrl || null, audioGroupId: v.audioGroupId || null };
      });

      const audioTracks = [];
      const seenLang = new Set();
      for (const gid of Object.keys(audioGroups)) {
        for (const t of audioGroups[gid]) {
          const key = t.language || t.name;
          if (seenLang.has(key)) continue;
          seenLang.add(key);
          audioTracks.push({ url: t.url, language: t.language, name: t.name, isDefault: t.isDefault, groupId: gid });
        }
      }

      const audioGroupMap = {};
      for (const gid of Object.keys(audioGroups)) {
        audioGroupMap[gid] = {};
        for (const t of audioGroups[gid]) {
          audioGroupMap[gid][t.language || t.name] = t.url;
        }
      }

      const subtitleTracks = [];
      const seenSub = new Set();
      for (const gid of Object.keys(subtitleGroups)) {
        for (const t of subtitleGroups[gid]) {
          const key = t.language || t.name;
          if (seenSub.has(key)) continue;
          seenSub.add(key);
          subtitleTracks.push({ url: t.url, language: t.language, name: t.name, isDefault: t.isDefault, groupId: gid });
        }
      }

      return res.json({ qualities: qualities.length ? qualities : [{ label: 'Default', url, bandwidth: 0, resolution: 'unknown' }], audioTracks, audioGroupMap, subtitleTracks });
    }

    return res.json({ qualities: [{ label: 'Default', url, bandwidth: 0, resolution: 'unknown' }], audioTracks: [], audioGroupMap: null, subtitleTracks: [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/cancel', (req, res) => {
  const { downloadId } = req.body || {};
  if (!downloadId) return res.status(400).json({ error: 'No downloadId' });
  const dl = activeDownloads.get(downloadId);
  if (!dl) return res.status(404).json({ error: 'Download not found' });
  try {
    if (dl.process && !dl.process.killed) dl.process.kill('SIGTERM');
  } catch (e) {}
  dl.status = 'cancelled';
  broadcastProgress(downloadId, { status: 'cancelled' });
  activeDownloads.delete(downloadId);
  res.json({ success: true });
});

app.post('/download', async (req, res) => {
  const {
    url,
    filename,
    type,
    referer,
    origin,
    cookie,
    userAgent,
    audioUrl,
    subtitleUrl,
    outputFormat,
    dashVideoIndex,
    dashAudioIndex
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const ext = String(outputFormat || 'mp4').toLowerCase();
  const base = sanitizeFilename(String(filename || `video_${Date.now()}`).replace(/\.(m3u8|mpd|mp4|webm|mkv|mov|avi|flv|ts)$/i, ''));
  const outPath = uniqueOutputPath(path.join(getDownloadDir(), `${base}.${ext}`));
  const downloadId = nowId();

  const headers = {
    referer: referer || '',
    origin: origin || '',
    cookie: cookie || '',
    userAgent: userAgent || DEFAULT_UA
  };

  const headersArg = ffmpegHeadersArg(headers);

  const args = ['-y', '-nostats', '-progress', 'pipe:1'];

  if (headersArg) args.push('-headers', headersArg);
  args.push('-i', url);

  let hasExternalAudio = false;
  if (audioUrl && String(audioUrl).startsWith('http')) {
    hasExternalAudio = true;
    if (headersArg) args.push('-headers', headersArg);
    args.push('-i', audioUrl);
  }

  let hasExternalSub = false;
  if (subtitleUrl && String(subtitleUrl).startsWith('http')) {
    hasExternalSub = true;
    if (headersArg) args.push('-headers', headersArg);
    args.push('-i', subtitleUrl);
  }

  if (typeof dashVideoIndex === 'number') {
    args.push('-map', `0:v:${dashVideoIndex}`);
  } else {
    args.push('-map', '0:v:0?');
  }

  if (hasExternalAudio) {
    args.push('-map', '1:a:0?');
  } else if (typeof dashAudioIndex === 'number') {
    args.push('-map', `0:a:${dashAudioIndex}?`);
  } else {
    args.push('-map', '0:a:0?');
  }

  if (hasExternalSub) {
    const subInputIndex = hasExternalAudio ? 2 : 1;
    args.push('-map', `${subInputIndex}:0?`);
    if (ext === 'mp4') args.push('-c:s', 'mov_text');
    else args.push('-c:s', 'copy');
  }

  args.push('-c:v', 'copy', '-c:a', 'copy', outPath);

  const durationSec = await ffprobeDuration(url, headersArg);

  const proc = spawn('ffmpeg', args, { windowsHide: true });
  const entry = {
    downloadId,
    process: proc,
    filename: path.basename(outPath),
    sourceUrl: url,
    outputPath: outPath,
    status: 'downloading',
    percent: 0,
    currentTime: '0:00',
    totalTime: durationSec ? formatTimeSec(durationSec) : '--:--',
    speed: '--',
    eta: '--',
    startedAt: Date.now()
  };
  activeDownloads.set(downloadId, entry);

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    let outTimeMs = null;
    let speed = null;
    let totalSize = null;

    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key === 'out_time_ms') outTimeMs = Number(val);
      if (key === 'speed') speed = val;
      if (key === 'total_size') totalSize = Number(val);
    }

    if (outTimeMs !== null) {
      const played = outTimeMs / 1000000;
      entry.currentTime = formatTimeSec(played);
      if (durationSec) {
        entry.percent = Math.max(0, Math.min(99, Math.round((played / durationSec) * 100)));
        const remain = Math.max(0, durationSec - played);
        entry.eta = formatTimeSec(remain);
      }
    }
    if (speed) entry.speed = speed;

    broadcastProgress(downloadId, {
      status: 'downloading',
      percent: entry.percent,
      currentTime: entry.currentTime,
      totalTime: entry.totalTime,
      speed: entry.speed,
      eta: entry.eta,
      bytesReceived: totalSize ? formatBytes(totalSize) : '0 B',
      totalBytes: totalSize ? formatBytes(totalSize) : '--'
    });
  });

  proc.stderr.on('data', () => {});

  proc.on('error', (err) => {
    entry.status = 'failed';
    broadcastProgress(downloadId, { status: 'failed', error: err.message || 'ffmpeg failed' });
    activeDownloads.delete(downloadId);
  });

  proc.on('close', (code, signal) => {
    if (entry.status === 'cancelled') {
      activeDownloads.delete(downloadId);
      return;
    }

    if (code === 0 && fs.existsSync(outPath)) {
      const sz = fs.statSync(outPath).size;
      entry.status = 'complete';
      entry.percent = 100;
      broadcastProgress(downloadId, {
        status: 'complete',
        percent: 100,
        filename: entry.filename,
        size: formatBytes(sz)
      });
    } else {
      entry.status = 'failed';
      broadcastProgress(downloadId, {
        status: 'failed',
        error: signal ? `ffmpeg terminated (${signal})` : `ffmpeg exited with code ${code}`
      });
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch (e) {}
    }

    activeDownloads.delete(downloadId);
  });

  return res.json({
    success: true,
    data: {
      downloadId,
      filename: path.basename(outPath)
    }
  });
});

wss.on('connection', () => {});

server.listen(PORT, () => {
  ensureDir(getDownloadDir());
  console.log(`Server running on http://localhost:${PORT}`);
});
