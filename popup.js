// === THEME ===
// Apply theme from storage using data-theme attribute on body
function applyPopupTheme(theme) {
  var isLight = theme === 'light' ||
    (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.body.setAttribute('data-theme', isLight ? 'light' : 'dark');
}
chrome.storage.local.get('theme', function(r) {
  applyPopupTheme(r.theme || 'system');
});
chrome.storage.onChanged.addListener(function(changes, area) {
  if (area === 'local' && changes.theme) applyPopupTheme(changes.theme.newValue || 'system');
});
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function() {
    chrome.storage.local.get('theme', function(r) {
      if ((r.theme || 'system') === 'system') applyPopupTheme('system');
    });
  });
}

let allVideos = [];
let capturedSubtitles = [];
let serverAvailable = false;
let userPrefs = { prefQuality: 'highest', prefAudio: '', prefSubtitle: '', autoSelectQuality: true };
let currentScanTabId = null;
const DEBUG_LOGS = false;

function logDebug(...args) {
  if (DEBUG_LOGS) console.log(...args);
}

// Load user preferences
chrome.storage.local.get(['prefQuality', 'prefAudio', 'prefSubtitle', 'autoSelectQuality'], (result) => {
  userPrefs.prefQuality = result.prefQuality || 'highest';
  userPrefs.prefAudio = result.prefAudio || '';
  userPrefs.prefSubtitle = result.prefSubtitle || '';
  userPrefs.autoSelectQuality = result.autoSelectQuality !== undefined ? result.autoSelectQuality : true;
});

// Find the best quality index matching user preference
function findBestQualityIndex(qualities, pref) {
  if (!pref || pref === 'highest') return 0; // already sorted highest first
  if (pref === 'lowest') return qualities.length - 1;
  const target = parseInt(pref);
  if (isNaN(target)) return 0;
  let bestIdx = 0;
  let bestDiff = Infinity;
  qualities.forEach((q, i) => {
    // Parse resolution from label like "1080p (5000 kbps)"
    const m = q.label.match(/(\d{3,4})p/);
    if (m) {
      const diff = Math.abs(parseInt(m[1]) - target);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
  });
  return bestIdx;
}

// Find the best audio/subtitle index matching user preferred language
function findBestLangIndex(tracks, prefLang) {
  if (!prefLang) return -1;
  const lc = prefLang.toLowerCase();
  for (let i = 0; i < tracks.length; i++) {
    const tl = (tracks[i].language || '').toLowerCase();
    const tn = (tracks[i].name || '').toLowerCase();
    if (tl === lc || tl.startsWith(lc) || tn.includes(lc)) return i;
  }
  return -1;
}

function isWeakQualityList(qualities) {
  const list = Array.isArray(qualities) ? qualities : [];
  if (list.length <= 1) return true;
  const useful = list.filter((q) => {
    const l = String((q && q.label) || '').toLowerCase();
    return l && !l.includes('default') && !l.includes('unknown');
  });
  return useful.length <= 1;
}
let ws = null;
let progressPort = null;

// Connect to background for Chrome download progress
function connectToBackgroundProgress() {
  try {
    progressPort = chrome.runtime.connect({ name: 'downloadProgress' });
    progressPort.onMessage.addListener((message) => {
      if (message.type === 'downloadProgress') {
        updateChromeDownloadProgress(message.downloadId, message);
      }
    });
    progressPort.onDisconnect.addListener(() => {
      setTimeout(connectToBackgroundProgress, 1000);
    });
  } catch (error) {
    console.error('Progress connection failed:', error);
  }
}

function updateChromeDownloadProgress(downloadId, progress) {
  const progressContainer = document.querySelector('[data-chrome-download-id="' + downloadId + '"]');
  if (!progressContainer) return;
  
  const progressBar = progressContainer.querySelector('.progress-bar');
  const progressInfo = progressContainer.nextElementSibling;
  const item = progressContainer.closest('.item');
  const button = item.querySelector('.download-btn');
  
  if (progress.status === 'complete') {
    progressBar.style.width = '100%';
    progressBar.textContent = '100%';
    progressInfo.textContent = 'Complete - ' + progress.totalBytes;
    button.innerHTML = '<span class="btn-icon">&#10003;</span> Done';
    button.className = 'download-btn btn-done';
    updateStatus('Download complete!', 'success');
  } else if (progress.status === 'downloading') {
    progressBar.style.width = progress.percent + '%';
    progressBar.textContent = progress.percent + '%';
    progressInfo.textContent = progress.bytesReceived + '/' + progress.totalBytes + ' \u2022 ' + progress.speed;
    button.innerHTML = '<span class="btn-icon spin">&#8635;</span> ' + progress.percent + '%';
    button.className = 'download-btn btn-downloading';
  }
}

// WebSocket for stream conversions
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    ws = new WebSocket('ws://localhost:3000');
    ws.onopen = () => { updateServerStatus(true); };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'progress') updateStreamProgress(data.downloadId, data);
    };
    ws.onclose = () => {
      setTimeout(() => { if (document.querySelector('#refresh')) connectWebSocket(); }, 3000);
    };
  } catch (error) {
    console.error('WebSocket error:', error);
  }
}

