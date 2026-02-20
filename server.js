const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const app = express();
const PORT = 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Configure download directory
const DEFAULT_DOWNLOAD_DIR = path.join(require('os').homedir(), 'Downloads', 'VideoDownloader');
let DOWNLOAD_DIR = DEFAULT_DOWNLOAD_DIR;

// Load saved download directory from config file
const CONFIG_FILE = path.join(require('os').homedir(), '.videodownloader-config.json');
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.downloadDir && fs.existsSync(cfg.downloadDir)) {
      DOWNLOAD_DIR = cfg.downloadDir;
    }
  }
} catch(e) {}

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

console.log('Video Download Server Starting...');
console.log('Download directory:', DOWNLOAD_DIR);
console.log('Checking for FFmpeg...');

// Check if FFmpeg is installed
const { exec } = require('child_process');
exec('ffmpeg -version', (error) => {
  if (error) {
    console.error('\n❌ ERROR: FFmpeg not found!');
    console.error('Please install FFmpeg first:');
    console.error('  Windows: choco install ffmpeg  OR  download from https://ffmpeg.org/download.html');
    console.error('  Mac: brew install ffmpeg');
    console.error('  Linux: sudo apt install ffmpeg\n');
    process.exit(1);
  } else {
    console.log('✅ FFmpeg found!\n');
  }
});

// Store active downloads
const activeDownloads = new Map();

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('📡 Client connected to WebSocket');
  
  ws.on('close', () => {
    console.log('📡 Client disconnected');
  });
});

// Broadcast progress to all connected clients
function broadcastProgress(downloadId, progress) {
  // Store last progress on the download entry so popup can restore state
  const dl = activeDownloads.get(downloadId);
  if (dl) {
    dl.lastProgress = progress;
  }
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'progress',
        downloadId,
        ...progress
      }));
    }
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'running', message: 'Video download server is active' });
});

// Server info endpoint (version, ffmpeg, download dir)
app.get('/server-info', (req, res) => {
  res.json({
    status: 'running',
    downloadDir: DOWNLOAD_DIR,
    defaultDownloadDir: DEFAULT_DOWNLOAD_DIR
  });
});

// Get current download directory
app.get('/download-dir', (req, res) => {
  res.json({ dir: DOWNLOAD_DIR });
});

// Set download directory
app.post('/download-dir', (req, res) => {
  const newDir = (req.body.dir || '').trim();
  
  // Empty = reset to default
  if (!newDir) {
    DOWNLOAD_DIR = DEFAULT_DOWNLOAD_DIR;
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
    // Save config
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ downloadDir: DOWNLOAD_DIR }), 'utf8'); } catch(e) {}
    console.log('📁 Download directory reset to default:', DOWNLOAD_DIR);
    return res.json({ success: true, dir: DOWNLOAD_DIR });
  }
  
  // Validate the path
  try {
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true });
    }
    // Test write access
    const testFile = path.join(newDir, '.write-test-' + Date.now());
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    
    DOWNLOAD_DIR = newDir;
    // Save config persistently
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ downloadDir: DOWNLOAD_DIR }), 'utf8'); } catch(e) {}
    console.log('📁 Download directory changed to:', DOWNLOAD_DIR);
    res.json({ success: true, dir: DOWNLOAD_DIR });
  } catch (err) {
    res.json({ success: false, error: 'Cannot write to directory: ' + err.message });
  }
});

// Open download directory in file explorer
app.get('/open-folder', (req, res) => {
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `explorer "${DOWNLOAD_DIR}"`
    : process.platform === 'darwin' ? `open "${DOWNLOAD_DIR}"`
    : `xdg-open "${DOWNLOAD_DIR}"`;
  exec(cmd, (err) => {
    if (err) console.error('Failed to open folder:', err.message);
  });
  res.json({ success: true });
});

// Play/stream a downloaded video file
app.get('/play/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(DOWNLOAD_DIR, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  
  // Determine content type
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.flv': 'video/x-flv'
  };
  const contentType = mimeTypes[ext] || 'video/mp4';
  
  if (range) {
    // Range request for seeking support
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;
    
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Show file in its containing folder (reveal in explorer)
app.get('/open-file/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(DOWNLOAD_DIR, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `explorer /select,"${filePath}"`
    : process.platform === 'darwin' ? `open -R "${filePath}"`
    : `xdg-open "${path.dirname(filePath)}"`;
  exec(cmd, (err) => {
    if (err) console.error('Failed to show file:', err.message);
  });
  res.json({ success: true });
});

