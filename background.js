let streamData = {};
const SERVER_URL = 'http://localhost:3000';
let serverAvailable = false;

// === Panel Position: popup vs sidebar ===
function applyPanelPosition(position) {
  if (position === 'sidebar') {
    // Remove default_popup so clicking icon opens side panel
    chrome.action.setPopup({ popup: '' });
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } else {
    // Restore popup mode
    chrome.action.setPopup({ popup: 'popup.html' });
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
}

// Apply on startup
chrome.storage.local.get('panelPosition', (r) => {
  applyPanelPosition(r.panelPosition || 'popup');
});

// React to settings changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.panelPosition) {
    applyPanelPosition(changes.panelPosition.newValue || 'popup');
  }
});

// Check if local server is running
async function checkServerStatus() {
  try {
    const response = await fetch(`${SERVER_URL}/health`);
    serverAvailable = response.ok;
  } catch (error) {
    serverAvailable = false;
  }
  return serverAvailable;
}

setInterval(checkServerStatus, 5000);
checkServerStatus();

const activeDownloads = new Map();
const downloadProgressListeners = new Map();

// WebSocket client to listen for server download completions (runs even when popup is closed)
let bgWs = null;
function connectBackgroundWebSocket() {
  if (!serverAvailable) {
    setTimeout(connectBackgroundWebSocket, 5000);
    return;
  }
  try {
    bgWs = new WebSocket('ws://localhost:3000');
    bgWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress' && data.status === 'complete' && data.downloadId) {
          // Auto-record to history when download completes
          chrome.storage.session.get('activeStreamDownloads', (result) => {
            const active = result.activeStreamDownloads || {};
            const dlInfo = active[data.downloadId];
            const source = dlInfo ? (() => { try { return new URL(dlInfo.videoUrl || '').hostname; } catch(e) { return ''; } })() : '';
            recordHistory(data.filename || (dlInfo && dlInfo.filename) || 'Unknown', data.size || '', source);
            // Clean up active download entry
            delete active[data.downloadId];
            chrome.storage.session.set({ activeStreamDownloads: active });
          });
        }
      } catch(e) {}
    };
    bgWs.onclose = () => { setTimeout(connectBackgroundWebSocket, 3000); };
    bgWs.onerror = () => { bgWs.close(); };
  } catch(e) {
    setTimeout(connectBackgroundWebSocket, 5000);
  }
}
connectBackgroundWebSocket();

// Shared function to write a history entry
function recordHistory(filename, size, source) {
  chrome.storage.local.get(['downloadHistory', 'historyEnabled'], (result) => {
    if (result.historyEnabled === false) return;
    const history = result.downloadHistory || [];
    history.push({
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 6),
      filename: filename,
      source: source || '',
      size: size || '',
      timestamp: Date.now()
    });
    if (history.length > 500) history.splice(0, history.length - 500);
    chrome.storage.local.set({ downloadHistory: history });
  });
}

// ============ YOUTUBE: MAIN WORLD EXTRACTION ============
// YouTube is an SPA — script tags with ytInitialPlayerResponse only exist on fresh
// page loads, not after in-app navigation.  Use chrome.scripting.executeScript in
// the MAIN world to read the live JS variable directly from the page context.