function updateStreamProgress(downloadId, progress) {
  const progressContainer = document.querySelector('[data-download-id="' + downloadId + '"]');
  if (!progressContainer) return;
  
  const progressBar = progressContainer.querySelector('.progress-bar');
  const progressInfo = progressContainer.nextElementSibling;
  const item = progressContainer.closest('.item');
  const dlBtn = item.querySelector('.download-btn:not(.btn-cancel)');
  const cancelBtn = item.querySelector('.btn-cancel');
  
  if (progress.status === 'complete') {
    progressBar.style.width = '100%';
    progressBar.textContent = '100%';
    progressInfo.textContent = 'Complete - ' + progress.size;
    if (dlBtn) {
      dlBtn.innerHTML = '<span class="btn-icon">&#10003;</span><span class="btn-text">Done</span>';
      dlBtn.className = 'download-btn btn-done';
      dlBtn.style.display = '';
    }
    if (cancelBtn) cancelBtn.remove();
    updateStatus('Download complete!', 'success');
    chrome.runtime.sendMessage({ action: 'clearActiveDownload', downloadId: downloadId });
  } else if (progress.status === 'cancelled') {
    // Restore the original download button (not the cancel button)
    const allBtns = item.querySelectorAll('.download-btn');
    allBtns.forEach(btn => {
      if (btn.classList.contains('btn-cancel')) {
        btn.remove();
      } else {
        btn.innerHTML = '<span class="btn-icon">\u2B07</span><span class="btn-text">Download</span>';
        btn.className = 'download-btn';
        btn.disabled = false;
        btn.style.display = '';
      }
    });
    progressContainer.remove();
    if (progressInfo) progressInfo.remove();
    const qsCancelled = item.querySelector('.quality-select');
    if (qsCancelled) qsCancelled.disabled = false;
    const asCancelled = item.querySelector('.audio-select');
    if (asCancelled) asCancelled.disabled = false;
    const ssCancelled = item.querySelector('.subtitle-select');
    if (ssCancelled) ssCancelled.disabled = false;
    updateStatus('Download cancelled', 'warning');
    chrome.runtime.sendMessage({ action: 'clearActiveDownload', downloadId: downloadId });
  } else if (progress.status === 'failed') {
    progressInfo.textContent = 'Failed: ' + (progress.error || 'Unknown error');
    if (dlBtn) {
      dlBtn.innerHTML = '<span class="btn-icon">\u2716</span><span class="btn-text">Failed</span>';
      dlBtn.className = 'download-btn btn-failed';
      dlBtn.disabled = false;
      dlBtn.style.display = '';
    }
    if (cancelBtn) cancelBtn.remove();
    const qsFailed = item.querySelector('.quality-select');
    if (qsFailed) qsFailed.disabled = false;
    const asFailed = item.querySelector('.audio-select');
    if (asFailed) asFailed.disabled = false;
    const ssFailed = item.querySelector('.subtitle-select');
    if (ssFailed) ssFailed.disabled = false;
    updateStatus('Download failed', 'error');
    chrome.runtime.sendMessage({ action: 'clearActiveDownload', downloadId: downloadId });
  } else if (progress.percent) {
    progressBar.style.width = progress.percent + '%';
    progressBar.textContent = progress.percent + '%';
    progressInfo.textContent = progress.currentTime + '/' + progress.totalTime + ' \u2022 ' + progress.speed + ' \u2022 ETA ' + progress.eta;
  }
}

// Initialize
connectToBackgroundProgress();

document.addEventListener('DOMContentLoaded', () => { scanAll(); });

document.getElementById('refresh').addEventListener('click', scanAll);
document.getElementById('openFolder').addEventListener('click', () => {
  fetch('http://localhost:3000/open-folder').catch(() => {});
});
document.getElementById('historyBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
});
document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
});

chrome.runtime.sendMessage({action: 'checkServer'}, (response) => {
  updateServerStatus(response && response.available || false);
  if (response && response.available) connectWebSocket();
});

function updateServerStatus(available) {
  serverAvailable = available;
}

function scanAll() {
  updateStatus('Scanning for videos...', 'loading');
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    const tabId = tabs[0].id;
    currentScanTabId = tabId;
    chrome.runtime.sendMessage({action: 'getStreams', tabId: tabId}, (streamResp) => {
      updateServerStatus(streamResp && streamResp.serverAvailable || false);
      if (streamResp && streamResp.serverAvailable && (!ws || ws.readyState !== WebSocket.OPEN)) {
        connectWebSocket();
      }
      displayResults(streamResp);
    });
  });
}

