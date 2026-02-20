chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getVideos') {
    console.log('[VideoDownloader] Scanning page...');
    
    const videos = [];
    const allVideos = document.querySelectorAll('video');
    
    // Grab page-level thumbnail & duration once (shared across all videos)
    const pageThumbnail = findPageThumbnail();
    const pageDuration = getMetaDuration();
    
    console.log('[VideoDownloader] Found ' + allVideos.length + ' <video> tags');
    console.log('[VideoDownloader] Page thumbnail: ' + (pageThumbnail ? pageThumbnail.substring(0, 80) : 'none'));
    console.log('[VideoDownloader] Page duration: ' + (pageDuration ? pageDuration.formatted : 'none'));
    
    allVideos.forEach((video, index) => {
      const src = video.src || video.currentSrc;
      const isBlob = src && src.startsWith('blob:');
      
      if (src && (src.startsWith('http') || src.startsWith('blob'))) {
        const title = findVideoTitle(video, index);
        const thumbnail = findVideoThumbnail(video) || pageThumbnail;
        const metadata = extractMetadata(video);
        
        // Duration: try video element first, then page metadata
        let durationStr = 'N/A';
        let durationSec = null;
        if (video.duration && isFinite(video.duration) && video.duration > 0.5) {
          durationStr = formatDuration(video.duration);
          durationSec = Math.floor(video.duration);
        } else if (pageDuration) {
          durationStr = pageDuration.formatted;
          durationSec = pageDuration.seconds;
        }

        videos.push({
          id: index,
          url: src,
          src: src,
          isBlob: isBlob,
          type: isBlob ? 'Blob (check streams)' : 'Direct',
          poster: thumbnail,
          thumbnail: thumbnail,
          duration: durationStr,
          durationSeconds: durationSec,
          dimensions: video.videoWidth ? (video.videoWidth + 'x' + video.videoHeight) : 'Unknown',
          title: title,
          metadata: metadata
        });
      }
    });
    
    const pageInfo = getPageMetadata();
    
    // Scan for subtitle tracks from <track> elements and player APIs
    const subtitleTracks = findSubtitleTracks(allVideos);
    
    // Discover HLS/DASH streams from the page's loaded resources (fallback for
    // when the service worker restarted and lost in-memory streamData)
    const discoveredStreams = discoverStreamsFromPerformance();

    sendResponse({
      videos: videos,
      pageInfo: pageInfo,
      pageThumbnail: pageThumbnail,
      pageDuration: pageDuration,
      subtitleTracks: subtitleTracks,
      youtubeStreams: findYouTubeStreams(),
      discoveredStreams: discoveredStreams,
      debug: {
        totalVideos: allVideos.length,
        blobCount: videos.filter(v => v.isBlob).length,
        discoveredStreamCount: discoveredStreams.length,
        pageUrl: window.location.href
      }
    });
  } else if (request.action === 'autoScan') {
    // Quick check: are there any video elements or iframes on the page?
    const hasVideo = document.querySelectorAll('video').length > 0;
    const hasIframe = document.querySelectorAll('iframe[src*="player"], iframe[src*="embed"], iframe[src*="video"]').length > 0;
    sendResponse({ hasVideo, hasIframe });
  }
  return true;
});

// ============ DISCOVER HLS/DASH FROM PERFORMANCE API ============
// When the service worker restarts (Manifest V3 idle timeout), in-memory
// streamData is lost.  As a fallback, scan the browser's resource timing
// entries to recover .m3u8 / .mpd URLs that were already fetched.
function discoverStreamsFromPerformance() {
  const found = [];
  const seen = new Set();
  try {
    const entries = performance.getEntriesByType('resource');
    entries.forEach(entry => {
      const url = entry.name;
      if (!url) return;
      const urlPath = url.split('?')[0].split('#')[0].toLowerCase();
      const isM3U8 = urlPath.endsWith('.m3u8') || /\.m3u8\b/i.test(url);
      const isMPD  = urlPath.endsWith('.mpd')  || /\.mpd\b/i.test(url);
      if ((isM3U8 || isMPD) && !seen.has(url)) {
        seen.add(url);
        found.push({
          url: url,
          type: isM3U8 ? 'HLS' : 'DASH',
          format: isM3U8 ? 'm3u8' : 'mpd',
          quality: url.toLowerCase().includes('master') ? 'Master' : 'Playlist',
          source: 'performance'
        });
      }
    });
  } catch (e) {
    console.log('[VideoDownloader] Performance API scan failed:', e.message);
  }
  if (found.length > 0) {
    console.log('[VideoDownloader] Discovered ' + found.length + ' stream(s) from Performance API');
  }
  return found;
}

