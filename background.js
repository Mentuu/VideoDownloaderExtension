let streamData = {};
const SERVER_URL = 'http://localhost:3000';
let serverAvailable = false;
const DEBUG_LOGS = false;

function logDebug(...args) {
  if (DEBUG_LOGS) console.log(...args);
}

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

        function safeQualityLabel(fmt) {
          if (!fmt) return 'Unknown';
          if (fmt.qualityLabel) return fmt.qualityLabel;
          if (fmt.height) return fmt.height + 'p';
          return 'Unknown';
        }

        function getContainerFromMime(mimeType) {
          if (!mimeType) return null;
          if (mimeType.indexOf('mp4') !== -1) return 'mp4';
          if (mimeType.indexOf('webm') !== -1) return 'webm';
          return null;
        }

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
          } catch (e) {}
        }

        // Source 3: ytd-player Polymer element
        if (!pr) {
          try {
            var ytdPlayer = document.querySelector('ytd-player');
            if (ytdPlayer && ytdPlayer.player_ && typeof ytdPlayer.player_.getPlayerResponse === 'function') {
              var resp2 = ytdPlayer.player_.getPlayerResponse();
              if (resp2 && resp2.streamingData) { pr = resp2; source = 'polymer'; }
            }
          } catch (e) {}
        }

        if (!pr || !pr.streamingData) {
          return { streams: [], debug: { found: false, reason: 'no-player-response' } };
        }

        var sd = pr.streamingData;

        var streams = [];

        if (sd.dashManifestUrl) {
          streams.push({ url: sd.dashManifestUrl, type: 'DASH', format: 'mpd', quality: 'Manifest', source: 'youtube-manifest' });
        }
        if (sd.hlsManifestUrl) {
          streams.push({ url: sd.hlsManifestUrl, type: 'HLS', format: 'm3u8', quality: 'Master', source: 'youtube-manifest' });
        }

        var resolvedAdaptive = [];
        for (var i = 0; i < (sd.adaptiveFormats || []).length; i++) {
          var af = sd.adaptiveFormats[i];
          if (!af || !af.url || !af.mimeType) continue;
          resolvedAdaptive.push(af);
        }

        if (resolvedAdaptive.length > 0) {
          var audioByContainer = { mp4: [], webm: [] };
          var allAudio = [];
          var videoArr = [];
          var seenAdaptive = {};
          for (var ra = 0; ra < resolvedAdaptive.length; ra++) {
            var f = resolvedAdaptive[ra];
            var fmtContainer = getContainerFromMime(f.mimeType);
            if (!fmtContainer) continue;
            if (f.mimeType.indexOf('audio/') === 0) {
              audioByContainer[fmtContainer].push(f);
              allAudio.push(f);
            }
            if (f.mimeType.indexOf('video/') === 0) videoArr.push(f);
          }
          audioByContainer.mp4.sort(function(a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
          audioByContainer.webm.sort(function(a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
          allAudio.sort(function(a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
          videoArr.sort(function(a, b) {
            if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
            return (b.bitrate || 0) - (a.bitrate || 0);
          });
          for (var av = 0; av < videoArr.length; av++) {
            var v = videoArr[av];
            var vKey = v.url || '';
            if (!vKey || seenAdaptive[vKey]) continue;
            seenAdaptive[vKey] = true;
            var container = getContainerFromMime(v.mimeType) || 'mp4';
            var matchedAudio = (audioByContainer[container] && audioByContainer[container][0]) || allAudio[0] || null;
            streams.push({
              url: v.url,
              audioUrl: matchedAudio ? matchedAudio.url : null,
              type: container.toUpperCase(),
              format: container,
              quality: safeQualityLabel(v),
              fps: v.fps || null,
              source: 'youtube-player-adaptive'
            });
          }
        }

        var resolvedFormats = [];
        for (var j = 0; j < (sd.formats || []).length; j++) {
          var pf = sd.formats[j];
          if (!pf || !pf.url || !pf.mimeType) continue;
          if (pf.mimeType.indexOf('video/') !== 0) continue;
          var pContainer = getContainerFromMime(pf.mimeType);
          if (pContainer !== 'mp4' && pContainer !== 'webm') continue;
          resolvedFormats.push(pf);
        }

        if (resolvedFormats.length > 0) {
          var seenProg = {};
          resolvedFormats.sort(function(a, b) {
            if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
            return (b.bitrate || 0) - (a.bitrate || 0);
          });
          for (var pv = 0; pv < resolvedFormats.length; pv++) {
            var p = resolvedFormats[pv];
            var pKey = p.url || '';
            if (!pKey || seenProg[pKey]) continue;
            seenProg[pKey] = true;
            var progContainer = getContainerFromMime(p.mimeType) || 'mp4';
            streams.push({
              url: p.url,
              type: progContainer.toUpperCase(),
              format: progContainer,
              quality: safeQualityLabel(p),
              fps: p.fps || null,
              source: 'youtube-player-progressive'
            });
          }
        }

        return {
          streams: streams,
          debug: {
            found: true,
            source: source,
            method: 'player-response',
            adaptiveCount: sd.adaptiveFormats ? sd.adaptiveFormats.length : 0,
            formatCount: sd.formats ? sd.formats.length : 0
          }
        };
      } catch(e) {
        return { streams: [], debug: { error: e.message } };
      }
    }
  }, function(results) {
    if (chrome.runtime.lastError) {
      logDebug('[YouTube MAIN] Error:', chrome.runtime.lastError.message);
      callback([]);
      return;
    }
    if (results && results[0] && results[0].result) {
      var data = results[0].result;
      logDebug('[YouTube MAIN]', JSON.stringify(data.debug), 'Streams:', data.streams.length);
      callback(data.streams || []);
    } else {
      logDebug('[YouTube MAIN] No result returned');
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

function inferHlsQualityFromUrl(url) {
  try {
    const clean = String(url || '').split('?')[0].toLowerCase();
    const pMatch = clean.match(/(?:^|[\/_.-])(\d{3,4})p(?:[\/_.-]|$)/i);
    if (pMatch) return pMatch[1] + 'p';
    const whMatch = clean.match(/(\d{3,4})x(\d{3,4})/i);
    if (whMatch) return whMatch[2] + 'p';
    const hMatch = clean.match(/(?:^|[\/_.-])h(\d{3,4})(?:[\/_.-]|$)/i);
    if (hMatch) return hMatch[1] + 'p';
  } catch (e) {}
  return '';
}

function addDetectedStream(tabId, stream) {
  if (!streamData[tabId]) {
    streamData[tabId] = { streams: [], segments: [], videos: [], subtitles: [], pageUrl: '' };
  }
  const existing = streamData[tabId].streams.find(s => s.url === stream.url);
  if (existing) return false;
  streamData[tabId].streams.push(stream);
  updateBadge(tabId);
  return true;
}

// Capture HLS by response content-type (some manifests do not expose .m3u8 in URL)
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId < 0) return;
    if (!details.responseHeaders || !Array.isArray(details.responseHeaders)) return;
    if (details.statusCode && (details.statusCode < 200 || details.statusCode >= 300)) return;

    const contentTypeHeader = details.responseHeaders.find(h => String(h.name || '').toLowerCase() === 'content-type');
    const contentType = String((contentTypeHeader && contentTypeHeader.value) || '').toLowerCase();
    const isHlsContentType = contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl');
    if (!isHlsContentType) return;

    const url = details.url;
    if (!url || isBlockedUrl(url)) return;
    const timestamp = new Date().toLocaleTimeString();
    const inferred = inferHlsQualityFromUrl(url);
    const isMaster = /master/i.test(url);

    const added = addDetectedStream(tabId, {
      url: url,
      type: 'HLS',
      format: 'm3u8',
      time: timestamp,
      quality: isMaster ? 'Master' : (inferred || 'Playlist')
    });
    if (added) {
      logDebug('[HLS Content-Type Detected]', url.substring(0, 80));
    }
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
  ['responseHeaders']
);

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
        const inferred = inferHlsQualityFromUrl(url);
        const isMaster = url.includes('master');
        const added = addDetectedStream(tabId, {
          url: url,
          type: 'HLS',
          format: 'm3u8',
          time: timestamp,
          quality: isMaster ? 'Master' : (inferred || 'Playlist')
        });
        if (added) {
          logDebug('[HLS Auto-Detected]', url.substring(0, 80));
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
          logDebug('[DASH Auto-Detected]', url.substring(0, 80));
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
          logDebug('[Subtitle Auto-Detected]', format.toUpperCase(), lang || 'unknown lang', url.substring(0, 80));
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
          logDebug('[Video Auto-Detected]', format.toUpperCase(), url.substring(0, 80));
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
      logDebug('[Headers Captured]', url.substring(0, 60), 'Referer:', headers.referer || 'none');
      
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

function parseHeightFromQualityLabel(label) {
  const m = String(label || '').match(/(\d{3,4})p/i);
  return m ? parseInt(m[1], 10) : 0;
}

function scoreQualitiesResponse(data) {
  const qualities = Array.isArray(data && data.qualities) ? data.qualities : [];
  const audioTracks = Array.isArray(data && data.audioTracks) ? data.audioTracks : [];
  const valid = qualities.filter(q => q && q.url);
  const maxHeight = valid.reduce((max, q) => {
    const fromRes = (() => {
      const parts = String(q.resolution || '').split('x');
      const h = parseInt(parts[1] || '0', 10);
      return Number.isFinite(h) ? h : 0;
    })();
    const fromLabel = parseHeightFromQualityLabel(q.label);
    return Math.max(max, fromRes, fromLabel);
  }, 0);
  const nonDefaultCount = valid.filter(q => {
    const l = String(q.label || '').toLowerCase();
    return !l.includes('default') && !l.includes('unknown');
  }).length;
  const hasMultipleUsefulQualities = nonDefaultCount > 1;
  return (
    (hasMultipleUsefulQualities ? 100000 : 0) +
    (maxHeight * 100) +
    (valid.length * 10) +
    audioTracks.length
  );
}

async function requestQualities(url, headers) {
  const resp = await fetch(`${SERVER_URL}/qualities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: url,
      referer: headers.referer || '',
      origin: headers.origin || '',
      cookie: headers.cookie || '',
      userAgent: headers.userAgent || ''
    })
  });
  return await resp.json();
}

function parseM3u8Attributes(raw) {
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

function appendQueryParamsCompat(sourceUrl, targetUrl) {
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

function parseMasterM3u8Browser(text, baseUrl) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const variants = [];
  const audioGroups = {};
  const subtitleGroups = {};

  function resolveUrl(targetUrl) {
    try {
      const abs = String(targetUrl || '').startsWith('http')
        ? String(targetUrl)
        : new URL(String(targetUrl || ''), baseUrl).href;
      return appendQueryParamsCompat(baseUrl, abs);
    } catch (e) {
      return String(targetUrl || '');
    }
  }

  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const attrs = parseM3u8Attributes(line.replace(/^#EXT-X-MEDIA:/i, ''));
    const type = String(attrs.TYPE || '').toUpperCase();
    const groupId = attrs['GROUP-ID'];
    const uri = attrs.URI;
    if (!type || !groupId || !uri) continue;
    const track = {
      url: resolveUrl(uri),
      language: attrs.LANGUAGE || 'und',
      name: attrs.NAME || attrs.LANGUAGE || 'Default',
      isDefault: String(attrs.DEFAULT || '').toUpperCase() === 'YES'
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
    const attrs = parseM3u8Attributes(lines[i].replace(/^#EXT-X-STREAM-INF:/i, ''));
    const bw = parseInt(attrs.BANDWIDTH || '0', 10) || 0;
    const res = attrs.RESOLUTION || 'unknown';
    const audioGroupId = attrs.AUDIO || null;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j];
      if (!candidate || candidate.startsWith('#')) continue;
      const variantUrl = resolveUrl(candidate);
      const tracks = audioGroupId && audioGroups[audioGroupId] ? audioGroups[audioGroupId] : [];
      const defaultTrack = tracks.find((t) => t.isDefault) || tracks[0] || null;
      variants.push({
        bandwidth: bw,
        resolution: res,
        url: variantUrl,
        audioUrl: defaultTrack ? defaultTrack.url : null,
        audioGroupId: audioGroupId
      });
      break;
    }
  }

  variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

  const qualities = variants.map((v) => {
    const h = Number(String(v.resolution || '').split('x')[1] || 0);
    let label = 'unknown';
    if (h >= 2160) label = '2160p';
    else if (h >= 1440) label = '1440p';
    else if (h >= 1080) label = '1080p';
    else if (h >= 720) label = '720p';
    else if (h >= 480) label = '480p';
    else if (h >= 360) label = '360p';
    else if (h >= 240) label = '240p';
    label = `${label} (${Math.round((v.bandwidth || 0) / 1000)} kbps)`;
    return {
      label,
      url: v.url,
      bandwidth: v.bandwidth || 0,
      resolution: v.resolution || 'unknown',
      audioUrl: v.audioUrl || null,
      audioGroupId: v.audioGroupId || null
    };
  });

  const audioTracks = [];
  const seenAudio = new Set();
  Object.keys(audioGroups).forEach((gid) => {
    audioGroups[gid].forEach((t) => {
      const key = `${gid}|${t.language}|${t.name}`;
      if (seenAudio.has(key)) return;
      seenAudio.add(key);
      audioTracks.push({
        url: t.url,
        language: t.language,
        name: t.name,
        isDefault: t.isDefault,
        groupId: gid
      });
    });
  });

  const audioGroupMap = {};
  Object.keys(audioGroups).forEach((gid) => {
    audioGroupMap[gid] = {};
    audioGroups[gid].forEach((t) => {
      audioGroupMap[gid][t.language || t.name] = t.url;
    });
  });

  const subtitleTracks = [];
  const seenSub = new Set();
  Object.keys(subtitleGroups).forEach((gid) => {
    subtitleGroups[gid].forEach((t) => {
      const key = `${gid}|${t.language}|${t.name}`;
      if (seenSub.has(key)) return;
      seenSub.add(key);
      subtitleTracks.push({
        url: t.url,
        language: t.language,
        name: t.name,
        isDefault: t.isDefault,
        groupId: gid
      });
    });
  });

  return { qualities, audioTracks, audioGroupMap, subtitleTracks };
}

async function fetchTextBrowser(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      signal: ctrl.signal
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

async function requestQualitiesBrowser(url) {
  const text = await fetchTextBrowser(url);
  if (text.includes('#EXT-X-STREAM-INF:')) {
    return parseMasterM3u8Browser(text, url);
  }
  return {
    qualities: [{ label: 'Default', url: url, bandwidth: 0, resolution: 'unknown' }],
    audioTracks: [],
    audioGroupMap: null,
    subtitleTracks: []
  };
}

function normalizeCapturedHeaderBundle(raw) {
  const src = raw || {};
  return {
    referer: src.referer || '',
    origin: src.origin || '',
    cookie: src.cookie || '',
    userAgent: src['user-agent'] || src.userAgent || ''
  };
}

function recoverManifestUrlsFromPerformance(tabId, callback) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: function() {
      try {
        const found = new Set();
        const entries = performance.getEntriesByType('resource') || [];
        entries.forEach((entry) => {
          const u = String((entry && entry.name) || '');
          if (!u) return;
          const l = u.toLowerCase();
          if (l.includes('.m3u8') || l.includes('.mpd')) {
            found.add(u);
          }
        });
        return Array.from(found);
      } catch (e) {
        return [];
      }
    }
  }, (results) => {
    if (chrome.runtime.lastError) {
      callback([]);
      return;
    }
    const urls = (results && results[0] && Array.isArray(results[0].result)) ? results[0].result : [];
    callback(urls);
  });
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
      const allSubtitles = [...uniqueSubtitles];
      const ensureTabData = () => {
        if (!streamData[tabId]) {
          streamData[tabId] = { streams: [], segments: [], videos: [], subtitles: [], pageUrl: (tab && tab.url) || '' };
        }
      };

      function finishGetStreams() {
        sendResponse({
          streams: uniqueStreams.map(s => ({
            ...s, pageTitle,
            headers: s.headers || capturedHeaders[s.url] || null
          })),
          videos: uniqueVideos.map(v => ({...v, pageTitle })),
          segmentCount: data.segments.length,
          serverAvailable: serverAvailable,
          capturedSubtitles: allSubtitles,
          pageTitle: pageTitle,
          debug: {
            totalCaptures: uniqueStreams.length + uniqueVideos.length,
            hasSegments: data.segments.length > 0,
            subtitleSources: { network: uniqueSubtitles.length }
          }
        });
      }

      recoverManifestUrlsFromPerformance(tabId, (perfUrls) => {
        if (perfUrls && perfUrls.length > 0) {
          ensureTabData();
          perfUrls.forEach((u) => {
            const lower = String(u || '').toLowerCase();
            const isMpd = lower.includes('.mpd');
            const inferred = inferHlsQualityFromUrl(u);
            const stream = {
              url: u,
              type: isMpd ? 'DASH' : 'HLS',
              format: isMpd ? 'mpd' : 'm3u8',
              quality: isMpd ? 'Manifest' : (/master/i.test(lower) ? 'Master' : (inferred || 'Playlist')),
              source: 'performance',
              time: new Date().toLocaleTimeString()
            };
            const existing = uniqueStreams.find(s => s.url === u);
            if (!existing) uniqueStreams.push(stream);
            addDetectedStream(tabId, stream);
          });
        }

        // YouTube-specific extraction is kept because YouTube hides many direct requests.
        // Include Shorts URLs as well (e.g. /shorts/{id}).
        const tabUrl = String((tab && tab.url) || '');
        const isYouTubePage = /(^https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch|shorts|live)\b|youtu\.be\/)/i.test(tabUrl);
        if (isYouTubePage) {
          extractYouTubeFromMainWorld(tabId, (mainStreams) => {
            mainStreams.forEach(ms => {
              const existing = uniqueStreams.find(s => s.url === ms.url);
              if (existing) {
                // Enrich already-captured rows so popup can treat them as YouTube variants.
                if (!existing.source && ms.source) existing.source = ms.source;
                if (!existing.fps && ms.fps) existing.fps = ms.fps;
                if (!existing.audioUrl && ms.audioUrl) existing.audioUrl = ms.audioUrl;
                if ((!existing.quality || existing.quality === 'Best') && ms.quality) existing.quality = ms.quality;
              } else {
                uniqueStreams.push({
                  url: ms.url,
                  type: ms.type,
                  format: ms.format,
                  quality: ms.quality,
                  audioUrl: ms.audioUrl || null,
                  fps: ms.fps || null,
                  source: ms.source || null,
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
    // Add a completed download to history (called from popup)
    recordHistory(request.filename, request.size, request.source);
    sendResponse({ success: true });
    return true;

  } else if (request.action === 'getQualities') {
    // Fetch available quality levels for an HLS stream
    const realHeaders = request.headers || capturedHeaders[request.url] || null;
    
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      const activeTab = tabs[0] || null;
      const pageUrl = activeTab ? activeTab.url : '';
      const tabId = activeTab ? activeTab.id : -1;
      const storedPageUrl = streamData[tabId]?.pageUrl || '';
      const bestReferer = (realHeaders && realHeaders.referer) || pageUrl || storedPageUrl;
      const bestOrigin = (realHeaders && realHeaders.origin) || (pageUrl ? new URL(pageUrl).origin : '');
      const bestCookie = (realHeaders && realHeaders.cookie) || '';
      const bestUA = (realHeaders && realHeaders['user-agent']) || '';

      const requestHeaders = {
        referer: bestReferer,
        origin: bestOrigin,
        cookie: bestCookie,
        userAgent: bestUA
      };

      const tabStreams = (streamData[tabId] && Array.isArray(streamData[tabId].streams))
        ? streamData[tabId].streams
        : [];
      const hlsCandidates = tabStreams
        .filter(s => s && s.type === 'HLS' && s.url)
        .sort((a, b) => {
          const aMaster = /master/i.test(String(a.quality || '')) || /master/i.test(String(a.url || ''));
          const bMaster = /master/i.test(String(b.quality || '')) || /master/i.test(String(b.url || ''));
          if (aMaster !== bMaster) return aMaster ? -1 : 1;
          return parseHeightFromQualityLabel(String(b.quality || '')) - parseHeightFromQualityLabel(String(a.quality || ''));
        })
        .map(s => s.url);

      const candidates = [];
      const seen = new Set();
      [request.url, ...hlsCandidates].forEach((u) => {
        const key = String(u || '').trim();
        if (!key || seen.has(key)) return;
        seen.add(key);
        candidates.push(key);
      });

      (async () => {
        let bestData = null;
        let bestUrl = request.url;
        let bestScore = -1;
        const maxToProbe = Math.min(candidates.length, 12);

        for (let i = 0; i < maxToProbe; i++) {
          const candidateUrl = candidates[i];
          try {
            let bestCandidateData = null;
            let bestCandidateScore = -1;

            // Puemos-style first pass: resolve in browser context (local extension fetch).
            try {
              const browserData = await requestQualitiesBrowser(candidateUrl);
              const browserScore = scoreQualitiesResponse(browserData);
              if (browserScore > bestCandidateScore) {
                bestCandidateScore = browserScore;
                bestCandidateData = browserData;
              }
            } catch (e) {}

            // Backend pass (ffmpeg-side) with candidate-specific captured headers.
            try {
              const perCandidateHeaders = normalizeCapturedHeaderBundle(capturedHeaders[candidateUrl]);
              const effectiveHeaders = {
                referer: perCandidateHeaders.referer || requestHeaders.referer,
                origin: perCandidateHeaders.origin || requestHeaders.origin,
                cookie: perCandidateHeaders.cookie || requestHeaders.cookie,
                userAgent: perCandidateHeaders.userAgent || requestHeaders.userAgent
              };
              const serverData = await requestQualities(candidateUrl, effectiveHeaders);
              const serverScore = scoreQualitiesResponse(serverData);
              if (serverScore > bestCandidateScore) {
                bestCandidateScore = serverScore;
                bestCandidateData = serverData;
              }
            } catch (e) {}

            if (bestCandidateData && bestCandidateScore > bestScore) {
              bestScore = bestCandidateScore;
              bestData = bestCandidateData;
              bestUrl = candidateUrl;
            }
          } catch (e) {}
        }

        if (!bestData) {
          sendResponse({ success: false, error: 'Failed to fetch qualities' });
          return;
        }

        sendResponse({
          success: true,
          qualities: bestData.qualities || [],
          audioTracks: bestData.audioTracks || [],
          audioGroupMap: bestData.audioGroupMap || null,
          subtitleTracks: bestData.subtitleTracks || [],
          selectedUrl: bestUrl
        });
      })().catch((err) => sendResponse({ success: false, error: err.message }));
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
      
      logDebug('[Download] Using Referer:', bestReferer.substring(0, 80));
      
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
          outputFormat: request.outputFormat || 'mp4',
          dashVideoIndex: (typeof request.dashVideoIndex === 'number' ? request.dashVideoIndex : null),
          dashAudioIndex: (typeof request.dashAudioIndex === 'number' ? request.dashAudioIndex : null)
        })
      })
    .then(response => response.json())
    .then(data => {
      logDebug('[Server Download]', data);
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
    logDebug('[Download Request]', request.filename);
    
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
        logDebug('[Download Started] ID:', downloadId);
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