// === DEDUP: merge duplicate detections into one entry per logical video ===
function dedupNormalizeText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getQualityHeight(value) {
  const match = String(value || '').match(/(\d{3,4})p/i);
  return match ? parseInt(match[1], 10) : 0;
}

function buildYouTubeVariantLabel(variant) {
  const formatLabel = String(variant.format || 'mp4').toUpperCase();
  let label = formatLabel + ' - ' + (variant.quality || 'Unknown');
  if (variant.fps) label += ' - ' + variant.fps + 'fps';
  if (variant.audioUrl) label += ' - video-only';
  return label;
}

function isYouTubeSource(video) {
  return /^youtube-/.test(String((video && video.source) || ''));
}

function mergeDuplicateVideos(videos) {
  const groups = new Map();
  videos.forEach((video) => {
    // Group by normalized title + duration. If title is missing, use URL.
    const title = dedupNormalizeText(video.pageTitle || video.title || '');
    const dur = String(video.durationSeconds || video.duration || '');
    const key = title ? (title + '|' + dur) : ('url:' + (video.url || video.src || ''));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(video);
  });

  logDebug('[DEDUP] Candidates:', videos.length, '→ Groups:', groups.size);

  const merged = [];
  groups.forEach((items, key) => {
    const dashItems = items.filter(v => v.videoType === 'stream' && v.type === 'DASH');
    const hlsItems = items.filter(v => v.videoType === 'stream' && v.type === 'HLS');
    const youtubeStreams = items
      .filter(v =>
        v.videoType === 'stream' &&
        /^youtube-/.test(String(v.source || '')) &&
        (v.format === 'mp4' || v.format === 'webm' || v.type === 'MP4' || v.type === 'WEBM')
      )
      .sort((a, b) => {
        const hDiff = getQualityHeight(b.quality) - getQualityHeight(a.quality);
        if (hDiff !== 0) return hDiff;
        return String(a.audioUrl ? '1' : '0').localeCompare(String(b.audioUrl ? '1' : '0'));
      });

    // Pick primary using explicit priority: HLS > DASH > stream > direct > page
    let primary = null;
    // For YouTube, prefer DASH manifest when available. It is the most reliable
    // source for complete quality ladders on current player versions.
    if (youtubeStreams.length > 0 && dashItems.length > 0) {
      primary = dashItems[0];
    } else if (youtubeStreams.length > 0) {
      const variantMap = new Map();
      youtubeStreams.forEach(v => {
        const variantKey = v.url || '';
        if (!variantMap.has(variantKey)) {
          variantMap.set(variantKey, {
            url: v.url,
            audioUrl: v.audioUrl || null,
            quality: v.quality || 'Unknown',
            label: buildYouTubeVariantLabel(v),
            fps: v.fps || null,
            format: v.format || (String(v.type || '').toLowerCase() === 'webm' ? 'webm' : 'mp4')
          });
        }
      });
      primary = { ...youtubeStreams[0], streamVariants: Array.from(variantMap.values()), streamVariantsSource: 'youtube' };
    } else {
      if (hlsItems.length > 0) {
        // Prefer master playlist for richer quality options.
        primary = hlsItems.find(v => {
          const q = String(v.quality || '').toLowerCase();
          const u = (v.url || '').toLowerCase();
          return q.includes('master') || u.includes('master');
        });
        if (!primary) {
          primary = hlsItems
            .slice()
            .sort((a, b) => getQualityHeight(String(b.quality || '')) - getQualityHeight(String(a.quality || '')))[0] || hlsItems[0];
        }
      }
      if (!primary && dashItems.length > 0) primary = dashItems[0];
      if (!primary) primary = items.find(v => v.videoType === 'stream');
      if (!primary) primary = items.find(v => v.videoType === 'direct');
      if (!primary) primary = items[0];
    }

    logDebug('[DEDUP] Group "' + key + '" (' + items.length + ' items) → primary: ' + primary.videoType + '/' + primary.type);
    merged.push({ ...primary });
  });

  return merged;
}

function displayResults(streamResp) {
  const streams = (streamResp && streamResp.streams) || [];
  const videos = (streamResp && streamResp.videos) || [];
  
  // Store captured subtitle URLs from network requests
  capturedSubtitles = (streamResp && streamResp.capturedSubtitles) || [];
  
  // Merge all videos - normalize field names
  const allCandidates = [
    ...streams.map(s => ({
      ...s,
      videoType: 'stream',
      category: s.type,
      thumbnail: s.thumbnail || s.poster || null,
      duration: s.duration || null,
      durationSeconds: s.durationSeconds || null,
      headers: s.headers || null
    })),
    ...videos.map(v => ({
      ...v,
      videoType: 'direct',
      category: 'MP4',
      thumbnail: v.thumbnail || v.poster || null,
      duration: v.duration || null,
      durationSeconds: v.durationSeconds || null
    }))
  ];
  allVideos = mergeDuplicateVideos(allCandidates);

  // Update badge to reflect dedup count
  if (currentScanTabId !== null) {
    chrome.runtime.sendMessage({ action: 'setBadgeCount', tabId: currentScanTabId, count: allVideos.length });
  }
  
  document.getElementById('videoCount').textContent = allVideos.length + ' video' + (allVideos.length !== 1 ? 's' : '');
  displayAllVideos();
  restoreActiveDownloads();
  
  if (allVideos.length === 0) {
    updateStatus('No videos detected. Try playing a video or refresh the page.', 'warning');
  } else {
    updateStatus(allVideos.length + ' video' + (allVideos.length !== 1 ? 's' : '') + ' ready to download', 'success');
  }
}