function extractYouTubeFromMainWorld(tabId, callback) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: function() {
      try {
        var pr = null;
        var source = '';

        // Source 1: global ytInitialPlayerResponse (fresh page load)
        if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.streamingData) {
          pr = window.ytInitialPlayerResponse;
          source = 'global';
        }

        // Source 2: movie_player API (works after SPA navigation)
        if (!pr) {
          try {
            var player = document.querySelector('#movie_player');
            if (player && typeof player.getPlayerResponse === 'function') {
              var resp = player.getPlayerResponse();
              if (resp && resp.streamingData) { pr = resp; source = 'playerAPI'; }
            }
          } catch(e) {}
        }

        // Source 3: ytd-player Polymer element (fallback)
        if (!pr) {
          try {
            var ytdPlayer = document.querySelector('ytd-player');
            if (ytdPlayer && ytdPlayer.player_ && typeof ytdPlayer.player_.getPlayerResponse === 'function') {
              var resp2 = ytdPlayer.player_.getPlayerResponse();
              if (resp2 && resp2.streamingData) { pr = resp2; source = 'polymer'; }
            }
          } catch(e) {}
        }

        if (!pr || !pr.streamingData) {
          return { streams: [], debug: { found: false } };
        }

        var sd = pr.streamingData;
        var streams = [];
        var hasSignatureCipher = false;

        // 1) DASH manifest (live streams)
        if (sd.dashManifestUrl) {
          streams.push({ url: sd.dashManifestUrl, type: 'DASH', format: 'mpd', quality: 'Manifest' });
        }
        // 2) HLS manifest (live streams)
        if (sd.hlsManifestUrl) {
          streams.push({ url: sd.hlsManifestUrl, type: 'HLS', format: 'm3u8', quality: 'Master' });
        }
        // 3) Adaptive formats (1080p+, separate video+audio)
        if (streams.length === 0 && sd.adaptiveFormats && sd.adaptiveFormats.length > 0) {
          var audioArr = [];
          var videoArr = [];
          for (var i = 0; i < sd.adaptiveFormats.length; i++) {
            var f = sd.adaptiveFormats[i];
            if (!f.mimeType) continue;
            if (!f.url) { hasSignatureCipher = true; continue; }
            if (f.mimeType.indexOf('audio/mp4') === 0) audioArr.push(f);
            if (f.mimeType.indexOf('video/mp4') === 0 && f.qualityLabel) videoArr.push(f);
          }
          audioArr.sort(function(a,b) { return (b.bitrate||0) - (a.bitrate||0); });
          videoArr.sort(function(a,b) { return (b.height||0) - (a.height||0); });
          if (videoArr.length > 0 && audioArr.length > 0) {
            streams.push({
              url: videoArr[0].url, audioUrl: audioArr[0].url,
              type: 'MP4', format: 'mp4',
              quality: videoArr[0].qualityLabel || (videoArr[0].height + 'p')
            });
          }
        }
        // 4) Progressive formats (combined video+audio, up to 720p)
        if (streams.length === 0 && sd.formats && sd.formats.length > 0) {
          var vf = [];
          for (var j = 0; j < sd.formats.length; j++) {
            var g = sd.formats[j];
            if (!g.mimeType) continue;
            if (!g.url) { hasSignatureCipher = true; continue; }
            if (g.mimeType.indexOf('video/') === 0) vf.push(g);
          }
          vf.sort(function(a,b) { return (b.height||0) - (a.height||0); });
          if (vf.length > 0) {
            streams.push({
              url: vf[0].url, type: 'MP4', format: 'mp4',
              quality: vf[0].qualityLabel || (vf[0].height ? vf[0].height + 'p' : 'Best')
            });
          }
        }

        return {
          streams: streams,
          debug: { found: true, source: source, hasSignatureCipher: hasSignatureCipher,
                   adaptiveCount: sd.adaptiveFormats ? sd.adaptiveFormats.length : 0,
                   formatCount: sd.formats ? sd.formats.length : 0 }
        };
      } catch(e) {
        return { streams: [], debug: { error: e.message } };
      }
    }
  }, function(results) {
    if (chrome.runtime.lastError) {
      console.log('[YouTube MAIN] Error:', chrome.runtime.lastError.message);
      callback([]);
      return;
    }
    if (results && results[0] && results[0].result) {
      var data = results[0].result;
      console.log('[YouTube MAIN]', JSON.stringify(data.debug), 'Streams:', data.streams.length);
      callback(data.streams || []);
    } else {
      console.log('[YouTube MAIN] No result returned');
      callback([]);
    }
  });
}

// AUTO-SCAN: Monitor page loads and video elements
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Clear old data only when the URL actually changes (start of a new navigation),
  // NOT on 'complete' — because HLS/DASH requests arrive during loading and would be wiped.
  if (changeInfo.url && !changeInfo.url.startsWith('chrome://')) {
    if (streamData[tabId]) {
      delete streamData[tabId];
    }
  }

  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
    // Auto-scan content after 2 seconds (let page load)
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, {action: 'autoScan'}, (response) => {
        if (chrome.runtime.lastError) return;
        if (response && (response.hasVideo || response.hasIframe)) {
          console.log('[Auto-Scan] Videos detected on tab', tabId);
          updateBadge(tabId);
        }
      });
    }, 2000);
  }
});