// ============ YOUTUBE STREAM EXTRACTION ============
// YouTube embeds stream URLs in ytInitialPlayerResponse on the page.
// webRequest can't see these (YouTube's JS player fetches internally via service worker).
// We parse the full JSON from the <script> tag to extract stream URLs.

function findYouTubeStreams() {
  if (!window.location.hostname.includes('youtube.com')) return [];

  console.log('[VideoDownloader] YouTube detected, scanning for streams...');
  var streams = [];
  var scripts = document.querySelectorAll('script');
  var foundPlayerResponse = false;

  for (var i = 0; i < scripts.length; i++) {
    var text = scripts[i].textContent || '';
    if (!text.includes('ytInitialPlayerResponse')) continue;
    foundPlayerResponse = true;
    if (!text.includes('streamingData')) {
      console.log('[VideoDownloader] Found ytInitialPlayerResponse but no streamingData in script tag');
      continue;
    }

    // Find the start of the ytInitialPlayerResponse JSON object
    var assignIdx = text.indexOf('ytInitialPlayerResponse');
    if (assignIdx === -1) continue;
    var braceIdx = text.indexOf('{', assignIdx);
    if (braceIdx === -1) continue;

    // String-aware brace counter to find the matching closing brace
    var depth = 0;
    var inStr = false;
    var esc = false;
    var endIdx = -1;
    for (var j = braceIdx; j < text.length; j++) {
      var c = text[j];
      if (esc)              { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true;  continue; }
      if (c === '"')        { inStr = !inStr; continue; }
      if (inStr)            { continue; }
      if (c === '{')        { depth++; }
      else if (c === '}')   { depth--; if (depth === 0) { endIdx = j; break; } }
    }
    if (endIdx === -1) continue;

    try {
      var data = JSON.parse(text.substring(braceIdx, endIdx + 1));
      var sd = data.streamingData;
      if (!sd) continue;

      // 1) DASH manifest (live streams / some videos)
      if (sd.dashManifestUrl) {
        streams.push({ url: sd.dashManifestUrl, type: 'DASH', format: 'mpd', quality: 'Manifest' });
        console.log('[VideoDownloader] YouTube DASH manifest:', sd.dashManifestUrl.substring(0, 80));
      }
      // 2) HLS manifest (live streams)
      if (sd.hlsManifestUrl) {
        streams.push({ url: sd.hlsManifestUrl, type: 'HLS', format: 'm3u8', quality: 'Master' });
        console.log('[VideoDownloader] YouTube HLS manifest:', sd.hlsManifestUrl.substring(0, 80));
      }
      // 3) Adaptive formats: best video-only + best audio (1080p+, requires server merge)
      if (streams.length === 0 && sd.adaptiveFormats && sd.adaptiveFormats.length > 0) {
        var audioStreams = sd.adaptiveFormats.filter(function(f) {
          return f.url && f.mimeType && f.mimeType.startsWith('audio/mp4');
        }).sort(function(a, b) {
          return (b.bitrate || 0) - (a.bitrate || 0);
        });
        var videoOnlyStreams = sd.adaptiveFormats.filter(function(f) {
          return f.url && f.mimeType && f.mimeType.startsWith('video/mp4') && f.qualityLabel;
        }).sort(function(a, b) {
          return (b.height || 0) - (a.height || 0);
        });
        if (videoOnlyStreams.length > 0 && audioStreams.length > 0) {
          var bestVideo = videoOnlyStreams[0];
          var bestAudio = audioStreams[0];
          streams.push({ url: bestVideo.url, audioUrl: bestAudio.url, type: 'MP4', format: 'mp4', quality: bestVideo.qualityLabel || (bestVideo.height + 'p') });
          console.log('[VideoDownloader] YouTube adaptive stream:', bestVideo.qualityLabel, bestVideo.url.substring(0, 80));
        }
      }
      // 4) Fallback: progressive formats (combined video+audio, up to 720p)
      if (streams.length === 0 && sd.formats && sd.formats.length > 0) {
        var videoFormats = sd.formats.filter(function(f) {
          return f.url && f.mimeType && f.mimeType.startsWith('video/');
        }).sort(function(a, b) {
          return (b.height || 0) - (a.height || 0);
        });
        if (videoFormats.length > 0) {
          var best = videoFormats[0];
          streams.push({ url: best.url, type: 'MP4', format: 'mp4', quality: best.qualityLabel || (best.height ? best.height + 'p' : 'Best') });
          console.log('[VideoDownloader] YouTube progressive stream:', best.qualityLabel, best.url.substring(0, 80));
        }
      }
    } catch(e) {
      console.log('[VideoDownloader] YouTube JSON parse error:', e.message);
    }

    if (streams.length > 0) break;
  }

  if (streams.length === 0) {
    if (!foundPlayerResponse) {
      console.log('[VideoDownloader] No script tags contain ytInitialPlayerResponse (SPA navigation?) — background will try MAIN world extraction');
    } else {
      console.log('[VideoDownloader] ytInitialPlayerResponse found but no extractable streams (signatureCipher?)');
    }
  }
  return streams;
}