function displayAllVideos() {
  const videosSection = document.getElementById('videosSection');
  
  if (allVideos.length === 0) {
    videosSection.innerHTML = '<div class="empty"><div class="empty-icon">\uD83C\uDFAC</div><div class="empty-text">No videos detected</div><div class="empty-subtext">Play a video on this page and click Scan Page</div></div>';
    return;
  }
  
  videosSection.innerHTML = '';
  allVideos.forEach((video, i) => {
    videosSection.appendChild(createVideoItem(video, i));
  });
}

function createVideoItem(video, index) {
  const item = document.createElement('div');
  item.className = 'item';
  
  const isStream = video.videoType === 'stream';
  const hasYouTubeVariants = isStream &&
    Array.isArray(video.streamVariants) &&
    video.streamVariants.length > 1 &&
    (video.streamVariantsSource === 'youtube' || isYouTubeSource(video));
  const shouldFetchServerQualities = isStream && serverAvailable && (video.type === 'HLS' || video.type === 'DASH');
  const shouldShowQualitySelect = shouldFetchServerQualities || hasYouTubeVariants;
  
  // Title
  let title = video.pageTitle || video.title || ('Video ' + (index + 1));
  if (isStream && !video.title) title = video.pageTitle || (video.type + ' Stream');
  
  // Thumbnail - support http, data:, // URLs
  const thumb = video.thumbnail || video.poster || null;
  let thumbnailHTML;
  if (thumb && (thumb.startsWith('http') || thumb.startsWith('data:') || thumb.startsWith('//'))) {
    thumbnailHTML = '<div class="thumbnail-wrap"><img class="thumbnail-img" src="' + thumb + '" onerror="this.parentElement.innerHTML=\'<div class=\\\'thumbnail-fallback ' + getThumbnailClass(video) + '\\\'>' + getThumbnailLabel(video) + '</div>\'" alt=""><div class="thumbnail-overlay">' + getThumbnailLabel(video) + '</div></div>';
  } else {
    thumbnailHTML = '<div class="thumbnail-wrap"><div class="thumbnail-fallback ' + getThumbnailClass(video) + '">' + getThumbnailLabel(video) + '</div></div>';
  }
  
  // Duration
  let durationDisplay = '';
  if (video.duration && video.duration !== 'N/A') {
    durationDisplay = video.duration;
  } else if (video.durationSeconds && video.durationSeconds > 0) {
    durationDisplay = formatDurationPopup(video.durationSeconds);
  }
  
  const durationHTML = durationDisplay ? '<span class="badge badge-duration">' + escapeHtml(durationDisplay) + '</span>' : '';
  
  // Type badge
  const badgeHTML = '<span class="badge ' + getBadgeClass(video) + '">' + getBadgeText(video) + '</span>';
  
  // Dimensions
  const dimsHTML = (video.dimensions && video.dimensions !== 'Unknown') ? '<span class="badge badge-dims">' + video.dimensions + '</span>' : '';
  
  item.innerHTML = thumbnailHTML +
    '<div class="item-body">' +
      '<div class="item-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div>' +
      '<div class="item-meta">' + badgeHTML + durationHTML + dimsHTML + '</div>' +
    '</div>' +
    '<div class="item-actions">' +
      (shouldShowQualitySelect ? '<select class="quality-select"' + (shouldFetchServerQualities ? ' disabled' : '') + '><option>' + (shouldFetchServerQualities ? 'Loading...' : 'Select quality') + '</option></select>' : '') +
      (shouldFetchServerQualities ? '<select class="audio-select" style="display:none"></select>' : '') +
      (serverAvailable ? '<select class="subtitle-select" style="display:none"></select>' : '') +
      '<button class="download-btn"><span class="btn-icon">\u2B07</span><span class="btn-text">Download</span></button>' +
    '</div>';
  
  const downloadBtn = item.querySelector('.download-btn');
  const qualitySelect = item.querySelector('.quality-select');
  const audioSelect = item.querySelector('.audio-select');
  const subtitleSelect = item.querySelector('.subtitle-select');

  // Pre-populate quality selector for YouTube stream variants
  const canUseCapturedVariants = hasYouTubeVariants || (isStream && Array.isArray(video.streamVariants) && video.streamVariants.length > 1 && !shouldFetchServerQualities);

  if (canUseCapturedVariants && qualitySelect) {
    qualitySelect.innerHTML = '';
    const variantQualities = video.streamVariants.map(v => ({
      url: v.url,
      audioUrl: v.audioUrl || null,
      label: v.label || buildYouTubeVariantLabel(v),
      quality: v.quality || 'Unknown',
      format: v.format || null
    }));
    variantQualities.forEach((q, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = q.label;
      qualitySelect.appendChild(opt);
    });
    qualitySelect.dataset.qualities = JSON.stringify(variantQualities);
    qualitySelect.disabled = false;
    if (userPrefs.autoSelectQuality && variantQualities.length > 1) {
      qualitySelect.value = findBestQualityIndex(variantQualities, userPrefs.prefQuality);
    }
  }
  
  // Auto-fetch qualities for HLS/DASH streams
  if (shouldFetchServerQualities && qualitySelect) {
    chrome.runtime.sendMessage({
      action: 'getQualities', url: video.url, headers: video.headers || null
    }, (resp) => {
      if (resp && resp.success && resp.qualities && resp.qualities.length > 0) {
        let existingQualities = [];
        try {
          existingQualities = qualitySelect.dataset.qualities ? JSON.parse(qualitySelect.dataset.qualities) : [];
        } catch (e) {
          existingQualities = [];
        }
        const keepExisting = existingQualities.length > 1 && isWeakQualityList(resp.qualities);
        if (keepExisting) {
          qualitySelect.disabled = false;
          return;
        }
        qualitySelect.innerHTML = '';
        resp.qualities.forEach((q, i) => {
          const opt = document.createElement('option');
          opt.value = i;
          opt.textContent = q.label;
          qualitySelect.appendChild(opt);
        });
        qualitySelect.disabled = false;
        // Store qualities on the element
        qualitySelect.dataset.qualities = JSON.stringify(resp.qualities);
        
        // Auto-select preferred quality
        if (userPrefs.autoSelectQuality && resp.qualities.length > 1) {
          const bestIdx = findBestQualityIndex(resp.qualities, userPrefs.prefQuality);
          qualitySelect.value = bestIdx;
        }
        
        // Populate audio track selector if multiple tracks available
        if (resp.audioTracks && resp.audioTracks.length > 1 && audioSelect) {
          audioSelect.innerHTML = '';
          resp.audioTracks.forEach((t, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = '\uD83D\uDD0A ' + t.name + (t.language ? ' (' + t.language + ')' : '');
            if (t.isDefault) opt.selected = true;
            audioSelect.appendChild(opt);
          });
          audioSelect.style.display = '';
          audioSelect.dataset.audioTracks = JSON.stringify(resp.audioTracks);
          // Store group map for resolving correct audio URL per video quality
          if (resp.audioGroupMap) {
            audioSelect.dataset.audioGroupMap = JSON.stringify(resp.audioGroupMap);
          }
          // Auto-select preferred audio language
          if (userPrefs.prefAudio) {
            const bestAudioIdx = findBestLangIndex(resp.audioTracks, userPrefs.prefAudio);
            if (bestAudioIdx >= 0) audioSelect.value = bestAudioIdx;
          }
        }
        
        // Populate subtitle track selector if available
        // Prefer HLS subtitleTracks; if unavailable, use captured network subtitle URLs.
        let subTracks = (resp.subtitleTracks && resp.subtitleTracks.length > 0) ? resp.subtitleTracks : null;
        if (!subTracks && capturedSubtitles.length > 0) {
          subTracks = capturedSubtitles.map(s => ({
            url: s.url, language: s.language, name: s.name || s.language || 'Subtitles', isDefault: false, groupId: null
          }));
        }
        if (subTracks && subTracks.length > 0 && subtitleSelect) {
          subtitleSelect.innerHTML = '';
          const noneOpt = document.createElement('option');
          noneOpt.value = '-1';
          noneOpt.textContent = '\uD83D\uDCAC No subtitles';
          subtitleSelect.appendChild(noneOpt);
          subTracks.forEach((t, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = '\uD83D\uDCAC ' + t.name + (t.language ? ' (' + t.language + ')' : '');
            subtitleSelect.appendChild(opt);
          });
          subtitleSelect.style.display = '';
          subtitleSelect.dataset.subtitleTracks = JSON.stringify(subTracks);
          // Auto-select preferred subtitle language
          if (userPrefs.prefSubtitle) {
            const bestSubIdx = findBestLangIndex(subTracks, userPrefs.prefSubtitle);
            if (bestSubIdx >= 0) subtitleSelect.value = bestSubIdx;
          }
        }
      } else {
        // No qualities or error - keep existing if already populated, otherwise hide.
        let existingQualities = [];
        try {
          existingQualities = qualitySelect.dataset.qualities ? JSON.parse(qualitySelect.dataset.qualities) : [];
        } catch (e) {
          existingQualities = [];
        }
        if (existingQualities.length > 0) {
          qualitySelect.disabled = false;
        } else {
          qualitySelect.style.display = 'none';
        }
      }
    });
  }
  
  // For non-HLS items (or if HLS didn't have subtitles), populate from captured network subtitles
  if (subtitleSelect && !subtitleSelect.dataset.subtitleTracks && capturedSubtitles.length > 0) {
    const subTracks = capturedSubtitles.map(s => ({
      url: s.url, language: s.language, name: s.name || s.language || 'Subtitles', isDefault: false, groupId: null
    }));
    subtitleSelect.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '-1';
    noneOpt.textContent = '\uD83D\uDCAC No subtitles';
    subtitleSelect.appendChild(noneOpt);
    subTracks.forEach((t, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = '\uD83D\uDCAC ' + t.name + (t.language ? ' (' + t.language + ')' : '');
      subtitleSelect.appendChild(opt);
    });
    subtitleSelect.style.display = '';
    subtitleSelect.dataset.subtitleTracks = JSON.stringify(subTracks);
    // Auto-select preferred subtitle language
    if (userPrefs.prefSubtitle) {
      const bestSubIdx = findBestLangIndex(subTracks, userPrefs.prefSubtitle);
      if (bestSubIdx >= 0) subtitleSelect.value = bestSubIdx;
    }
  }
  
  downloadBtn.addEventListener('click', function() {
    this.disabled = true;
    this.innerHTML = '<span class="btn-icon spin">&#8635;</span><span class="btn-text">Starting</span>';
    this.className = 'download-btn btn-starting';

    if (!serverAvailable) {
      this.disabled = false;
      this.innerHTML = '<span class="btn-icon">&#9888;</span><span class="btn-text">Server Required</span>';
      this.className = 'download-btn btn-failed';
      updateStatus('Local server is required for downloads.', 'error');
      return;
    }

    let downloadUrl = video.url || video.src;
    let audioUrl = null;
    let dashVideoIndex = null;
    let dashAudioIndex = null;
    // Use selected quality if available
    if (isStream && qualitySelect && qualitySelect.dataset.qualities) {
      try {
        const qualities = JSON.parse(qualitySelect.dataset.qualities);
        const idx = parseInt(qualitySelect.value);
        if (qualities[idx]) {
          downloadUrl = qualities[idx].url;
          audioUrl = qualities[idx].audioUrl || null;
          if (typeof qualities[idx].dashVideoIndex === 'number') dashVideoIndex = qualities[idx].dashVideoIndex;
          if (typeof qualities[idx].dashAudioIndex === 'number') dashAudioIndex = qualities[idx].dashAudioIndex;
        }
      } catch(e) {}
    }
    // Override audio with user-selected audio track
    // Resolve from the correct audio group matching the selected video quality
    if (isStream && audioSelect && audioSelect.dataset.audioTracks) {
      try {
        const tracks = JSON.parse(audioSelect.dataset.audioTracks);
        const aidx = parseInt(audioSelect.value);
        if (tracks[aidx]) {
          const selectedTrack = tracks[aidx];
          // Try to get the audio URL from the group that matches the selected video variant
          const groupMap = audioSelect.dataset.audioGroupMap ? JSON.parse(audioSelect.dataset.audioGroupMap) : null;
          if (groupMap && qualitySelect && qualitySelect.dataset.qualities) {
            const qualities = JSON.parse(qualitySelect.dataset.qualities);
            const vidIdx = parseInt(qualitySelect.value);
            const variantGroupId = qualities[vidIdx] && qualities[vidIdx].audioGroupId;
            const langKey = selectedTrack.language || selectedTrack.name;
            if (variantGroupId && groupMap[variantGroupId] && groupMap[variantGroupId][langKey]) {
              audioUrl = groupMap[variantGroupId][langKey];
            } else {
              audioUrl = selectedTrack.url;
            }
          } else {
            audioUrl = selectedTrack.url;
          }
          if (typeof selectedTrack.dashAudioIndex === 'number') {
            dashAudioIndex = selectedTrack.dashAudioIndex;
          }
        }
      } catch(e) {}
    }
    let outputFormat = String(video.format || 'mp4').toLowerCase();
    if (qualitySelect && qualitySelect.dataset.qualities) {
      try {
        const qualities = JSON.parse(qualitySelect.dataset.qualities);
        const idx = parseInt(qualitySelect.value, 10);
        if (qualities[idx] && qualities[idx].format) {
          outputFormat = String(qualities[idx].format).toLowerCase();
        }
      } catch (e) {}
    }
    const ext = outputFormat || 'mp4';
    const filename = sanitizeFilename(title) + '.' + ext;
    const dlType = video.type || (video.format ? video.format.toUpperCase() : 'MP4');
    // Get selected subtitle track URL (works for both HLS and direct video)
    let subtitleUrl = null;
    if (subtitleSelect && subtitleSelect.dataset.subtitleTracks) {
      try {
        const subIdx = parseInt(subtitleSelect.value);
        if (subIdx >= 0) {
          const subTracks = JSON.parse(subtitleSelect.dataset.subtitleTracks);
          if (subTracks[subIdx]) subtitleUrl = subTracks[subIdx].url;
        }
      } catch(e) {}
    }
    if (!audioUrl && video.audioUrl) audioUrl = video.audioUrl;
    downloadStream(downloadUrl, filename, dlType, this, item, video.headers, video.url || video.src, audioUrl, subtitleUrl, outputFormat, dashVideoIndex, dashAudioIndex);
  });
  
  return item;
}