// Update badge with video count
// Dedup count for badge: group by title+duration, count groups (not raw items)
function badgeDedupCount(tabId) {
  const data = streamData[tabId] || { streams: [], videos: [] };
  const allItems = [
    ...data.streams.map(s => ({ ...s, videoType: 'stream' })),
    ...data.videos.map(v => ({ ...v, videoType: 'direct' }))
  ];
  if (allItems.length === 0) return 0;

  // We need the page title to group correctly — but we may not have it yet.
  // Use a synchronous best-effort: group by URL-path when titles aren't available.
  const groups = new Set();
  allItems.forEach(v => {
    const title = String(v.pageTitle || v.title || '').toLowerCase().trim();
    const dur = String(v.durationSeconds || v.duration || '');
    if (title) {
      groups.add(title + '|' + dur);
    } else {
      // No title yet — use normalized URL as key
      try {
        const u = new URL(v.url);
        groups.add('url:' + (u.origin + u.pathname).toLowerCase());
      } catch (_) {
        groups.add('url:' + String(v.url || '').split('?')[0].toLowerCase());
      }
    }
  });
  return groups.size;
}

function updateBadge(tabId) {
  // Try to get page title so dedup grouping works properly
  try {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        applyBadgeFromDedup(tabId);
        return;
      }
      // Temporarily stamp pageTitle onto items that lack one
      const data = streamData[tabId];
      if (data && tab.title) {
        data.streams.forEach(s => { if (!s.pageTitle) s.pageTitle = tab.title; });
        data.videos.forEach(v => { if (!v.pageTitle) v.pageTitle = tab.title; });
      }
      applyBadgeFromDedup(tabId);
    });
  } catch (_) {
    applyBadgeFromDedup(tabId);
  }
}

function applyBadgeFromDedup(tabId) {
  const count = badgeDedupCount(tabId);
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString(), tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#34a853', tabId: tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId: tabId });
  }
}

