// Chrome Relay - Options Script

const portInput = document.getElementById('port');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');

let saveStatusTimer = null;

// --- Load saved settings ---

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(['relayPort']);
    if (stored.relayPort) {
      portInput.value = stored.relayPort;
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

// --- Save settings ---

async function saveSettings() {
  const port = parseInt(portInput.value, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    showStatus('Invalid port number', true);
    return;
  }

  try {
    await chrome.storage.local.set({
      relayPort: port
    });

    showStatus('Settings saved');

    // Notify background to reconnect with new settings
    chrome.runtime.sendMessage({ type: 'reconnect' });
  } catch (e) {
    console.error('Failed to save settings:', e);
    showStatus('Failed to save', true);
  }
}

function showStatus(message, isError) {
  saveStatus.textContent = message;
  saveStatus.style.color = isError ? '#F44336' : '#4CAF50';
  saveStatus.classList.add('visible');

  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer);
  }

  saveStatusTimer = setTimeout(() => {
    saveStatus.classList.remove('visible');
  }, 3000);
}

// --- Event listeners ---

saveBtn.addEventListener('click', saveSettings);

// Save on Enter key in either field
portInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSettings();
});

// --- Init ---

loadSettings();