// ============ SUBTITLE TRACK DISCOVERY ============

function findSubtitleTracks(videoElements) {
  var tracks = [];
  var seenUrls = {};
  
  function addTrack(url, lang, label, format) {
    if (!url || seenUrls[url]) return;
    // Skip blob URLs
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    // Resolve relative URLs
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) {
      try { url = new URL(url, window.location.origin).href; } catch(e) { return; }
    } else if (!url.startsWith('http')) {
      try { url = new URL(url, window.location.href).href; } catch(e) { return; }
    }
    seenUrls[url] = true;
    // Detect format from URL
    if (!format) {
      var ext = url.split('?')[0].match(/\.(vtt|srt|ass|ssa|ttml)$/i);
      format = ext ? ext[1].toLowerCase() : 'vtt';
    }
    tracks.push({
      url: url,
      language: lang || '',
      name: label || lang || 'Subtitles',
      format: format
    });
  }
  
  // 1) Scan <track> elements inside all <video> tags
  videoElements.forEach(function(video) {
    var trackEls = video.querySelectorAll('track');
    trackEls.forEach(function(track) {
      var kind = (track.kind || '').toLowerCase();
      if (kind === 'subtitles' || kind === 'captions' || kind === '') {
        var src = track.src || track.getAttribute('src');
        var lang = track.srclang || track.getAttribute('srclang') || '';
        var label = track.label || track.getAttribute('label') || '';
        addTrack(src, lang, label, null);
      }
    });
    // Also check video.textTracks API for programmatically added tracks
    try {
      if (video.textTracks) {
        for (var i = 0; i < video.textTracks.length; i++) {
          var tt = video.textTracks[i];
          if (tt.kind === 'subtitles' || tt.kind === 'captions') {
            // textTrack doesn't always expose the source URL, but cues may be available
            // We can't easily extract the URL from TextTrack API, but track elements should cover it
          }
        }
      }
    } catch(e) {}
  });
  
  // 2) Scan ALL <track> elements in the page (including those inside iframes' shadow DOMs or custom players)
  var allTrackEls = document.querySelectorAll('track[src]');
  allTrackEls.forEach(function(track) {
    var kind = (track.kind || '').toLowerCase();
    if (kind === 'subtitles' || kind === 'captions' || kind === '' || !kind) {
      var src = track.getAttribute('src');
      var lang = track.getAttribute('srclang') || '';
      var label = track.getAttribute('label') || '';
      addTrack(src, lang, label, null);
    }
  });
  
  // 3) Look for subtitle URLs in page scripts (common patterns used by anime sites)
  // Search for URLs in script contents that look like subtitle files
  try {
    var scriptEls = document.querySelectorAll('script:not([src])');
    scriptEls.forEach(function(script) {
      var text = script.textContent || '';
      if (text.length > 1000000) return; // Skip very large scripts
      // Match URLs ending in .vtt, .srt, .ass with optional query params
      var subUrlMatches = text.match(/["'](https?:\/\/[^"'\s]+\.(vtt|srt|ass|ssa|ttml)(?:\?[^"'\s]*)?)['"]/gi);
      if (subUrlMatches) {
        subUrlMatches.forEach(function(match) {
          var urlStr = match.slice(1, -1); // Remove surrounding quotes
          addTrack(urlStr, '', '', null);
        });
      }
    });
  } catch(e) {}
  
  // 4) Check for jassub/libass elements (used by 9anime and other anime sites)
  // These sites often use a canvas-based subtitle renderer
  try {
    // Look for subtitle file URLs in data attributes
    var subElements = document.querySelectorAll('[data-subtitle], [data-sub], [data-caption], [data-subs-url]');
    subElements.forEach(function(el) {
      var subUrl = el.getAttribute('data-subtitle') || el.getAttribute('data-sub') || 
                   el.getAttribute('data-caption') || el.getAttribute('data-subs-url');
      if (subUrl) addTrack(subUrl, '', '', null);
    });
  } catch(e) {}
  
  console.log('[VideoDownloader] Found ' + tracks.length + ' subtitle tracks from DOM');
  return tracks;
}