// URLs to always ignore (tracking, analytics, pixels, ads)
const BLOCKED_URL_PATTERNS = [
  /\/ping\.gif/i,
  /\/pixel/i,
  /\/beacon/i,
  /\/track/i,
  /\/analytics/i,
  /\/collect\?/i,
  /jwpltx\.com/i,
  /googlesyndication/i,
  /doubleclick\.net/i,
  /google-analytics/i,
  /facebook\.com\/tr/i,
  /\.gif(\?|$|#)/i,
  /\.png(\?|$|#)/i,
  /\.jpg(\?|$|#)/i,
  /\.jpeg(\?|$|#)/i,
  /\.webp(\?|$|#)/i,
  /\.svg(\?|$|#)/i,
  /\.ico(\?|$|#)/i,
  /\.css(\?|$|#)/i,
  /\.js(\?|$|#)/i,
  /\.woff/i
];

function isBlockedUrl(url) {
  return BLOCKED_URL_PATTERNS.some(pattern => pattern.test(url));
}

// Capture all media requests (streams in background)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const tabId = details.tabId;
    
    if (tabId < 0) return;
    
    // Skip tracking/analytics/image URLs
    if (isBlockedUrl(url)) return;
    
    // Require .m3u8 or .mpd in the URL path (not just as a substring in query params)
    const urlPath = url.split('?')[0].split('#')[0];
    const isM3U8 = urlPath.endsWith('.m3u8') || /\.m3u8\b/.test(url);
    const isMPD = urlPath.endsWith('.mpd') || /\.mpd\b/.test(url);
    const isTS = url.match(/\.ts(\?|$|#)/i);
    const isM4S = url.includes('.m4s');
    
    // Detect subtitle files (.vtt, .srt, .ass) and YouTube timedtext API
    // Also match URLs with subtitle extensions before query params (e.g. file.ass?token=xxx)
    const isSubtitle = urlPath.match(/\.(vtt|srt|ass|ssa|sub|ttml)$/i) ||
      url.match(/\.(vtt|srt|ass|ssa|sub|ttml)\?/i) ||
      url.match(/\/api\/timedtext/i) ||
      url.match(/\/timedtext\?/i) ||
      (url.includes('fmt=vtt') && url.includes('lang=')) ||
      url.match(/\/sub(?:title)?s?\/[^?]*\.(vtt|srt|ass|ssa)/i);
    
    // Only match URLs with actual video file extensions
    const isMP4 = (
      urlPath.match(/\.mp4$/i) || 
      urlPath.match(/\.webm$/i) || 
      urlPath.match(/\.mov$/i) ||
      urlPath.match(/\.avi$/i) ||
      urlPath.match(/\.mkv$/i) ||
      urlPath.match(/\.flv$/i)
    ) && !url.includes('blob:') && !url.includes('data:');
    
    // Only flag as video type if it's a media request AND has a recognizable video content indicator
    // Do NOT capture random xmlhttprequest as videos - they could be HTML, JSON, etc.
    const isVideoType = details.type === 'media' && 
      !isBlockedUrl(url) && 
      !urlPath.match(/\.(gif|png|jpg|jpeg|svg|ico|css|js|woff|html?|json|xml|txt|php|asp)$/i) &&
      (urlPath.match(/\.(mp4|webm|mov|avi|mkv|flv|f4v|ogv|3gp)$/i) || url.match(/\/video[\/\?]/i) || url.match(/mime=video/i));
    
    if (isM3U8 || isMPD || isTS || isM4S || isMP4 || isVideoType || isSubtitle) {
      if (!streamData[tabId]) {
        streamData[tabId] = { streams: [], segments: [], videos: [], subtitles: [], pageUrl: '' };
      }
      // Store the tab's page URL for use as Referer header
      try {
        chrome.tabs.get(tabId, (tab) => {
          if (tab && tab.url) streamData[tabId].pageUrl = tab.url;
        });
      } catch(e) {}
      
      const timestamp = new Date().toLocaleTimeString();
      
      if (isM3U8) {
        const existing = streamData[tabId].streams.find(s => s.url === url);
        if (!existing) {
          streamData[tabId].streams.push({
            url: url,
            type: 'HLS',
            format: 'm3u8',
            time: timestamp,
            quality: url.includes('master') ? 'Master' : 'Playlist'
          });
          console.log('[HLS Auto-Detected]', url.substring(0, 80));
          updateBadge(tabId);
        }
      } else if (isMPD) {
        const existing = streamData[tabId].streams.find(s => s.url === url);
        if (!existing) {
          streamData[tabId].streams.push({
            url: url,
            type: 'DASH',
            format: 'mpd',
            time: timestamp,
            quality: 'Manifest'
          });
          console.log('[DASH Auto-Detected]', url.substring(0, 80));
          updateBadge(tabId);
        }
      } else if (isTS || isM4S) {
        streamData[tabId].segments.push({
          url: url,
          type: isTS ? 'TS' : 'M4S',
          time: timestamp
        });
      } else if (isSubtitle) {
        // Deduplicate by base URL path (ignore query params for sites that append tokens)
        const subBasePath = urlPath.replace(/^https?:\/\//, '');
        const existing = streamData[tabId].subtitles.find(s => {
          const ePath = s.url.split('?')[0].split('#')[0].replace(/^https?:\/\//, '');
          return ePath === subBasePath;
        });
        if (!existing) {
          // Try to extract language from URL using multiple strategies
          let lang = '';
          let name = '';
          // Strategy 1: query params (YouTube timedtext: lang=en, name=English)
          const langParam = url.match(/[?&]lang=([a-zA-Z\-]+)/);
          if (langParam) lang = langParam[1];
          const nameParam = url.match(/[?&]name=([^&]+)/);
          if (nameParam) name = decodeURIComponent(nameParam[1]);
          // Strategy 2: filename pattern like .en.vtt, .english.srt
          if (!lang) {
            const fileLangMatch = urlPath.match(/[\.\/\-_]([a-z]{2,3})\.(vtt|srt|ass|ssa|ttml)$/i);
            if (fileLangMatch) lang = fileLangMatch[1];
          }
          // Strategy 3: path segments like /en/ or /english/ or /subtitles/en/
          if (!lang) {
            const pathLangMatch = urlPath.match(/\/(?:sub(?:title)?s?|captions?)\/([a-z]{2,3})(?:\/|$)/i) ||
              urlPath.match(/\/([a-z]{2})(?:\/[^\/]*\.(vtt|srt|ass|ssa))/i);
            if (pathLangMatch) lang = pathLangMatch[1];
          }
          // Strategy 4: try to extract meaningful name from filename
          if (!name && !lang) {
            const fnMatch = urlPath.match(/\/([^\/]+)\.(vtt|srt|ass|ssa|ttml)$/i);
            if (fnMatch) {
              const fn = decodeURIComponent(fnMatch[1]);
              // Clean up filename: remove hashes, IDs, replace underscores/hyphens
              const cleaned = fn.replace(/[0-9a-f]{8,}/gi, '').replace(/[_\-]+/g, ' ').trim();
              if (cleaned.length > 1 && cleaned.length < 50) name = cleaned;
            }
          }
          // Detect format
          let format = 'vtt';
          if (urlPath.match(/\.srt$/i)) format = 'srt';
          else if (urlPath.match(/\.ass$/i) || urlPath.match(/\.ssa$/i)) format = 'ass';
          else if (urlPath.match(/\.ttml$/i)) format = 'ttml';
          else if (url.includes('fmt=vtt')) format = 'vtt';
          else if (url.includes('fmt=srv3') || url.includes('fmt=json3')) format = 'vtt';
          
          // Build display name
          const subIndex = streamData[tabId].subtitles.length + 1;
          const displayName = name || lang || ('Subtitle Track ' + subIndex);
          
          streamData[tabId].subtitles.push({
            url: url,
            language: lang,
            name: displayName,
            format: format,
            time: timestamp
          });
          console.log('[Subtitle Auto-Detected]', format.toUpperCase(), lang || 'unknown lang', url.substring(0, 80));
        }
      } else if (isMP4 || isVideoType) {
        const existing = streamData[tabId].videos.find(v => v.url === url);
        if (!existing) {
          let format = 'mp4';
          if (url.includes('.webm')) format = 'webm';
          else if (url.includes('.mov')) format = 'mov';
          else if (url.includes('.avi')) format = 'avi';
          else if (url.includes('.mkv')) format = 'mkv';
          
          streamData[tabId].videos.push({
            url: url,
            type: 'MP4',
            format: format,
            time: timestamp
          });
          console.log('[Video Auto-Detected]', format.toUpperCase(), url.substring(0, 80));
          updateBadge(tabId);
        }
      }
    }
  },
  {urls: ["<all_urls>"]},
  []
);

// Capture the ACTUAL browser request headers for stream URLs
// This is critical - CDN servers check Referer/Origin/Cookie and reject if wrong
const capturedHeaders = {};

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const url = details.url;
    if (details.tabId < 0) return;
    
    const urlPath = url.split('?')[0].split('#')[0];
    const isStream = urlPath.endsWith('.m3u8') || /\.m3u8\b/.test(url) || 
                     urlPath.endsWith('.mpd') || /\.mpd\b/.test(url);
    
    if (isStream && details.requestHeaders) {
      const headers = {};
      for (const h of details.requestHeaders) {
        const name = h.name.toLowerCase();
        if (['referer', 'origin', 'cookie', 'user-agent'].includes(name)) {
          headers[name] = h.value;
        }
      }
      // Store by URL so we can look them up later
      capturedHeaders[url] = headers;
      console.log('[Headers Captured]', url.substring(0, 60), 'Referer:', headers.referer || 'none');
      
      // Also store on the stream object if it exists
      const data = streamData[details.tabId];
      if (data) {
        const stream = data.streams.find(s => s.url === url);
        if (stream) {
          stream.headers = headers;
        }
      }
    }
  },
  {urls: ["<all_urls>"]},
  ["requestHeaders", "extraHeaders"]
);

// Monitor Chrome download progress
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === 'in_progress') {
    chrome.downloads.search({id: delta.id}, (results) => {
      if (results.length > 0) {
        const download = results[0];
        const percent = download.totalBytes > 0 
          ? Math.round((download.bytesReceived / download.totalBytes) * 100) 
          : 0;
        
        const progress = {
          downloadId: delta.id,
          filename: download.filename.split('/').pop(),
          percent: percent,
          bytesReceived: formatBytes(download.bytesReceived),
          totalBytes: formatBytes(download.totalBytes),
          speed: calculateSpeed(delta.id, download.bytesReceived),
          status: 'downloading'
        };
        
        broadcastDownloadProgress(delta.id, progress);
      }
    });
  } else if (delta.state && delta.state.current === 'complete') {
    chrome.downloads.search({id: delta.id}, (results) => {
      if (results.length > 0) {
        const download = results[0];
        const progress = {
          downloadId: delta.id,
          filename: download.filename.split('/').pop(),
          percent: 100,
          totalBytes: formatBytes(download.totalBytes),
          status: 'complete'
        };
        
        broadcastDownloadProgress(delta.id, progress);
        
        // Only record to history if this download was initiated by the extension
        if (activeDownloads.has(delta.id)) {
          const fname = download.filename.split('/').pop().split('\\').pop();
          const fsize = formatBytes(download.totalBytes);
          let fsource = '';
          try { fsource = new URL(download.referrer || download.url).hostname; } catch(e) {}
          recordHistory(fname, fsize, fsource);
        }
        
        // Show notification
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect fill="%2334a853" width="128" height="128"/><text x="64" y="90" text-anchor="middle" font-size="80" fill="white">✓</text></svg>',
          title: 'Download Complete',
          message: download.filename.split('/').pop(),
          priority: 1
        });
        
        setTimeout(() => activeDownloads.delete(delta.id), 5000);
      }
    });
  }
});

function calculateSpeed(downloadId, currentBytes) {
  const now = Date.now();
  const previous = activeDownloads.get(downloadId);
  
  if (!previous) {
    activeDownloads.set(downloadId, { bytes: currentBytes, time: now });
    return 'Calculating...';
  }
  
  const timeDiff = (now - previous.time) / 1000;
  const bytesDiff = currentBytes - previous.bytes;
  
  if (timeDiff > 0) {
    const speed = bytesDiff / timeDiff;
    activeDownloads.set(downloadId, { bytes: currentBytes, time: now });
    return formatBytes(speed) + '/s';
  }
  
  return 'Calculating...';
}

function broadcastDownloadProgress(downloadId, progress) {
  downloadProgressListeners.forEach((port, portId) => {
    try {
      port.postMessage({
        type: 'downloadProgress',
        downloadId: downloadId,
        ...progress
      });
    } catch (error) {
      downloadProgressListeners.delete(portId);
    }
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'downloadProgress') {
    const portId = Date.now();
    downloadProgressListeners.set(portId, port);
    
    port.onDisconnect.addListener(() => {
      downloadProgressListeners.delete(portId);
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getStreams') {
    const tabId = request.tabId;
    const data = streamData[tabId] || {streams: [], segments: [], videos: [], subtitles: []};
    
    const uniqueStreams = [...new Map(data.streams.map(s => [s.url, s])).values()];
    const uniqueVideos = [...new Map(data.videos.map(v => [v.url, v])).values()];
    const uniqueSubtitles = [...new Map((data.subtitles || []).map(s => {
      // Deduplicate by base URL path (ignore query params that may vary like tokens)
      const baseKey = s.url.split('?')[0].split('#')[0].replace(/^https?:\/\//, '');
      return [baseKey, s];
    })).values()];
    
    chrome.tabs.get(tabId, (tab) => {
      const pageTitle = tab.title || 'Unknown';
      
      // Try to get page thumbnail and duration from the content script
      chrome.tabs.sendMessage(tabId, {action: 'getVideos'}, (contentResp) => {
        if (chrome.runtime.lastError) { /* tab may have navigated away */ }
        const pageThumbnail = (contentResp && contentResp.pageThumbnail) || null;
        const pageDuration = (contentResp && contentResp.pageDuration) || null;

        // Merge YouTube streams found by content script (ytInitialPlayerResponse parsing)
        const ytStreams = (contentResp && contentResp.youtubeStreams) || [];
        ytStreams.forEach(ys => {
          const alreadyCaptured = uniqueStreams.some(s => s.url === ys.url);
          if (!alreadyCaptured) {
            uniqueStreams.push({
              url: ys.url,
              type: ys.type,
              format: ys.format,
              quality: ys.quality,
              audioUrl: ys.audioUrl || null,
              time: new Date().toLocaleTimeString()
            });
          }
        });

        // Merge streams discovered from Performance API (fallback when SW restarted
        // and lost in-memory streamData)
        const perfStreams = (contentResp && contentResp.discoveredStreams) || [];
        perfStreams.forEach(ps => {
          const alreadyCaptured = uniqueStreams.some(s => s.url === ps.url);
          if (!alreadyCaptured) {
            uniqueStreams.push({
              url: ps.url,
              type: ps.type,
              format: ps.format,
              quality: ps.quality,
              time: new Date().toLocaleTimeString(),
              source: 'performance'
            });
            // Also persist into streamData so badge/dedup work correctly
            if (!streamData[tabId]) {
              streamData[tabId] = { streams: [], segments: [], videos: [], subtitles: [], pageUrl: tab.url || '' };
            }
            streamData[tabId].streams.push({
              url: ps.url,
              type: ps.type,
              format: ps.format,
              quality: ps.quality,
              time: new Date().toLocaleTimeString()
            });
          }
        });
        if (perfStreams.length > 0) {
          console.log('[getStreams] Recovered', perfStreams.length, 'stream(s) from Performance API fallback');
        }

        // Merge subtitle sources: network-captured + content script DOM-found
        const domSubtitles = (contentResp && contentResp.subtitleTracks) || [];
        const allSubtitles = [...uniqueSubtitles];
        // Add DOM-found subtitles that aren't already captured from network
        domSubtitles.forEach(ds => {
          const dsBase = ds.url.split('?')[0].split('#')[0].replace(/^https?:\/\//, '');
          const alreadyCaptured = allSubtitles.some(ns => {
            const nsBase = ns.url.split('?')[0].split('#')[0].replace(/^https?:\/\//, '');
            return nsBase === dsBase;
          });
          if (!alreadyCaptured) {
            allSubtitles.push({
              url: ds.url,
              language: ds.language || '',
              name: ds.name || ds.language || 'Subtitles',
              format: ds.format || 'vtt',
              time: new Date().toLocaleTimeString(),
              source: 'dom'
            });
          }
        });

        // Helper: build and send the final response
        function finishGetStreams() {
          sendResponse({
            streams: uniqueStreams.map(s => ({
              ...s, pageTitle,
              thumbnail: pageThumbnail,
              duration: pageDuration ? pageDuration.formatted : null,
              durationSeconds: pageDuration ? pageDuration.seconds : null,
              headers: s.headers || capturedHeaders[s.url] || null
            })),
            videos: uniqueVideos.map(v => ({...v, pageTitle, thumbnail: pageThumbnail, duration: pageDuration ? pageDuration.formatted : null, durationSeconds: pageDuration ? pageDuration.seconds : null})),
            segmentCount: data.segments.length,
            serverAvailable: serverAvailable,
            capturedSubtitles: allSubtitles,
            pageTitle: pageTitle,
            pageThumbnail: pageThumbnail,
            pageDuration: pageDuration,
            debug: {
              totalCaptures: uniqueStreams.length + uniqueVideos.length,
              hasSegments: data.segments.length > 0,
              subtitleSources: { network: uniqueSubtitles.length, dom: domSubtitles.length }
            }
          });
        }

        // If on YouTube and no streams found yet, try MAIN world extraction
        // (handles SPA navigation where script tags don't have the current video's data)
        const isYouTubePage = tab.url && tab.url.includes('youtube.com/watch');
        if (isYouTubePage && uniqueStreams.length === 0) {
          extractYouTubeFromMainWorld(tabId, (mainStreams) => {
            mainStreams.forEach(ms => {
              if (!uniqueStreams.some(s => s.url === ms.url)) {
                uniqueStreams.push({
                  url: ms.url,
                  type: ms.type,
                  format: ms.format,
                  quality: ms.quality,
                  audioUrl: ms.audioUrl || null,
                  time: new Date().toLocaleTimeString()
                });
              }
            });
            finishGetStreams();
          });
        } else {
          finishGetStreams();
        }
      });
    });
    
    return true;
    
  } else if (request.action === 'setBadgeCount') {
    // Popup sends dedup-ed count after scanning
    const tabId = request.tabId;
    const count = request.count || 0;
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count), tabId: tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#34a853', tabId: tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId: tabId });
    }
    sendResponse({ success: true });
    return true;

  } else if (request.action === 'checkServer') {
    checkServerStatus().then(status => {
      sendResponse({ available: status });
    });
    return true;

  } else if (request.action === 'getActiveDownloads') {
    // Return persisted active stream downloads for popup state restoration
    chrome.storage.session.get('activeStreamDownloads', (result) => {
      sendResponse({ active: result.activeStreamDownloads || {} });
    });
    return true;

  } else if (request.action === 'clearActiveDownload') {
    // Remove a specific download from persisted state
    chrome.storage.session.get('activeStreamDownloads', (result) => {
      const active = result.activeStreamDownloads || {};
      delete active[request.downloadId];
      chrome.storage.session.set({ activeStreamDownloads: active });
      sendResponse({ success: true });
    });
    return true;

  } else if (request.action === 'addToHistory') {
    // Add a completed download to history (called from popup as fallback)
    recordHistory(request.filename, request.size, request.source);
    sendResponse({ success: true });
    return true;

  } else if (request.action === 'getQualities') {
    // Fetch available quality levels for an HLS stream
    const realHeaders = request.headers || capturedHeaders[request.url] || null;
    
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      const pageUrl = tabs[0] ? tabs[0].url : '';
      const storedPageUrl = streamData[tabs[0]?.id]?.pageUrl || '';
      const bestReferer = (realHeaders && realHeaders.referer) || pageUrl || storedPageUrl;
      const bestOrigin = (realHeaders && realHeaders.origin) || (pageUrl ? new URL(pageUrl).origin : '');
      const bestCookie = (realHeaders && realHeaders.cookie) || '';
      const bestUA = (realHeaders && realHeaders['user-agent']) || '';
      
      fetch(`${SERVER_URL}/qualities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: request.url,
          referer: bestReferer,
          origin: bestOrigin,
          cookie: bestCookie,
          userAgent: bestUA
        })
      })
      .then(r => r.json())
      .then(data => sendResponse({ success: true, qualities: data.qualities || [], audioTracks: data.audioTracks || [], audioGroupMap: data.audioGroupMap || null, subtitleTracks: data.subtitleTracks || [] }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    });
    return true;
    
  } else if (request.action === 'cancelDownload') {
    fetch(`${SERVER_URL}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadId: request.downloadId })
    })
    .then(r => r.json())
    .then(data => sendResponse({ success: true }))
    .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
    
  } else if (request.action === 'downloadViaServer') {
    // Use the REAL captured browser headers if available
    const realHeaders = request.headers || capturedHeaders[request.url] || null;
    
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      const pageUrl = tabs[0] ? tabs[0].url : '';
      const storedPageUrl = streamData[tabs[0]?.id]?.pageUrl || '';
      
      // Prefer captured headers over page URL - CDNs check the exact Referer
      const bestReferer = (realHeaders && realHeaders.referer) || pageUrl || storedPageUrl;
      const bestOrigin = (realHeaders && realHeaders.origin) || (pageUrl ? new URL(pageUrl).origin : '');
      const bestCookie = (realHeaders && realHeaders.cookie) || '';
      const bestUA = (realHeaders && realHeaders['user-agent']) || '';
      
      console.log('[Download] Using Referer:', bestReferer.substring(0, 80));
      
      fetch(`${SERVER_URL}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: request.url,
          filename: request.filename,
          type: request.type,
          referer: bestReferer,
          origin: bestOrigin,
          cookie: bestCookie,
          userAgent: bestUA,
          audioUrl: request.audioUrl || null,
          subtitleUrl: request.subtitleUrl || null,
          outputFormat: request.outputFormat || 'mp4'
        })
      })
    .then(response => response.json())
    .then(data => {
      console.log('[Server Download]', data);
      // Persist active download so popup can restore state after reopen
      if (data.downloadId) {
        chrome.storage.session.get('activeStreamDownloads', (result) => {
          const active = result.activeStreamDownloads || {};
          active[data.downloadId] = {
            downloadId: data.downloadId,
            videoUrl: request.originalUrl || request.url,
            downloadUrl: request.url,
            filename: data.filename || request.filename,
            type: request.type,
            startedAt: Date.now()
          };
          chrome.storage.session.set({ activeStreamDownloads: active });
        });
      }
      sendResponse({ success: true, data: data });
    })
    .catch(error => {
      console.error('[Server Download Error]', error);
      sendResponse({ success: false, error: error.message });
    });
    });
    return true;
    
  } else if (request.action === 'download') {
    console.log('[Download Request]', request.filename);
    
    chrome.downloads.download({
      url: request.url,
      filename: request.filename,
      saveAs: !!request.saveAs
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[Download Error]', chrome.runtime.lastError);
        sendResponse({ 
          success: false, 
          error: chrome.runtime.lastError.message 
        });
      } else {
        console.log('[Download Started] ID:', downloadId);
        activeDownloads.set(downloadId, { 
          bytes: 0, 
          time: Date.now(),
          filename: request.filename 
        });
        
        sendResponse({ 
          success: true, 
          downloadId: downloadId,
          filename: request.filename
        });
      }
    });
    
    return true;
    
  } else if (request.action === 'clearStreams') {
    delete streamData[request.tabId];
    updateBadge(request.tabId);
    sendResponse({success: true});
  }
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete streamData[tabId];
});