// Delete a downloaded file from disk
app.delete('/delete-file/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(DOWNLOAD_DIR, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found', success: false });
  }
  
  try {
    fs.unlinkSync(filePath);
    console.log(`🗑️  Deleted file: ${filename}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`Failed to delete file: ${err.message}`);
    res.status(500).json({ error: err.message, success: false });
  }
});

// Get available HLS qualities
app.post('/qualities', async (req, res) => {
  const { url, referer, origin, cookie, userAgent } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  
  const headers = {
    'User-Agent': userAgent || DEFAULT_UA,
  };
  if (referer) headers['Referer'] = referer;
  if (origin) headers['Origin'] = origin;
  if (cookie) headers['Cookie'] = cookie;
  
  try {
    const resp = await nodeFetch(url, headers);
    if (!resp.ok) return res.status(502).json({ error: `Playlist returned HTTP ${resp.status}` });
    const text = resp.text();
    
    if (!text.includes('#EXTM3U')) {
      return res.json({ qualities: [{ label: 'Default', url: url, bandwidth: 0, resolution: 'unknown' }] });
    }
    
    if (text.includes('#EXT-X-STREAM-INF:')) {
      const { variants, audioGroups, subtitleGroups } = parseMasterM3U8(text, url);
      
      // Debug: log what we found
      console.log(`   [Qualities] Found ${variants.length} video variants`);
      console.log(`   [Qualities] Audio groups: ${JSON.stringify(Object.keys(audioGroups))}`);
      console.log(`   [Qualities] Subtitle groups: ${JSON.stringify(Object.keys(subtitleGroups))}`);
      
      if (variants.length > 0) {
        const qualities = variants.map((v, i) => {
          const [w, h] = v.resolution !== 'unknown' ? v.resolution.split('x') : [0, 0];
          let label = '';
          if (parseInt(h) >= 1080) label = '1080p';
          else if (parseInt(h) >= 720) label = '720p';
          else if (parseInt(h) >= 480) label = '480p';
          else if (parseInt(h) >= 360) label = '360p';
          else if (parseInt(h) >= 240) label = '240p';
          else label = v.resolution;
          label += ` (${Math.round(v.bandwidth / 1000)} kbps)`;
          return { label, url: v.url, bandwidth: v.bandwidth, resolution: v.resolution, audioUrl: v.audioUrl || null, audioGroupId: v.audioGroupId || null };
        });
        
        // Collect unique audio tracks, deduplicated by language
        // Different audio groups have the same languages at different bitrates;
        // we show one entry per language and resolve the correct group URL at download time
        const audioTracks = [];
        const seenLanguages = new Set();
        for (const groupId of Object.keys(audioGroups)) {
          for (const track of audioGroups[groupId]) {
            const langKey = track.language || track.name;
            if (!seenLanguages.has(langKey)) {
              seenLanguages.add(langKey);
              audioTracks.push({ url: track.url, language: track.language, name: track.name, isDefault: track.isDefault, groupId });
            }
          }
        }
        
        // Build a lookup so popup can resolve the right audio URL per group+language
        // { groupId: { language: url } }
        const audioGroupMap = {};
        for (const gid of Object.keys(audioGroups)) {
          audioGroupMap[gid] = {};
          for (const t of audioGroups[gid]) {
            audioGroupMap[gid][t.language || t.name] = t.url;
          }
        }
        
        // Collect unique subtitle tracks, deduplicated by language
        const subtitleTracks = [];
        const seenSubLanguages = new Set();
        for (const groupId of Object.keys(subtitleGroups)) {
          for (const track of subtitleGroups[groupId]) {
            const langKey = track.language || track.name;
            if (!seenSubLanguages.has(langKey)) {
              seenSubLanguages.add(langKey);
              subtitleTracks.push({ url: track.url, language: track.language, name: track.name, isDefault: track.isDefault, groupId });
            }
          }
        }
        
        return res.json({ qualities, audioTracks, audioGroupMap, subtitleTracks });
      }
    }
    
    // Media playlist only, no quality options
    res.json({ qualities: [{ label: 'Default', url: url, bandwidth: 0, resolution: 'unknown' }] });
  } catch (err) {
    console.error('Quality fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cancel download
app.post('/cancel', (req, res) => {
  const { downloadId } = req.body;
  if (!downloadId) return res.status(400).json({ error: 'No downloadId' });
  
  const dl = activeDownloads.get(downloadId);
  if (!dl) return res.status(404).json({ error: 'Download not found' });
  
  console.log(`\n🛑 Cancelling download [${downloadId}]: ${dl.filename}`);
  
  // Set cancelled flag so proxy loop stops
  dl.cancelled = true;
  
  // Kill FFmpeg process if running
  if (dl.ffmpegProcess) {
    try { dl.ffmpegProcess.kill('SIGKILL'); } catch(e) {}
  }
  
  // Destroy HTTP request/response for direct downloads
  if (dl.response) {
    try { dl.response.destroy(); } catch(e) {}
  }
  if (dl.request) {
    try { dl.request.destroy(); } catch(e) {}
  }
  
  // Broadcast cancelled status immediately
  broadcastProgress(downloadId, { status: 'cancelled', filename: dl.filename });
  
  // NOTE: Don't delete activeDownloads or clean up files here.
  // The proxy loop checks dl.cancelled and will clean up via its finally block.
  
  console.log(`   ✅ Download cancelled\n`);
  res.json({ success: true });
});

// Get unique output path - appends (1), (2), etc. if file exists
function getUniqueOutputPath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let counter = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base} (${counter})${ext}`);
    counter++;
  } while (fs.existsSync(candidate));
  return candidate;
}