// Restore download progress UI for any active downloads when popup reopens
function restoreActiveDownloads() {
  if (!serverAvailable) return;
  
  // Fetch both server active downloads AND background stored mappings in parallel
  Promise.all([
    fetch('http://localhost:3000/active-downloads').then(r => r.json()).catch(() => ({ active: [] })),
    new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'getActiveDownloads' }, (resp) => {
        resolve(resp && resp.active ? resp.active : {});
      });
    })
  ]).then(([serverData, storedDownloads]) => {
    if (!serverData.active || serverData.active.length === 0) return;
    
    const items = document.querySelectorAll('.item');
    
    serverData.active.forEach(dl => {
      if (!dl.downloadId) return;
      
      // Look up the original video URL from background storage
      const stored = storedDownloads[dl.downloadId];
      const originalUrl = (stored && stored.videoUrl) ? stored.videoUrl : dl.sourceUrl;
      
      // Find the matching video item
      let matchedItem = null;
      for (let i = 0; i < allVideos.length; i++) {
        const videoUrl = allVideos[i].url || allVideos[i].src;
        if (videoUrl === originalUrl || videoUrl === dl.sourceUrl) {
          matchedItem = items[i];
          break;
        }
      }
      
      if (matchedItem) {
        attachProgressUI(matchedItem, dl);
      }
    });
  });
}

