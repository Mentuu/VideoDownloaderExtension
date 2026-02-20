// === Settings Page Logic ===

const SERVER_URL = 'http://localhost:3000';

const DEFAULTS = {
  prefQuality: 'highest',
  prefAudio: '',
  prefSubtitle: '',
  autoSelectQuality: true,
  filenameFormat: 'title',
  historyEnabled: true,
  notificationsEnabled: false,
  autoScanEnabled: true,
  theme: 'system',
  panelPosition: 'popup'
};

// All setting keys for chrome.storage.local
const SETTING_KEYS = Object.keys(DEFAULTS);

// === TOAST ===
function showToast(message, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

// === LOAD VERSION & STATUS ===
function loadAbout() {
  // Extension version from manifest
  const manifest = chrome.runtime.getManifest();
  document.getElementById('extVersion').textContent = 'v' + manifest.version;
  document.getElementById('versionBadge').textContent = 'v' + manifest.version;
  document.getElementById('extName').textContent = manifest.name || 'Video Downloader';

  // Server status
  fetch(SERVER_URL + '/health')
    .then(r => r.json())
    .then(data => {
      document.getElementById('serverStatus').innerHTML =
        '<span class="status-dot online"></span> Online';
      // Load download dir from server
      loadDownloadDir();
      loadServerInfo();
    })
    .catch(() => {
      document.getElementById('serverStatus').innerHTML =
        '<span class="status-dot offline"></span> Offline';
      document.getElementById('downloadPath').value = 'Server not running';
      document.getElementById('downloadPath').style.color = '#757575';
      document.getElementById('ffmpegStatus').textContent = '—';
    });
}

function loadServerInfo() {
  fetch(SERVER_URL + '/server-info')
    .then(r => r.json())
    .then(data => {
      document.getElementById('ffmpegStatus').innerHTML =
        '<span class="status-dot online"></span> Installed';
      if (data.downloadDir) {
        document.getElementById('downloadPath').value = data.downloadDir;
        document.getElementById('downloadPath').style.color = '';
      }
    })
    .catch(() => {
      document.getElementById('ffmpegStatus').textContent = '—';
    });
}

function loadDownloadDir() {
  fetch(SERVER_URL + '/download-dir')
    .then(r => r.json())
    .then(data => {
      if (data.dir) {
        document.getElementById('downloadPath').value = data.dir;
        document.getElementById('downloadPath').style.color = '';
      }
    })
    .catch(() => {});
}

// === LOAD SETTINGS FROM STORAGE ===
function loadSettings() {
  chrome.storage.local.get(SETTING_KEYS, (result) => {
    // Selects
    document.getElementById('prefQuality').value = result.prefQuality || DEFAULTS.prefQuality;
    document.getElementById('prefAudio').value = result.prefAudio || DEFAULTS.prefAudio;
    document.getElementById('prefSubtitle').value = result.prefSubtitle || DEFAULTS.prefSubtitle;
    document.getElementById('filenameFormat').value = result.filenameFormat || DEFAULTS.filenameFormat;

    // Toggles
    document.getElementById('historyEnabled').checked =
      result.historyEnabled !== undefined ? result.historyEnabled : DEFAULTS.historyEnabled;
    document.getElementById('notificationsEnabled').checked =
      result.notificationsEnabled !== undefined ? result.notificationsEnabled : DEFAULTS.notificationsEnabled;
    document.getElementById('autoScanEnabled').checked =
      result.autoScanEnabled !== undefined ? result.autoScanEnabled : DEFAULTS.autoScanEnabled;
    document.getElementById('autoSelectQuality').checked =
      result.autoSelectQuality !== undefined ? result.autoSelectQuality : DEFAULTS.autoSelectQuality;

    // Radio groups
    setRadio('theme', result.theme || DEFAULTS.theme);
    setRadio('panelPosition', result.panelPosition || DEFAULTS.panelPosition);
  });
}

// Helper: set a radio group's value
function setRadio(name, value) {
  const radio = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
  if (radio) radio.checked = true;
}

// === SAVE A SINGLE SETTING ===
function saveSetting(key, value) {
  chrome.storage.local.set({ [key]: value }, () => {
    showToast('✓ Setting saved');
  });
}

// === BIND CONTROLS ===
function bindControls() {
  // Selects — save on change
  ['prefQuality', 'prefAudio', 'prefSubtitle', 'filenameFormat'].forEach(id => {
    document.getElementById(id).addEventListener('change', function() {
      saveSetting(id, this.value);
    });
  });

  // Toggles — save on change
  ['historyEnabled', 'notificationsEnabled', 'autoScanEnabled', 'autoSelectQuality'].forEach(id => {
    document.getElementById(id).addEventListener('change', function() {
      saveSetting(id, this.checked);
    });
  });

  // Radio groups — save on change
  ['theme', 'panelPosition'].forEach(name => {
    document.querySelectorAll('input[name="' + name + '"]').forEach(radio => {
      radio.addEventListener('change', function() {
        saveSetting(name, this.value);
        if (name === 'theme') applyThemeToPage(this.value);
      });
    });
  });

  // Download directory — change
  document.getElementById('changeDirBtn').addEventListener('click', () => {
    const currentPath = document.getElementById('downloadPath').value;
    const newPath = prompt('Enter new download directory path:', currentPath);
    if (newPath && newPath.trim() && newPath.trim() !== currentPath) {
      fetch(SERVER_URL + '/download-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: newPath.trim() })
      })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            document.getElementById('downloadPath').value = data.dir;
            showToast('✓ Download directory updated');
          } else {
            showToast('✗ ' + (data.error || 'Failed to change directory'), true);
          }
        })
        .catch(() => {
          showToast('✗ Server not reachable', true);
        });
    }
  });

  // Open download folder
  document.getElementById('openDirBtn').addEventListener('click', () => {
    fetch(SERVER_URL + '/open-folder').catch(() => {
      showToast('✗ Server not reachable', true);
    });
  });

  // Reset all
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('Reset all settings to defaults?')) {
      chrome.storage.local.set(DEFAULTS, () => {
        loadSettings();
        // Reset server download dir too
        fetch(SERVER_URL + '/download-dir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: '' }) // empty = reset to default
        })
          .then(r => r.json())
          .then(data => {
            if (data.dir) document.getElementById('downloadPath').value = data.dir;
          })
          .catch(() => {});
        showToast('✓ Settings reset to defaults');
      });
    }
  });
}

// === THEME ===
function applyThemeToPage(theme) {
  const isLight = theme === 'light' ||
    (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.body.classList.toggle('theme-light', isLight);
}

// === INIT ===
document.addEventListener('DOMContentLoaded', () => {
  // Apply saved theme
  chrome.storage.local.get('theme', (r) => {
    applyThemeToPage(r.theme || DEFAULTS.theme);
  });
  loadAbout();
  loadSettings();
  bindControls();

  // Listen for OS theme changes if user selected 'system'
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      chrome.storage.local.get('theme', (r) => {
        if ((r.theme || DEFAULTS.theme) === 'system') {
          applyThemeToPage('system');
        }
      });
    });
  }
});