// Sanitize filename - remove problematic characters
function sanitizeFilename(name) {
  return name
    .replace(/['"`]/g, '')          // Remove quotes/apostrophes
    .replace(/[<>:"\/\\|?*]/g, '')   // Remove filesystem-illegal chars
    .replace(/[^a-zA-Z0-9._\-\s()\[\]]/g, '_') // Replace other special chars
    .replace(/\s+/g, '_')            // Spaces to underscores
    .replace(/_+/g, '_')             // Collapse multiple underscores
    .replace(/^_|_$/g, '')           // Trim leading/trailing underscores
    .substring(0, 150)               // Limit length
    || `video_${Date.now()}`;
}

// ====== PROXY HLS DOWNLOAD SYSTEM ======
// Downloads HLS streams by fetching m3u8 playlists and segments directly via Node.js
// This handles encrypted playlists, obfuscated segment extensions (.jpg, .png), and CDN protections

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Fetch a URL with proper headers, follow redirects
function nodeFetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Accept': '*/*', ...headers }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const newUrl = new URL(res.headers.location, url).href;
        res.resume();
        nodeFetch(newUrl, headers).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          data: buf,
          text() { return buf.toString('utf8'); }
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Request timeout')); });
    req.end();
  });
}

// Parse HLS master playlist to extract variant streams
function parseMasterM3U8(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const variants = [];
  
  // First pass: parse ALL audio and subtitle renditions by GROUP-ID
  const audioGroups = {}; // { groupId: [ { url, language, name, isDefault } ] }
  const subtitleGroups = {}; // { groupId: [ { url, language, name, isDefault } ] }
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const groupId = line.match(/GROUP-ID="([^"]+)"/);
    const uri = line.match(/URI="([^"]+)"/);
    const lang = line.match(/LANGUAGE="([^"]+)"/);
    const name = line.match(/NAME="([^"]+)"/);
    const isDefault = /DEFAULT=YES/i.test(line);
    
    if (/TYPE=AUDIO/i.test(line)) {
      if (groupId && uri) {
        const audioUrl = uri[1].startsWith('http') ? uri[1] : new URL(uri[1], baseUrl).href;
        if (!audioGroups[groupId[1]]) audioGroups[groupId[1]] = [];
        audioGroups[groupId[1]].push({
          url: audioUrl,
          language: lang ? lang[1] : 'und',
          name: name ? name[1] : (lang ? lang[1] : 'Default'),
          isDefault: isDefault
        });
      }
    } else if (/TYPE=SUBTITLES/i.test(line)) {
      if (groupId && uri) {
        const subUrl = uri[1].startsWith('http') ? uri[1] : new URL(uri[1], baseUrl).href;
        if (!subtitleGroups[groupId[1]]) subtitleGroups[groupId[1]] = [];
        subtitleGroups[groupId[1]].push({
          url: subUrl,
          language: lang ? lang[1] : 'und',
          name: name ? name[1] : (lang ? lang[1] : 'Subtitles'),
          isDefault: isDefault
        });
      }
    }
  }
  
  // Second pass: parse video variants and link to audio groups
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const bw = lines[i].match(/BANDWIDTH=(\d+)/);
      const res = lines[i].match(/RESOLUTION=(\d+x\d+)/);
      const audioGroup = lines[i].match(/AUDIO="([^"]+)"/);
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) {
          const variantUrl = lines[j].startsWith('http') ? lines[j] : new URL(lines[j], baseUrl).href;
          const groupId = audioGroup ? audioGroup[1] : null;
          // Pick default audio for this variant
          const groupTracks = groupId && audioGroups[groupId] ? audioGroups[groupId] : [];
          const defaultTrack = groupTracks.find(t => t.isDefault) || groupTracks[0] || null;
          variants.push({
            bandwidth: bw ? parseInt(bw[1]) : 0,
            resolution: res ? res[1] : 'unknown',
            url: variantUrl,
            audioUrl: defaultTrack ? defaultTrack.url : null,
            audioGroupId: groupId
          });
          break;
        }
      }
    }
  }
  return { variants: variants.sort((a, b) => b.bandwidth - a.bandwidth), audioGroups, subtitleGroups };
}

// Parse HLS media playlist to extract segments
function parseMediaM3U8(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim());
  const segments = [];
  let duration = 0;
  let keyInfo = null;
  let initSegment = null;
  
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = line.match(/METHOD=([^,\s]+)/);
      const uri = line.match(/URI="([^"]+)"/);
      const iv = line.match(/IV=(0x[0-9a-fA-F]+)/);
      if (method && method[1] !== 'NONE') {
        keyInfo = {
          method: method[1],
          uri: uri ? (uri[1].startsWith('http') ? uri[1] : new URL(uri[1], baseUrl).href) : null,
          iv: iv ? iv[1] : null
        };
      } else {
        keyInfo = null;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      // fMP4 init segment - required for fragmented MP4 streams (e.g. YouTube)
      const uri = line.match(/URI="([^"]+)"/);
      if (uri) {
        initSegment = {
          url: uri[1].startsWith('http') ? uri[1] : new URL(uri[1], baseUrl).href,
          byterange: null
        };
        const br = line.match(/BYTERANGE="(\d+)@(\d+)"/);
        if (br) initSegment.byterange = { length: parseInt(br[1]), offset: parseInt(br[2]) };
      }
    } else if (line.startsWith('#EXTINF:')) {
      const d = line.match(/#EXTINF:([\d.]+)/);
      duration = d ? parseFloat(d[1]) : 0;
    } else if (line && !line.startsWith('#')) {
      segments.push({
        url: line.startsWith('http') ? line : new URL(line, baseUrl).href,
        duration: duration,
        key: keyInfo
      });
      duration = 0;
    }
  }
  return { segments, initSegment };
}

// FFmpeg mux helper
function ffmpegMux(args, downloadId) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    // Store process for cancel support
    if (downloadId) {
      const dl = activeDownloads.get(downloadId);
      if (dl) dl.ffmpegProcess = ffmpeg;
    }
    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg mux failed (code ${code}): ${stderr.slice(-300)}`));
    });
  });
}

// Main proxy HLS download function
async function proxyHlsDownload(streamUrl, outputPathParam, reqHeaders, downloadId, outputFilename, audioUrl, subtitleUrl, requestedFormat) {
  let outputPath = outputPathParam;
  const headers = {
    'User-Agent': reqHeaders.userAgent || DEFAULT_UA,
  };
  if (reqHeaders.referer) headers['Referer'] = reqHeaders.referer;
  if (reqHeaders.origin) headers['Origin'] = reqHeaders.origin;
  if (reqHeaders.cookie) headers['Cookie'] = reqHeaders.cookie;
  
  const startTime = Date.now();
  const dl = activeDownloads.get(downloadId);
  
  function checkCancelled() {
    const d = activeDownloads.get(downloadId);
    if (!d || d.cancelled) throw new Error('Download cancelled');
  }
  
  // 1. Fetch master playlist
  console.log('   [Proxy] Fetching master playlist...');
  const masterResp = await nodeFetch(streamUrl, headers);
  if (!masterResp.ok) throw new Error(`Master playlist returned HTTP ${masterResp.status}`);
  const masterText = masterResp.text();
  
  if (!masterText.includes('#EXTM3U')) {
    console.log('   [Proxy] Content (first 300 chars):', masterText.substring(0, 300));
    throw new Error('Not a valid M3U8 playlist');
  }
  
  // 2. Determine if master or media playlist
  let mediaUrl = streamUrl;
  if (masterText.includes('#EXT-X-STREAM-INF:')) {
    const { variants } = parseMasterM3U8(masterText, streamUrl);
    if (!variants.length) throw new Error('No variants in master playlist');
    console.log(`   [Proxy] Found ${variants.length} quality levels:`);
    variants.forEach((v, i) => console.log(`     ${i === 0 ? '\u2192' : ' '} ${v.resolution} @ ${Math.round(v.bandwidth / 1000)}kbps${v.audioUrl ? ' (+audio)' : ''}`));
    mediaUrl = variants[0].url;
    // Use audio from master playlist if not already provided
    if (!audioUrl && variants[0].audioUrl) {
      audioUrl = variants[0].audioUrl;
    }
  }
  
  // 3. Fetch media playlist
  console.log(`   [Proxy] Fetching media playlist...`);
  const mediaResp = await nodeFetch(mediaUrl, headers);
  if (!mediaResp.ok) throw new Error(`Media playlist returned HTTP ${mediaResp.status}`);
  const mediaText = mediaResp.text();
  
  if (!mediaText.includes('#EXTM3U') && !mediaText.includes('#EXTINF:')) {
    console.log('   [Proxy] Media playlist content (first 300 chars):', mediaText.substring(0, 300));
    throw new Error('Media playlist is invalid or encrypted. This stream cannot be downloaded directly.');
  }
  
  // 4. Parse segments
  const { segments, initSegment } = parseMediaM3U8(mediaText, mediaUrl);
  if (!segments.length) throw new Error('No segments found in media playlist');
  if (initSegment) console.log('   [Proxy] Stream uses fMP4 (has init segment)');
  
  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  const isEncrypted = segments.some(s => s.key && s.key.method !== 'NONE');
  console.log(`   [Proxy] ${segments.length} segments, duration: ${formatTime(totalDuration)}${isEncrypted ? ', ENCRYPTED (' + segments[0].key.method + ')' : ''}`);
  
  // 5. Create temp directory
  const tempDir = path.join(DOWNLOAD_DIR, `_temp_${downloadId}`);
  fs.mkdirSync(tempDir, { recursive: true });
  
  // Store tempDir for cancel cleanup
  if (dl) { dl.tempDir = tempDir; dl.outputPath = outputPath; }
  
  try {
    checkCancelled();
    // 6. Download encryption key if needed
    let keyData = null;
    if (isEncrypted && segments[0].key && segments[0].key.uri) {
      console.log('   [Proxy] Downloading decryption key...');
      const keyResp = await nodeFetch(segments[0].key.uri, headers);
      if (keyResp.ok) {
        keyData = keyResp.data;
        console.log(`   [Proxy] Key downloaded (${keyData.length} bytes)`);
      } else {
        console.log(`   [Proxy] Key download failed: HTTP ${keyResp.status}`);
      }
    }
    
    // 6b. Download init segment if present (fMP4 streams)
    let initSegFile = null;
    if (initSegment) {
      console.log('   [Proxy] Downloading init segment...');
      const initResp = await nodeFetch(initSegment.url, headers);
      if (initResp.ok && initResp.data.length > 0) {
        initSegFile = path.join(tempDir, 'init.mp4');
        fs.writeFileSync(initSegFile, initResp.data);
        console.log(`   [Proxy] Init segment downloaded (${initResp.data.length} bytes)`);
      } else {
        console.log(`   [Proxy] Warning: Init segment download failed (HTTP ${initResp.status})`);
      }
    }

    // 7. Validate first segment before downloading everything
    checkCancelled();
    console.log('   [Proxy] Validating first segment...');
    const firstSegFile = path.join(tempDir, `seg_00000.ts`);
    const firstResp = await nodeFetch(segments[0].url, headers);
    if (!firstResp.ok || firstResp.data.length === 0) {
      throw new Error(`First segment returned HTTP ${firstResp.status} - this quality may be unavailable. Try a different quality.`);
    }
    // Validate content isn't an error page
    const firstHeader = firstResp.data.slice(0, 4).toString('utf8');
    if (firstHeader.startsWith('<') || firstHeader.startsWith('{"')) {
      throw new Error('Stream returned an error page instead of video data. This quality is broken - try a different one.');
    }
    fs.writeFileSync(firstSegFile, firstResp.data);
    console.log(`   [Proxy] First segment valid (${firstResp.data.length} bytes)`);

    // 8. Download remaining segments in batches
    const BATCH_SIZE = 5;
    const segFiles = [firstSegFile]; // First segment already downloaded
    let failedSegments = 0;
    
    for (let i = 1; i < segments.length; i += BATCH_SIZE) {
      checkCancelled();
      const batch = segments.slice(i, Math.min(i + BATCH_SIZE, segments.length));
      
      const results = await Promise.all(batch.map(async (seg, j) => {
        const idx = i + j;
        // Check cancel before each segment fetch
        const d = activeDownloads.get(downloadId);
        if (d && d.cancelled) return null;
        
        const segFile = path.join(tempDir, `seg_${String(idx).padStart(5, '0')}.ts`);
        
        try {
          const resp = await nodeFetch(seg.url, headers);
          // Check cancel again after fetch completes
          const d2 = activeDownloads.get(downloadId);
          if (d2 && d2.cancelled) return null;
          if (resp.ok && resp.data.length > 0) {
            fs.writeFileSync(segFile, resp.data);
            return segFile;
          } else {
            failedSegments++;
            return null;
          }
        } catch (err) {
          failedSegments++;
          return null;
        }
      }));
      
      // Break out of loop immediately if cancelled
      checkCancelled();
      
      segFiles.push(...results.filter(Boolean));
      
      const done = Math.min(i + BATCH_SIZE, segments.length);
      const percent = (done / segments.length * 100).toFixed(1);
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? (done / elapsed).toFixed(1) : '0';
      const eta = elapsed > 0 ? ((segments.length - done) / (done / elapsed)) : 0;
      
      broadcastProgress(downloadId, {
        percent,
        currentTime: `${done}/${segments.length} segments`,
        totalTime: formatTime(totalDuration),
        speed: `${speed} seg/s`,
        eta: formatTime(eta),
        filename: outputFilename
      });
      
      process.stdout.write(`\r   [Proxy] Downloading: ${percent}% (${done}/${segments.length}) @ ${speed} seg/s   `);
    }
    
    console.log(`\n   [Proxy] Downloaded ${segFiles.length}/${segments.length} segments (${failedSegments} failed)`);
    
    if (segFiles.length === 0) {
      throw new Error('All segment downloads failed');
    }
    
    // 7b. Validate segments - remove corrupt/empty files
    const validSegFiles = segFiles.filter(f => {
      try {
        const stat = fs.statSync(f);
        if (stat.size < 100) {
          console.log(`   [Proxy] Skipping tiny segment: ${path.basename(f)} (${stat.size} bytes)`);
          return false;
        }
        // Check first bytes - valid TS starts with 0x47, or valid data
        const header = Buffer.alloc(4);
        const fd = fs.openSync(f, 'r');
        fs.readSync(fd, header, 0, 4, 0);
        fs.closeSync(fd);
        // Reject if it looks like HTML error page
        if (header.toString('utf8').startsWith('<') || header.toString('utf8').startsWith('{"')) {
          console.log(`   [Proxy] Skipping non-video segment: ${path.basename(f)} (looks like HTML/JSON)`);
          return false;
        }
        return true;
      } catch (e) {
        return false;
      }
    });
    
    console.log(`   [Proxy] Valid segments: ${validSegFiles.length}/${segFiles.length}`);
    
    if (validSegFiles.length === 0) {
      throw new Error('All segments are invalid - stream may require special authentication or DRM');
    }
    
    // 8. Mux with FFmpeg
    checkCancelled();
    
    // Apply unique filename to avoid overwriting
    outputPath = getUniqueOutputPath(outputPath);
    if (dl) dl.outputPath = outputPath;
    
    // 8a. Download separate audio stream if present (e.g. YouTube separates video and audio)
    let audioM3u8File = null;
    if (audioUrl) {
      console.log('   [Proxy] Downloading separate audio stream...');
      try {
        const audioResp = await nodeFetch(audioUrl, headers);
        if (audioResp.ok) {
          const audioText = audioResp.text();
          const { segments: audioSegments, initSegment: audioInitSeg } = parseMediaM3U8(audioText, audioUrl);
          console.log(`   [Proxy] Audio: ${audioSegments.length} segments`);
          
          // Download audio init segment if present
          let audioInitFile = null;
          if (audioInitSeg) {
            const initResp = await nodeFetch(audioInitSeg.url, headers);
            if (initResp.ok && initResp.data.length > 0) {
              audioInitFile = path.join(tempDir, 'audio_init.mp4');
              fs.writeFileSync(audioInitFile, initResp.data);
            }
          }
          
          // Download audio segments
          const audioSegFiles = [];
          const AUDIO_BATCH = 10;
          for (let i = 0; i < audioSegments.length; i += AUDIO_BATCH) {
            checkCancelled();
            const batch = audioSegments.slice(i, Math.min(i + AUDIO_BATCH, audioSegments.length));
            const results = await Promise.all(batch.map(async (seg, j) => {
              const idx = i + j;
              const segFile = path.join(tempDir, `audio_seg_${String(idx).padStart(5, '0')}.ts`);
              try {
                const resp = await nodeFetch(seg.url, headers);
                if (resp.ok && resp.data.length > 0) {
                  fs.writeFileSync(segFile, resp.data);
                  return { file: segFile, duration: seg.duration };
                }
              } catch (e) {}
              return null;
            }));
            audioSegFiles.push(...results.filter(Boolean));
            const done = Math.min(i + AUDIO_BATCH, audioSegments.length);
            process.stdout.write(`\r   [Proxy] Audio: ${done}/${audioSegments.length} segments   `);
          }
          console.log(`\n   [Proxy] Audio: downloaded ${audioSegFiles.length}/${audioSegments.length} segments`);
          
          if (audioSegFiles.length > 0) {
            // Build local m3u8 for audio
            let audioM3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n';
            if (audioInitFile) {
              audioM3u8 += `#EXT-X-MAP:URI="${audioInitFile.replace(/\\/g, '/')}"\n`;
            }
            for (const seg of audioSegFiles) {
              audioM3u8 += `#EXTINF:${seg.duration},\n${seg.file.replace(/\\/g, '/')}\n`;
            }
            audioM3u8 += '#EXT-X-ENDLIST\n';
            audioM3u8File = path.join(tempDir, 'audio_local.m3u8');
            fs.writeFileSync(audioM3u8File, audioM3u8);
          }
        }
      } catch (audioErr) {
        console.log(`   [Proxy] Audio download failed: ${audioErr.message} - continuing with video only`);
      }
    }
    
    // 8b. Download subtitle stream if present
    let subtitleFile = null;
    if (subtitleUrl) {
      console.log('   [Proxy] Downloading subtitles...');
      try {
        const subResp = await nodeFetch(subtitleUrl, headers);
        if (subResp.ok) {
          const subText = await subResp.text();
          if (subText.includes('#EXTM3U')) {
            // It's an HLS playlist of WebVTT segments
            const { segments: subSegments } = parseMediaM3U8(subText, subtitleUrl);
            console.log(`   [Proxy] Subtitles: ${subSegments.length} segments`);
            
            // Download and concatenate all VTT segments
            let vttContent = 'WEBVTT\n\n';
            let isFirst = true;
            for (let i = 0; i < subSegments.length; i++) {
              checkCancelled();
              try {
                const segResp = await nodeFetch(subSegments[i].url, headers);
                if (segResp.ok) {
                  let segText = await segResp.text();
                  // Strip WEBVTT header from subsequent segments
                  if (!isFirst) {
                    segText = segText.replace(/^WEBVTT[^\n]*\n(\n)?/, '');
                    segText = segText.replace(/^X-TIMESTAMP-MAP[^\n]*\n(\n)?/m, '');
                  } else {
                    segText = segText.replace(/^WEBVTT[^\n]*\n/, '');
                    segText = segText.replace(/^X-TIMESTAMP-MAP[^\n]*\n(\n)?/m, '');
                    isFirst = false;
                  }
                  vttContent += segText;
                  if (!segText.endsWith('\n')) vttContent += '\n';
                }
              } catch (e) {
                // Skip failed subtitle segment
              }
            }
            
            if (vttContent.length > 20) {
              subtitleFile = path.join(tempDir, 'subtitles.vtt');
              fs.writeFileSync(subtitleFile, vttContent, 'utf8');
              console.log(`   [Proxy] Subtitle file created (${(vttContent.length / 1024).toFixed(1)} KB)`);
            }
          } else if (subText.includes('WEBVTT') || subText.match(/^\d{2}:\d{2}/m)) {
            // Direct WebVTT file
            subtitleFile = path.join(tempDir, 'subtitles.vtt');
            fs.writeFileSync(subtitleFile, subText, 'utf8');
            console.log(`   [Proxy] Direct VTT subtitle saved (${(subText.length / 1024).toFixed(1)} KB)`);
          } else if (subText.match(/^\d+\r?\n\d{2}:\d{2}:\d{2}/m)) {
            // SRT format - convert to VTT
            let vtt = 'WEBVTT\n\n' + subText
              .replace(/\r\n/g, '\n')
              .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
            subtitleFile = path.join(tempDir, 'subtitles.vtt');
            fs.writeFileSync(subtitleFile, vtt, 'utf8');
            console.log(`   [Proxy] SRT converted to VTT (${(vtt.length / 1024).toFixed(1)} KB)`);
          } else if (subText.includes('[Script Info]') || subText.includes('Dialogue:')) {
            // ASS/SSA format - save as-is, FFmpeg can handle it directly
            subtitleFile = path.join(tempDir, 'subtitles.ass');
            fs.writeFileSync(subtitleFile, subText, 'utf8');
            console.log(`   [Proxy] ASS subtitle saved (${(subText.length / 1024).toFixed(1)} KB)`);
          } else {
            // Unknown format - try saving as VTT anyway
            subtitleFile = path.join(tempDir, 'subtitles.vtt');
            fs.writeFileSync(subtitleFile, subText, 'utf8');
            console.log(`   [Proxy] Unknown subtitle format saved (${(subText.length / 1024).toFixed(1)} KB)`);
          }
        }
      } catch (subErr) {
        console.log(`   [Proxy] Subtitle download failed: ${subErr.message} - continuing without subtitles`);
      }
    }
    
    console.log('   [Proxy] Muxing with FFmpeg...');
    
    // Build local m3u8 that references downloaded files on disk
    // This approach works for both TS and fMP4 segments, encrypted or not
    let localM3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n';
    
    // Add encryption key if present
    if (isEncrypted && keyData) {
      const keyFile = path.join(tempDir, 'key.bin');
      fs.writeFileSync(keyFile, keyData);
      localM3u8 += `#EXT-X-KEY:METHOD=${segments[0].key.method},URI="${keyFile.replace(/\\/g, '/')}"`;
      if (segments[0].key.iv) localM3u8 += `,IV=${segments[0].key.iv}`;
      localM3u8 += '\n';
    }
    
    // Add init segment for fMP4 streams
    if (initSegFile) {
      localM3u8 += `#EXT-X-MAP:URI="${initSegFile.replace(/\\/g, '/')}"\n`;
    }
    
    // Add all valid segments with their durations
    for (let i = 0; i < validSegFiles.length; i++) {
      const segIdx = segments.findIndex((_, si) => {
        const expected = path.join(tempDir, `seg_${String(si).padStart(5, '0')}.ts`);
        return expected === validSegFiles[i];
      });
      const dur = segIdx >= 0 ? segments[segIdx].duration : 5;
      localM3u8 += `#EXTINF:${dur},\n${validSegFiles[i].replace(/\\/g, '/')}\n`;
    }
    localM3u8 += '#EXT-X-ENDLIST\n';
    
    const localM3u8File = path.join(tempDir, 'local.m3u8');
    fs.writeFileSync(localM3u8File, localM3u8);
    
    const fmt = (requestedFormat || 'mp4').toLowerCase();
    const wantWebm = fmt === 'webm';
    const wantMkv = fmt === 'mkv';
    
    // Helper: pick codec args based on format
    // MP4/MKV = stream copy (instant), WebM = re-encode to VP9+Opus (slow)
    function codecArgs(hasSubs) {
      if (wantWebm) {
        return ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k'];
      }
      if (hasSubs) {
        // MKV supports many subtitle formats natively; MP4 needs mov_text
        const subCodec = wantMkv ? 'srt' : 'mov_text';
        return ['-c:v', 'copy', '-c:a', 'copy', '-c:s', subCodec];
      }
      return ['-c', 'copy'];
    }
    
    if (audioM3u8File) {
      // Dual-input: separate video and audio streams → mux together
      console.log('   [Proxy] Muxing video + audio streams...' + (wantWebm ? ' (re-encoding to WebM)' : ` (${fmt})`));
      const ffArgs = [
        '-f', 'hls', '-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data',
        '-i', localM3u8File,
        '-f', 'hls', '-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data',
        '-i', audioM3u8File,
      ];
      if (subtitleFile && !wantWebm) {
        ffArgs.push('-i', subtitleFile);
        ffArgs.push('-map', '0:v', '-map', '1:a', '-map', '2:s');
        ffArgs.push(...codecArgs(true));
      } else {
        ffArgs.push('-map', '0:v', '-map', '1:a');
        ffArgs.push(...codecArgs(false));
      }
      if (!wantWebm && !wantMkv) ffArgs.push('-movflags', '+faststart');
      if (!wantWebm && !wantMkv) ffArgs.push('-bsf:a', 'aac_adtstoasc');
      ffArgs.push(outputPath);
      await ffmpegMux(ffArgs, downloadId);
    } else {
      // Single input: video+audio already combined, or audio-only
      const ffArgs = [
        '-f', 'hls', '-allowed_extensions', 'ALL',
        '-protocol_whitelist', 'file,crypto,data',
        '-i', localM3u8File,
      ];
      if (subtitleFile && !wantWebm) {
        ffArgs.push('-i', subtitleFile);
        ffArgs.push('-map', '0:v', '-map', '0:a?', '-map', '1:s');
        ffArgs.push(...codecArgs(true));
      } else {
        ffArgs.push(...codecArgs(false));
        if (!wantWebm) ffArgs.push('-bsf:a', 'aac_adtstoasc');
      }
      if (!wantWebm && !wantMkv) ffArgs.push('-movflags', '+faststart');
      ffArgs.push(outputPath);
      await ffmpegMux(ffArgs, downloadId);
    }
    
    // 9. Success
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
      
      console.log(`\n\u2705 Proxy download complete: ${outputFilename} (${sizeMB} MB) in ${totalTime}s\n`);
      
      broadcastProgress(downloadId, {
        percent: 100,
        status: 'complete',
        filename: outputFilename,
        size: sizeMB + ' MB',
        totalTime: totalTime + 's'
      });
    }
    
  } finally {
    // Clean up temp directory
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
    // Clean up output file if cancelled
    const d = activeDownloads.get(downloadId);
    if (d && d.cancelled && outputPath && fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch(e) {}
    }
  }
}

// Download endpoint
app.post('/download', (req, res) => {
  const { url, filename, type, referer, origin, cookie, userAgent, audioUrl, subtitleUrl, outputFormat } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  // Reject obvious non-video URLs
  if (/ping\.gif|pixel|beacon|analytics|jwpltx\.com/i.test(url)) {
    console.log(`\n⚠️  Rejected non-video URL: ${url.substring(0, 80)}`);
    return res.status(400).json({ error: 'Not a video URL' });
  }
  
  // Validate that URL looks like a video/stream
  const urlPathCheck = url.split('?')[0].split('#')[0];
  const looksLikeVideo = /\.(m3u8|mpd|mp4|webm|mov|avi|mkv|flv|f4v|ts)$/i.test(urlPathCheck) ||
    /\.(m3u8|mpd|mp4|webm|mov|avi|mkv|flv|f4v|ts)\b/i.test(url) ||
    /\/manifest/i.test(url) || /\/playlist/i.test(url) || /\/video/i.test(url) ||
    /\/master/i.test(url) || /\/index-/i.test(url) || /type=video/i.test(url) || 
    type === 'HLS' || type === 'DASH' || type === 'MP4' || type === 'VIDEO' || type === 'WEBM';
  
  if (!looksLikeVideo) {
    console.log(`\n⚠️  Rejected non-video URL (no video pattern): ${url.substring(0, 80)}`);
    return res.status(400).json({ error: 'URL does not look like a video stream' });
  }

  const downloadId = Date.now().toString();
  const safeFilename = sanitizeFilename(filename || `video_${downloadId}`);
  // Strip playlist extensions (.m3u8, .mpd) and any existing video extension, then apply chosen format
  const requestedFormat = (outputFormat || 'mp4').toLowerCase();
  const baseFilename = safeFilename.replace(/\.(m3u8|mpd|mp4|webm|mov|avi|mkv|flv|f4v|ogv|3gp)$/i, '');
  const outputFilename = baseFilename + '.' + requestedFormat;
  const outputPath = getUniqueOutputPath(path.join(DOWNLOAD_DIR, outputFilename));
  
  // Extract origin for headers
  let refererUrl = referer || '';
  let originUrl = origin || '';
  if (!originUrl) {
    try {
      const parsed = new URL(refererUrl || url);
      originUrl = parsed.origin;
    } catch(e) {}
  }
  
  console.log(`\n📥 New download request [${downloadId}]:`);
  console.log(`   Type: ${type || 'Unknown'}`);
  console.log(`   URL: ${url.substring(0, 100)}...`);
  console.log(`   Referer: ${refererUrl.substring(0, 80)}`);
  console.log(`   Origin: ${originUrl}`);
  console.log(`   Has Cookie: ${cookie ? 'yes' : 'no'}`);
  console.log(`   Audio URL: ${audioUrl ? audioUrl.substring(0, 80) + '...' : 'none (will use default)'}`);
  console.log(`   Subtitle URL: ${subtitleUrl ? subtitleUrl.substring(0, 80) + '...' : 'none'}`);
  console.log(`   Output: ${outputFilename}`);
  
  // Send immediate response
  res.json({ 
    status: 'started', 
    message: 'Download started',
    filename: outputFilename,
    downloadId: downloadId
  });
  
  // Detect stream type
  const isHLS = type === 'HLS' || url.includes('.m3u8');
  const isDASH = type === 'DASH' || url.includes('.mpd');
  
  // For HLS streams, use proxy download
  // This handles encrypted playlists, obfuscated segment extensions (.jpg), and CDN protections
  if (isHLS) {
    console.log(`⚙️  Using proxy download for HLS stream...`);
    activeDownloads.set(downloadId, { filename: outputFilename, sourceUrl: url, startTime: Date.now(), status: 'downloading' });
    
    proxyHlsDownload(url, outputPath, { userAgent, referer: refererUrl, origin: originUrl, cookie }, downloadId, outputFilename, audioUrl, subtitleUrl, requestedFormat)
      .then(() => {
        activeDownloads.delete(downloadId);
      })
      .catch(err => {
        if (err.message === 'Download cancelled') {
          console.log(`\n⏹️  Proxy download stopped (cancelled): ${outputFilename}`);
        } else {
          console.error(`\n❌ Proxy HLS download failed: ${err.message}`);
          broadcastProgress(downloadId, { status: 'error', filename: outputFilename, error: err.message });
        }
        // Clean up temp dir and output file
        const dl = activeDownloads.get(downloadId);
        if (dl) {
          if (dl.tempDir) { try { fs.rmSync(dl.tempDir, { recursive: true, force: true }); } catch(e) {} }
          if (dl.outputPath && fs.existsSync(dl.outputPath)) { try { fs.unlinkSync(dl.outputPath); } catch(e) {} }
        }
        activeDownloads.delete(downloadId);
      });
    return;
  }
  
  // For direct video files (MP4, WEBM, etc.), use Node.js HTTP download with byte-level progress
  const isDirectVideo = !isDASH && (
    /\.(mp4|webm|mov|avi|mkv|flv|f4v|ogv|3gp)(\?|$)/i.test(url) ||
    type === 'MP4' || type === 'VIDEO' || type === 'WEBM' || type === 'MOV'
  );
  
  if (isDirectVideo) {
    console.log(`⚙️  Using direct HTTP download for video file...`);
    const finalOutputPath = getUniqueOutputPath(outputPath);
    const dlEntry = { filename: outputFilename, sourceUrl: url, startTime: Date.now(), status: 'downloading', outputPath: finalOutputPath };
    activeDownloads.set(downloadId, dlEntry);
    
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    
    const reqHeaders = {
      'User-Agent': userAgent || DEFAULT_UA,
      'Accept': '*/*'
    };
    if (refererUrl) reqHeaders['Referer'] = refererUrl;
    if (originUrl) reqHeaders['Origin'] = originUrl;
    if (cookie) reqHeaders['Cookie'] = cookie;
    
    const doDirectDownload = (targetUrl, redirectCount) => {
      if (redirectCount > 5) {
        broadcastProgress(downloadId, { status: 'error', filename: outputFilename, error: 'Too many redirects' });
        activeDownloads.delete(downloadId);
        return;
      }
      
      const parsedTarget = new URL(targetUrl);
      const targetLib = parsedTarget.protocol === 'https:' ? https : http;
      
      const req = targetLib.request({
        hostname: parsedTarget.hostname,
        port: parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80),
        path: parsedTarget.pathname + parsedTarget.search,
        method: 'GET',
        headers: reqHeaders
      }, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const newUrl = new URL(res.headers.location, targetUrl).href;
          doDirectDownload(newUrl, redirectCount + 1);
          return;
        }
        
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          broadcastProgress(downloadId, { status: 'error', filename: outputFilename, error: `HTTP ${res.statusCode}` });
          activeDownloads.delete(downloadId);
          return;
        }
        
        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let receivedBytes = 0;
        const startTime = Date.now();
        let lastBroadcast = 0;
        
        const fileStream = fs.createWriteStream(finalOutputPath);
        
        res.on('data', (chunk) => {
          // Check if cancelled
          const d = activeDownloads.get(downloadId);
          if (!d || d.cancelled) {
            res.destroy();
            fileStream.close();
            try { fs.unlinkSync(finalOutputPath); } catch(e) {}
            activeDownloads.delete(downloadId);
            return;
          }
          
          receivedBytes += chunk.length;
          fileStream.write(chunk);
          
          // Broadcast progress at most every 500ms
          const now = Date.now();
          if (now - lastBroadcast > 500) {
            lastBroadcast = now;
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? receivedBytes / elapsed : 0;
            const percent = totalBytes > 0 ? (receivedBytes / totalBytes * 100) : 0;
            const eta = (speed > 0 && totalBytes > 0) ? (totalBytes - receivedBytes) / speed : 0;
            
            broadcastProgress(downloadId, {
              percent: percent.toFixed(1),
              currentTime: formatBytes(receivedBytes),
              totalTime: totalBytes > 0 ? formatBytes(totalBytes) : 'Unknown',
              speed: formatBytes(speed) + '/s',
              eta: formatTime(eta),
              filename: outputFilename
            });
          }
        });
        
        res.on('end', () => {
          fileStream.end(() => {
            const d = activeDownloads.get(downloadId);
            if (d && d.cancelled) {
              try { fs.unlinkSync(finalOutputPath); } catch(e) {}
              activeDownloads.delete(downloadId);
              return;
            }
            
            if (fs.existsSync(finalOutputPath)) {
              const stats = fs.statSync(finalOutputPath);
              const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
              const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
              
              console.log(`\n✅ Direct download complete: ${outputFilename} (${sizeMB} MB) in ${totalTime}s\n`);
              
              broadcastProgress(downloadId, {
                percent: 100,
                status: 'complete',
                filename: outputFilename,
                size: sizeMB + ' MB',
                totalTime: totalTime + 's'
              });
            }
            activeDownloads.delete(downloadId);
          });
        });
        
        res.on('error', (err) => {
          fileStream.close();
          console.error(`❌ Direct download failed: ${err.message}`);
          broadcastProgress(downloadId, { status: 'error', filename: outputFilename, error: err.message });
          try { fs.unlinkSync(finalOutputPath); } catch(e) {}
          activeDownloads.delete(downloadId);
        });
        
        // Store the response so cancel can destroy it
        dlEntry.response = res;
      });
      
      req.on('error', (err) => {
        console.error(`❌ Direct download request failed: ${err.message}`);
        broadcastProgress(downloadId, { status: 'error', filename: outputFilename, error: err.message });
        activeDownloads.delete(downloadId);
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error('Request timeout'));
      });
      req.end();
      
      // Store request so cancel can abort it
      dlEntry.request = req;
    };
    
    doDirectDownload(url, 0);
    return;
  }
  
  // For non-HLS streams (DASH, etc.), use FFmpeg directly
  console.log(`⚙️  Starting FFmpeg direct download...`);
  
  const ffmpegArgs = ['-y'];
  
  const headerLines = [
    `User-Agent: ${userAgent || DEFAULT_UA}`,
  ];
  if (refererUrl) headerLines.push(`Referer: ${refererUrl}`);
  if (originUrl) headerLines.push(`Origin: ${originUrl}`);
  if (cookie) headerLines.push(`Cookie: ${cookie}`);
  ffmpegArgs.push('-headers', headerLines.join('\r\n') + '\r\n');
  
  // Reconnect options for direct HTTP downloads
  if (!isDASH) {
    ffmpegArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  
  const finalOutputPath = getUniqueOutputPath(outputPath);
  ffmpegArgs.push('-i', url, '-c', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', finalOutputPath);
  
  console.log(`   FFmpeg args: ${ffmpegArgs.filter(a => !a.includes('User-Agent')).join(' ')}`);
  
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  
  let duration = 0;
  let startTime = Date.now();
  
  activeDownloads.set(downloadId, {
    filename: outputFilename,
    sourceUrl: url,
    startTime: startTime,
    status: 'downloading',
    ffmpegProcess: ffmpeg,
    outputPath: finalOutputPath
  });
  
  // Parse FFmpeg output for progress
  ffmpeg.stdout.on('data', (data) => {
    const output = data.toString();
    
    // Extract duration (total length)
    const durationMatch = output.match(/duration=(\d+)/);
    if (durationMatch) {
      duration = parseInt(durationMatch[1]);
    }
    
    // Extract current time
    const timeMatch = output.match(/out_time_ms=(\d+)/);
    if (timeMatch) {
      const currentTime = parseInt(timeMatch[1]) / 1000000; // Convert to seconds
      
      if (duration > 0) {
        const percent = Math.min(100, (currentTime / duration) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = currentTime / elapsed;
        const remaining = (duration - currentTime) / speed;
        
        const progress = {
          percent: percent.toFixed(1),
          currentTime: formatTime(currentTime),
          totalTime: formatTime(duration),
          speed: speed.toFixed(2) + 'x',
          eta: formatTime(remaining),
          filename: outputFilename
        };
        
        // Broadcast to WebSocket clients
        broadcastProgress(downloadId, progress);
        
        // Log to console
        process.stdout.write(`\r   Progress: ${progress.percent}% | Speed: ${progress.speed} | ETA: ${progress.eta} `);
      }
    }
  });
  
  let stderrOutput = '';
  
  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();
    stderrOutput += output;
    
    // Log important FFmpeg messages (errors, warnings)
    if (/error|fail|refused|denied|forbidden|404|403|timed out/i.test(output)) {
      console.error(`   FFmpeg stderr: ${output.trim()}`);
    }
    
    if (!duration) {
      const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        duration = hours * 3600 + minutes * 60 + seconds;
      }
    }
  });
  
  ffmpeg.on('close', (code) => {
    if (code === 0) {
      // Success
      if (fs.existsSync(finalOutputPath)) {
        const stats = fs.statSync(finalOutputPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
        
        console.log(`\n✅ Download complete: ${outputFilename} (${fileSizeMB} MB) in ${totalTime}s\n`);
        
        // Broadcast completion
        broadcastProgress(downloadId, {
          percent: 100,
          status: 'complete',
          filename: outputFilename,
          size: fileSizeMB + ' MB',
          totalTime: totalTime + 's'
        });
        
        activeDownloads.delete(downloadId);
      }
    } else {
      // Log last 500 chars of stderr for debugging
      const lastStderr = stderrOutput.slice(-500);
      console.error(`❌ Download failed with code ${code}: ${outputFilename}`);
      console.error(`   Last FFmpeg output: ${lastStderr}\n`);
      
      // Broadcast error
      broadcastProgress(downloadId, {
        status: 'error',
        filename: outputFilename,
        error: 'FFmpeg process failed'
      });
      
      activeDownloads.delete(downloadId);
    }
  });
});

// Get active downloads (for popup state restoration)
app.get('/active-downloads', (req, res) => {
  const active = [];
  activeDownloads.forEach((dl, id) => {
    active.push({
      downloadId: id,
      filename: dl.filename,
      sourceUrl: dl.sourceUrl || null,
      status: dl.status || 'downloading',
      lastProgress: dl.lastProgress || null
    });
  });
  res.json({ active });
});

// Get list of downloaded files
app.get('/downloads', (req, res) => {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    return res.json({ files: [] });
  }
  
  const files = fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => {
      const stats = fs.statSync(path.join(DOWNLOAD_DIR, f));
      return {
        name: f,
        size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
        date: stats.mtime
      };
    })
    .sort((a, b) => b.date - a.date);
  
  res.json({ files, active: Array.from(activeDownloads.values()) });
});

function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  } else {
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

server.listen(PORT, () => {
  console.log(`\n🚀 Video Download Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server running on ws://localhost:${PORT}`);
  console.log(`📁 Downloads will be saved to: ${DOWNLOAD_DIR}`);
  console.log(`\n✨ Extension ready! Open your Chrome extension and start scanning.\n`);
});