// ============ TITLE ============

function findVideoTitle(videoElement, index) {
  if (videoElement.getAttribute('aria-label')) return videoElement.getAttribute('aria-label');
  if (videoElement.getAttribute('title')) return videoElement.getAttribute('title');
  
  var parent = videoElement.parentElement;
  for (var i = 0; i < 5 && parent; i++) {
    var heading = parent.querySelector('h1, h2, h3, [class*="title"], [class*="Title"]');
    if (heading && heading.textContent.trim()) return heading.textContent.trim().substring(0, 100);
    parent = parent.parentElement;
  }
  
  var siblings = videoElement.parentElement ? videoElement.parentElement.children : [];
  for (var s = 0; s < siblings.length; s++) {
    var sib = siblings[s];
    if (sib !== videoElement && sib.textContent.trim().length > 5 && sib.textContent.trim().length < 150) {
      return sib.textContent.trim();
    }
  }
  
  if (document.title && document.title.length > 3) return document.title;
  return 'Video ' + (index + 1);
}

// ============ THUMBNAIL (PER VIDEO ELEMENT) ============

function findVideoThumbnail(videoElement) {
  function isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    url = url.trim();
    if (url.length < 10) return false;
    if (url.startsWith('data:image')) return true;
    if (url.startsWith('http') || url.startsWith('//') || url.startsWith('/')) {
      // Reject non-thumbnails
      if (/spacer|pixel|tracking|beacon|1x1|\.svg|blank\.gif|transparent|\.ico/i.test(url)) return false;
      return true;
    }
    return false;
  }

  function resolveUrl(url) {
    if (!url) return null;
    url = url.trim();
    if (url.startsWith('data:')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) {
      try { return new URL(url, window.location.origin).href; } catch(e) { return null; }
    }
    return url;
  }

  function getImgSrc(img) {
    if (!img) return null;
    // Skip tiny images (tracking pixels, icons)
    if (img.naturalWidth > 0 && img.naturalWidth < 50) return null;
    if (img.naturalHeight > 0 && img.naturalHeight < 50) return null;
    
    // Lazy-load attributes
    var lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-thumb', 
                     'data-poster', 'data-image', 'data-full-src', 'data-hi-res'];
    for (var i = 0; i < lazyAttrs.length; i++) {
      var val = img.getAttribute(lazyAttrs[i]);
      if (isValidImageUrl(val)) return resolveUrl(val);
    }
    if (isValidImageUrl(img.src)) return resolveUrl(img.src);
    
    // srcset - pick largest
    var srcset = img.getAttribute('srcset');
    if (srcset) {
      var entries = srcset.split(',').map(function(s) { return s.trim().split(/\s+/); });
      entries.sort(function(a, b) { return (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0); });
      for (var j = 0; j < entries.length; j++) {
        if (isValidImageUrl(entries[j][0])) return resolveUrl(entries[j][0]);
      }
    }
    return null;
  }

  function getBgImage(el) {
    try {
      var bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        var match = bg.match(/url\(["']?(.*?)["']?\)/);
        if (match && isValidImageUrl(match[1])) return resolveUrl(match[1]);
      }
    } catch(e) {}
    return null;
  }

  // 1) Video poster attribute
  if (videoElement.poster && isValidImageUrl(videoElement.poster)) {
    return resolveUrl(videoElement.poster);
  }

  // 2) Canvas capture if video is loaded/playing
  try {
    if (videoElement.readyState >= 2 && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
      var canvas = document.createElement('canvas');
      canvas.width = Math.min(videoElement.videoWidth, 320);
      canvas.height = Math.min(videoElement.videoHeight, 180);
      var ctx = canvas.getContext('2d');
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      if (dataUrl && dataUrl.length > 500) return dataUrl;
    }
  } catch (e) {}

  // 3) Search ancestors for thumbnail images (10 levels)
  var thumbKeywords = ['thumb', 'poster', 'cover', 'preview', 'placeholder', 'hero', 'keyframe', 'snapshot', 'img-container', 'media-image'];
  
  var ancestor = videoElement.parentElement;
  for (var depth = 0; depth < 10 && ancestor && ancestor !== document.body; depth++) {
    // a) Images with keyword hints
    for (var k = 0; k < thumbKeywords.length; k++) {
      var keyword = thumbKeywords[k];
      var selectors = [
        'img[class*="' + keyword + '"]',
        'img[id*="' + keyword + '"]', 
        'img[src*="' + keyword + '"]',
        'img[data-src*="' + keyword + '"]',
        '[class*="' + keyword + '"] > img',
        'div[class*="' + keyword + '"]'
      ];
      for (var si = 0; si < selectors.length; si++) {
        try {
          var el = ancestor.querySelector(selectors[si]);
          if (!el) continue;
          if (el.tagName === 'IMG') {
            var src = getImgSrc(el);
            if (src) return src;
          } else {
            var innerImg = el.querySelector('img');
            if (innerImg) { var isrc = getImgSrc(innerImg); if (isrc) return isrc; }
            var bgSrc = getBgImage(el);
            if (bgSrc) return bgSrc;
          }
        } catch(e) {}
      }
    }

    // b) Background image on ancestor with keyword class
    var cls = (ancestor.className || '').toString().toLowerCase();
    for (var ki = 0; ki < thumbKeywords.length; ki++) {
      if (cls.includes(thumbKeywords[ki])) {
        var bg = getBgImage(ancestor);
        if (bg) return bg;
        break;
      }
    }

    // c) Any reasonable sized img at this level
    var allImgs = ancestor.querySelectorAll(':scope > img, :scope > div > img, :scope > figure > img, :scope > picture img');
    for (var ii = 0; ii < allImgs.length; ii++) {
      var theImg = allImgs[ii];
      var w = theImg.naturalWidth || theImg.width || parseInt(theImg.getAttribute('width')) || 0;
      if (w >= 80 || !theImg.complete) {
        var imgSrc = getImgSrc(theImg);
        if (imgSrc) return imgSrc;
      }
    }

    ancestor = ancestor.parentElement;
  }

  return null;
}

// ============ PAGE-LEVEL THUMBNAIL ============

function findPageThumbnail() {
  function isValid(url) {
    if (!url || typeof url !== 'string') return false;
    url = url.trim();
    return url.startsWith('http') || url.startsWith('//');
  }
  function resolve(url) {
    if (!url) return null;
    url = url.trim();
    if (url.startsWith('//')) return 'https:' + url;
    return url;
  }

  var metaSelectors = [
    'meta[property="og:image"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'meta[itemprop="thumbnailUrl"]',
    'meta[itemprop="image"]',
    'link[rel="image_src"]',
    'link[rel="preload"][as="image"]'
  ];
  for (var i = 0; i < metaSelectors.length; i++) {
    var el = document.querySelector(metaSelectors[i]);
    if (el) {
      var content = el.getAttribute('content') || el.getAttribute('href');
      if (isValid(content)) return resolve(content);
    }
  }

  // JSON-LD schema.org
  try {
    var ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var j = 0; j < ldScripts.length; j++) {
      try {
        var json = JSON.parse(ldScripts[j].textContent);
        var items = Array.isArray(json) ? json : (json['@graph'] || [json]);
        for (var k = 0; k < items.length; k++) {
          var thumb = items[k].thumbnailUrl || items[k].image;
          if (thumb) {
            var url = typeof thumb === 'string' ? thumb : (thumb.url || thumb.contentUrl || (Array.isArray(thumb) ? thumb[0] : null));
            if (typeof url === 'object' && url) url = url.url || null;
            if (isValid(url)) return resolve(url);
          }
        }
      } catch(e) {}
    }
  } catch(e) {}

  return null;
}