function attachProgressUI(item, dl) {
  const dlId = dl.downloadId;
  const button = item.querySelector('.download-btn');
  const bodyDiv = item.querySelector('.item-body');
  const qs = item.querySelector('.quality-select');
  
  // Don't attach twice
  if (item.querySelector('.progress-container')) return;
  
  // Check if this download already completed/failed
  const lp = dl.lastProgress;
  if (lp && (lp.status === 'complete' || lp.status === 'error' || lp.status === 'cancelled')) {
    // Show final state but don't build in-progress UI
    if (lp.status === 'complete') {
      button.innerHTML = '<span class="btn-icon">&#10003;</span><span class="btn-text">Done</span>';
      button.className = 'download-btn btn-done';
      chrome.runtime.sendMessage({ action: 'clearActiveDownload', downloadId: dlId });
    }
    return;
  }
  
  // Build in-progress UI
  const percent = (lp && lp.percent) ? lp.percent : 0;
  const infoText = (lp && lp.currentTime) ? (lp.currentTime + '/' + lp.totalTime + ' \u2022 ' + lp.speed + ' \u2022 ETA ' + lp.eta) : 'Resuming...';
  
  button.innerHTML = '<span class="btn-icon spin">&#8635;</span><span class="btn-text">' + Math.round(percent) + '%</span>';
  button.className = 'download-btn btn-downloading';
  button.disabled = true;
  if (qs) qs.disabled = true;
  const as2 = item.querySelector('.audio-select');
  if (as2) as2.disabled = true;
  const ss2 = item.querySelector('.subtitle-select');
  if (ss2) ss2.disabled = true;
  
  bodyDiv.insertAdjacentHTML('beforeend',
    '<div class="progress-container" data-download-id="' + dlId + '"><div class="progress-bar" style="width: ' + percent + '%">' + Math.round(percent) + '%</div></div><div class="progress-info">' + escapeHtml(infoText) + '</div>'
  );
  
  // Add cancel button
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'download-btn btn-cancel';
  cancelBtn.innerHTML = '<span class="btn-icon">\u2716</span><span class="btn-text">Cancel</span>';
  cancelBtn.addEventListener('click', function() {
    this.disabled = true;
    this.innerHTML = '<span class="btn-icon spin">&#8635;</span><span class="btn-text">Cancelling</span>';
    chrome.runtime.sendMessage({ action: 'cancelDownload', downloadId: dlId });
    // UI reset is handled by the WebSocket 'cancelled' status handler.
    // Keep a timeout guard in case the status message is dropped.
    setTimeout(() => {
      if (item.querySelector('.btn-cancel')) {
        updateStreamProgress(dlId, { status: 'cancelled' });
      }
    }, 3000);
  });
  button.style.display = 'none';
  button.parentElement.insertBefore(cancelBtn, button.nextSibling);
  
  updateStatus('Downloading...', 'loading');
}

