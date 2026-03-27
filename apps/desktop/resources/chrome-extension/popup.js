// Chrome Relay - Popup Script

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const serverAddr = document.getElementById('serverAddr');
const tabList = document.getElementById('tabList');
const attachBtn = document.getElementById('attachBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const optionsLink = document.getElementById('optionsLink');

// --- Status Display ---

function updateUI(state) {
  // Status dot
  statusDot.className = 'status-dot ' + state.connectionState;

  // Status text
  const labels = {
    connected: 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected'
  };
  statusText.textContent = labels[state.connectionState] || 'Unknown';
  statusText.className = 'status-text ' + state.connectionState;

  // Server address
  serverAddr.textContent = '127.0.0.1:' + (state.port || 23001);

  // Attached tabs
  renderTabList(state.attachedTabs || []);
}

async function renderTabList(attachedTabIds) {
  tabList.innerHTML = '';

  if (attachedTabIds.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = 'No tabs attached';
    tabList.appendChild(li);
    return;
  }

  // Get tab details
  for (const tabId of attachedTabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const li = document.createElement('li');
      li.className = 'tab-item';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-title';
      titleSpan.textContent = tab.title || tab.url || 'Untitled';
      titleSpan.title = tab.url || '';

      const idSpan = document.createElement('span');
      idSpan.className = 'tab-id';
      idSpan.textContent = '#' + tabId;

      const detachBtn = document.createElement('button');
      detachBtn.className = 'btn btn-sm btn-danger';
      detachBtn.textContent = 'Detach';
      detachBtn.addEventListener('click', () => detachTab(tabId));

      li.appendChild(titleSpan);
      li.appendChild(idSpan);
      li.appendChild(detachBtn);
      tabList.appendChild(li);
    } catch (e) {
      // Tab might have been closed
      console.warn('Tab not found:', tabId);
    }
  }
}

// --- Actions ---

function detachTab(tabId) {
  chrome.runtime.sendMessage({ type: 'detachTab', tabId }, (response) => {
    if (response && response.ok) {
      refreshStatus();
    } else {
      console.error('Failed to detach:', response?.error);
    }
  });
}

attachBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.runtime.sendMessage({ type: 'attachTab', tabId: tab.id }, (response) => {
      if (response && response.ok) {
        refreshStatus();
      } else {
        console.error('Failed to attach:', response?.error);
      }
    });
  } catch (e) {
    console.error('Error attaching tab:', e);
  }
});

reconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
    // Wait a moment then refresh status
    setTimeout(refreshStatus, 1000);
  });
});

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// --- Refresh ---

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
    if (response) {
      updateUI(response);
    }
  });
}

// Initial load
refreshStatus();

// Auto-refresh every 2 seconds while popup is open
setInterval(refreshStatus, 2000);