// ============ METADATA ============

function extractMetadata(videoElement) {
  return {
    playing: !videoElement.paused,
    currentTime: videoElement.currentTime ? Math.floor(videoElement.currentTime) : 0,
    volume: Math.round(videoElement.volume * 100),
    muted: videoElement.muted,
    playbackRate: videoElement.playbackRate
  };
}

function getPageMetadata() {
  var ogTitle = document.querySelector('meta[property="og:title"]');
  var ogDesc = document.querySelector('meta[property="og:description"]');
  var ogImg = document.querySelector('meta[property="og:image"]');
  return {
    title: document.title,
    url: window.location.href,
    domain: window.location.hostname,
    ogTitle: ogTitle ? ogTitle.getAttribute('content') : null,
    ogDescription: ogDesc ? ogDesc.getAttribute('content') : null,
    ogImage: ogImg ? ogImg.getAttribute('content') : null
  };
}

// ============ DURATION ============

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return 'N/A';
  seconds = Math.floor(seconds);
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

function getMetaDuration() {
  // 1) meta itemprop duration
  var metaDur = document.querySelector('meta[itemprop="duration"]');
  if (metaDur) {
    var p = parseISO8601Duration(metaDur.getAttribute('content'));
    if (p) return p;
  }

  // 2) JSON-LD
  try {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var json = JSON.parse(scripts[i].textContent);
        var items = Array.isArray(json) ? json : (json['@graph'] || [json]);
        for (var j = 0; j < items.length; j++) {
          if (items[j].duration) {
            var parsed = parseISO8601Duration(items[j].duration);
            if (parsed) return parsed;
          }
        }
      } catch(e) {}
    }
  } catch(e) {}

  // 3) [itemprop="duration"] element
  var durEl = document.querySelector('[itemprop="duration"]');
  if (durEl) {
    var val = durEl.getAttribute('content') || durEl.getAttribute('datetime') || durEl.textContent.trim();
    var p2 = parseISO8601Duration(val);
    if (p2) return p2;
    var plainMatch = val.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (plainMatch) {
      var th = plainMatch[3] ? parseInt(plainMatch[1]) : 0;
      var tm = plainMatch[3] ? parseInt(plainMatch[2]) : parseInt(plainMatch[1]);
      var ts = plainMatch[3] ? parseInt(plainMatch[3]) : parseInt(plainMatch[2]);
      var totalSec = th * 3600 + tm * 60 + ts;
      if (totalSec > 0) return { seconds: totalSec, formatted: formatDuration(totalSec) };
    }
  }

  // 4) og:video:duration
  var ogDur = document.querySelector('meta[property="og:video:duration"], meta[property="video:duration"]');
  if (ogDur) {
    var sec = parseInt(ogDur.getAttribute('content'));
    if (sec > 0) return { seconds: sec, formatted: formatDuration(sec) };
  }

  // 5) Visible duration text on page
  var durationEls = document.querySelectorAll('[class*="duration"], [class*="Duration"], [class*="time-duration"], [class*="video-time"], [class*="vjs-duration"], [class*="vjs-remaining-time"], .ytp-time-duration');
  for (var d = 0; d < durationEls.length; d++) {
    var text = durationEls[d].textContent.trim();
    var dm = text.match(/^-?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (dm) {
      var dh = dm[3] ? parseInt(dm[1]) : 0;
      var dmm = dm[3] ? parseInt(dm[2]) : parseInt(dm[1]);
      var ds = dm[3] ? parseInt(dm[3]) : parseInt(dm[2]);
      var dTotal = dh * 3600 + dmm * 60 + ds;
      if (dTotal > 0) return { seconds: dTotal, formatted: formatDuration(dTotal) };
    }
  }

  return null;
}

function parseISO8601Duration(str) {
  if (!str || typeof str !== 'string') return null;
  var match = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) return null;
  var h = parseInt(match[1]) || 0;
  var m = parseInt(match[2]) || 0;
  var s = parseInt(match[3]) || 0;
  var totalSec = h * 3600 + m * 60 + s;
  if (totalSec === 0) return null;
  return { seconds: totalSec, formatted: formatDuration(totalSec) };
}