function getThumbnailClass(video) {
  if (video.type === 'HLS') return 'th-hls';
  if (video.type === 'DASH') return 'th-dash';
  if (video.format === 'webm' || video.category === 'WEBM') return 'th-mp4';
  if (video.format === 'mp4' || video.category === 'MP4') return 'th-mp4';
  return 'th-video';
}

function getThumbnailLabel(video) {
  if (video.type === 'HLS') return 'HLS';
  if (video.type === 'DASH') return 'DASH';
  if (video.format === 'webm' || video.category === 'WEBM') return 'WEBM';
  if (video.format === 'mp4' || video.category === 'MP4') return 'MP4';
  return '\u25B6';
}

function getBadgeClass(video) {
  if (video.type === 'HLS') return 'badge-hls';
  if (video.type === 'DASH') return 'badge-dash';
  if (video.format === 'webm') return 'badge-mp4';
  if (video.format === 'mp4') return 'badge-mp4';
  return 'badge-direct';
}

function getBadgeText(video) {
  if (video.type === 'HLS') return 'HLS';
  if (video.type === 'DASH') return 'DASH';
  if (video.format === 'webm') return video.quality ? 'WEBM ' + video.quality : 'WEBM';
  if (video.format === 'mp4') return video.quality ? 'MP4 ' + video.quality : 'MP4';
  return video.category || 'VIDEO';
}

