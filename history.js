// History page logic
const SERVER_URL = 'http://localhost:3000';
let historyEnabled = true;

document.addEventListener('DOMContentLoaded', () => {
  loadHistory();
  loadRememberSetting();

  document.getElementById('searchInput').addEventListener('input', debounce(filterHistory, 200));
  document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);
  document.getElementById('toggleRememberBtn').addEventListener('click', toggleRemember);
  document.getElementById('enableHistoryBtn').addEventListener('click', () => {
    historyEnabled = true;
    chrome.storage.local.set({ historyEnabled: true });
    updateRememberButton();
    updateDisabledBanner();
    loadHistory();
  });
});

function loadHistory() {
  chrome.storage.local.get('downloadHistory', (result) => {
    const history = result.downloadHistory || [];
    renderHistory(history);
  });
}

function loadRememberSetting() {
  chrome.storage.local.get('historyEnabled', (result) => {
    historyEnabled = result.historyEnabled !== false; // default true
    updateRememberButton();
    updateDisabledBanner();
  });
}

function updateRememberButton() {
  const btn = document.getElementById('toggleRememberBtn');
  if (historyEnabled) {
    btn.textContent = 'Do not remember my history';
    btn.classList.add('btn-remembering');
  } else {
    btn.textContent = 'Remember my history';
    btn.classList.remove('btn-remembering');
  }
}

function toggleRemember() {
  historyEnabled = !historyEnabled;
  chrome.storage.local.set({ historyEnabled: historyEnabled });
  updateRememberButton();
  updateDisabledBanner();
  if (historyEnabled) loadHistory();
}

function updateDisabledBanner() {
  const banner = document.getElementById('disabledBanner');
  const toolbar = document.querySelector('.toolbar');
  const list = document.getElementById('historyList');
  if (historyEnabled) {
    banner.classList.remove('visible');
    toolbar.style.display = '';
    list.style.display = '';
  } else {
    banner.classList.add('visible');
    toolbar.style.display = 'none';
    list.style.display = 'none';
  }
}

function renderHistory(history) {
  const container = document.getElementById('historyList');
  const search = document.getElementById('searchInput').value.toLowerCase().trim();

  // Filter
  let filtered = history;
  if (search) {
    filtered = history.filter(item =>
      (item.filename || '').toLowerCase().includes(search) ||
      (item.source || '').toLowerCase().includes(search)
    );
  }

  // Sort by date descending
  filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  if (filtered.length === 0) {
    container.innerHTML =
      '<div class="empty-state">' +
        '<span class="tool-icon">&#x1F4DC;</span>' +
        '<div class="title">' + (search ? 'No results found' : 'No download history') + '</div>' +
        '<div class="subtitle">' + (search ? 'Try a different search term' : 'Downloaded videos will appear here') + '</div>' +
      '</div>';
    return;
  }

  container.innerHTML = filtered.map((item, index) => {
    const favicon = item.source ? ('https://www.google.com/s2/favicons?domain=' + encodeURIComponent(item.source) + '&sz=32') : '';
    const sourceLabel = item.source || 'Unknown';
    const sizeText = item.size || '';
    const dateText = item.timestamp ? formatDate(item.timestamp) : '';

    return '<div class="history-item" data-id="' + escapeAttr(item.id) + '">' +
      '<div class="item-info">' +
        '<div class="item-filename" title="' + escapeAttr(item.filename) + '">' + escapeHtml(item.filename) + '</div>' +
        '<div class="item-source">' +
          (favicon ? '<img src="' + favicon + '" alt="" onerror="this.style.display=\'none\'">' : '') +
          '<span>' + escapeHtml(sourceLabel) + '</span>' +
        '</div>' +
        (sizeText || dateText ? '<div class="item-details">' +
          (sizeText ? '<span class="item-detail">' + escapeHtml(sizeText) + '</span>' : '') +
          (sizeText && dateText ? '<span class="item-detail-sep">•</span>' : '') +
          (dateText ? '<span class="item-detail">' + escapeHtml(dateText) + '</span>' : '') +
        '</div>' : '') +
      '</div>' +
      '<div class="item-actions">' +
        '<button class="action-btn btn-delete" title="Remove from history" data-action="delete">' +
          '✕' +
        '</button>' +
        '<button class="play-btn" title="Play video" data-action="play">' +
          '▶ Play' +
        '</button>' +
        '<button class="folder-btn" title="Show in folder" data-action="open">' +
          '📂' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');

  // Attach event listeners
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', function() {
      const itemEl = this.closest('.history-item');
      const id = itemEl.dataset.id;
      const action = this.dataset.action;
      handleAction(action, id, itemEl);
    });
  });
}

function handleAction(action, id, itemEl) {
  chrome.storage.local.get('downloadHistory', (result) => {
    const history = result.downloadHistory || [];
    const item = history.find(h => h.id === id);
    if (!item) return;

    if (action === 'delete') {
      // Remove from history only
      const updated = history.filter(h => h.id !== id);
      chrome.storage.local.set({ downloadHistory: updated }, () => {
        itemEl.style.transition = 'opacity 0.2s, transform 0.2s';
        itemEl.style.opacity = '0';
        itemEl.style.transform = 'translateX(20px)';
        setTimeout(() => { itemEl.remove(); checkEmpty(); }, 200);
      });
    } else if (action === 'play') {
      // Open video in a new tab via server
      window.open(SERVER_URL + '/play/' + encodeURIComponent(item.filename), '_blank');
    } else if (action === 'open') {
      // Open file in system default player / file explorer
      fetch(SERVER_URL + '/open-file/' + encodeURIComponent(item.filename))
        .catch(() => alert('Server is not running'));
    }
  });
}

function checkEmpty() {
  const container = document.getElementById('historyList');
  if (container.querySelectorAll('.history-item').length === 0) {
    container.innerHTML =
      '<div class="empty-state">' +
        '<div class="icon">📭</div>' +
        '<div class="title">No download history</div>' +
        '<div class="subtitle">Downloaded videos will appear here</div>' +
      '</div>';
  }
}

function filterHistory() {
  loadHistory();
}

function clearHistory() {
  if (!confirm('Clear all download history? This does not delete the files.')) return;
  chrome.storage.local.set({ downloadHistory: [] }, () => {
    loadHistory();
  });
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 172800000) return 'Yesterday';

  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function debounce(fn, delay) {
  let timer;
  return function() {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, arguments), delay);
  };
}