function downloadStream(url, filename, type, button, item, headers, originalUrl, audioUrl, subtitleUrl, outputFormat, dashVideoIndex, dashAudioIndex) {
  chrome.runtime.sendMessage({
    action: 'downloadViaServer', url: url, filename: filename, type: type, headers: headers || null, originalUrl: originalUrl || url, audioUrl: audioUrl || null, subtitleUrl: subtitleUrl || null, outputFormat: outputFormat || 'mp4', dashVideoIndex: (typeof dashVideoIndex === 'number' ? dashVideoIndex : null), dashAudioIndex: (typeof dashAudioIndex === 'number' ? dashAudioIndex : null)
  }, (response) => {
    if (response && response.success) {
      const dlId = response.data.downloadId;
      button.innerHTML = '<span class="btn-icon spin">&#8635;</span><span class="btn-text">0%</span>';
      button.className = 'download-btn btn-downloading';
      updateStatus('Downloading...', 'loading');
      // Disable quality select during download
      const qs = item.querySelector('.quality-select');
      if (qs) qs.disabled = true;
      const as = item.querySelector('.audio-select');
      if (as) as.disabled = true;
      const ss = item.querySelector('.subtitle-select');
      if (ss) ss.disabled = true;
      const bodyDiv = item.querySelector('.item-body');
      bodyDiv.insertAdjacentHTML('beforeend',
        '<div class="progress-container" data-download-id="' + dlId + '"><div class="progress-bar" style="width: 0%">0%</div></div><div class="progress-info">Initializing...</div>'
      );
      
      // Replace download button with cancel button
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'download-btn btn-cancel';
      cancelBtn.innerHTML = '<span class="btn-icon">\u2716</span><span class="btn-text">Cancel</span>';
      cancelBtn.addEventListener('click', function() {
        this.disabled = true;
        this.innerHTML = '<span class="btn-icon spin">&#8635;</span><span class="btn-text">Cancelling</span>';
        chrome.runtime.sendMessage({ action: 'cancelDownload', downloadId: dlId });
        // UI reset is handled by the WebSocket 'cancelled' status handler.
        // Keep a timeout guard in case the status message is dropped.
        setTimeout(() => {
          if (item.querySelector('.btn-cancel')) {
            updateStreamProgress(dlId, { status: 'cancelled' });
          }
        }, 3000);
      });
      button.style.display = 'none';
      button.parentElement.insertBefore(cancelBtn, button.nextSibling);
    } else {
      button.innerHTML = '<span class="btn-icon">\u2716</span><span class="btn-text">Failed</span>';
      button.className = 'download-btn btn-failed';
      button.disabled = false;
      updateStatus('Server error occurred', 'error');
    }
  });
}

function clearData() {
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    chrome.runtime.sendMessage({action: 'clearStreams', tabId: tabs[0].id});
    allVideos = [];
    displayAllVideos();
    document.getElementById('videoCount').textContent = '0 videos';
    updateStatus('All data cleared', 'success');
  });
}

function updateStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = type ? ('status-' + type) : '';
}

function sanitizeFilename(filename) {
  return filename
    .replace(/['"` ]/g, '_')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[^a-zA-Z0-9._\-\(\)\[\]]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 100) || ('video_' + Date.now());
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDurationPopup(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return '';
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

function addToHistory(filename, size) {
  // Get current tab URL for source domain
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    let source = '';
    try {
      if (tabs[0] && tabs[0].url) {
        source = new URL(tabs[0].url).hostname;
      }
    } catch(e) {}
    chrome.runtime.sendMessage({
      action: 'addToHistory',
      filename: filename || 'Unknown',
      source: source,
      size: size || ''
    });
  });
}
