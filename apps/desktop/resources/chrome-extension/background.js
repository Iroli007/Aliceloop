// Chrome Relay - Background Service Worker
// Connects Chrome to the Aliceloop relay via WebSocket.

let ws = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const KEEPALIVE_INTERVAL_NAME = 'chrome-relay-keepalive';
const KEEPALIVE_PERIOD_MINUTES = 25 / 60; // 25 seconds in minutes (chrome.alarms minimum is fine with fractional)
const PING_INTERVAL_MS = 20000;

let connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let attachedTabs = new Set();
let config = { port: 23001, token: '' };
let pingTimer = null;
let lastPongTime = 0;

// --- Initialization ---

async function init() {
    await loadConfig();
    connect();
    setupAlarms();
    setupTabListeners();
    setupDebuggerListeners();
}

async function loadConfig() {
    // First try chrome.storage.local
    try {
        const stored = await chrome.storage.local.get(['relayPort', 'authToken']);
        if (stored.relayPort) config.port = stored.relayPort;
        if (stored.authToken) config.token = stored.authToken;
    } catch (e) {
        console.warn('[Chrome Relay] Failed to load config from storage:', e);
    }

    // Also try auto-config from the local relay server
    try {
        const response = await fetch(`http://127.0.0.1:${config.port}/api/browser-relay/config`);
        if (response.ok) {
            const autoConfig = await response.json();
            if (autoConfig.port) config.port = autoConfig.port;
            if (autoConfig.token) config.token = autoConfig.token;
            // Persist auto-config
            await chrome.storage.local.set({
                relayPort: config.port,
                authToken: config.token,
            });
        }
    } catch (e) {
        // Auto-config not available, use stored values
    }
}

// --- Badge Management ---

function updateBadge() {
    switch (connectionState) {
        case 'connected':
            chrome.action.setBadgeText({ text: 'ON' });
            chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
            break;
        case 'connecting':
            chrome.action.setBadgeText({ text: '...' });
            chrome.action.setBadgeBackgroundColor({ color: '#FFC107' });
            break;
        case 'disconnected':
            chrome.action.setBadgeText({ text: 'OFF' });
            chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
            break;
    }
}

// --- WebSocket Connection ---

// silent=true: background reconnect, don't flicker badge to "..."
function connect(silent = false) {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    connectionState = 'connecting';
    if (!silent) {
        updateBadge();
    }

    const url = `ws://127.0.0.1:${config.port}/ws/browser-relay?token=${encodeURIComponent(config.token)}`;

    try {
        ws = new WebSocket(url);
    } catch (e) {
        console.error('[Chrome Relay] Failed to create WebSocket:', e);
        connectionState = 'disconnected';
        if (!silent) {
            updateBadge();
        }
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        console.log('[Chrome Relay] Connected to relay server');
        connectionState = 'connected';
        reconnectDelay = 1000;
        updateBadge();
        sendStatus();
        startPingTimer();
    };

    ws.onmessage = event => {
        handleMessage(event.data);
    };

    ws.onclose = event => {
        const wasConnected = connectionState === 'connected';
        console.log('[Chrome Relay] WebSocket closed:', event.code, event.reason);
        connectionState = 'disconnected';
        ws = null;
        // Only update badge if we were previously connected (lost connection)
        // or if this was a non-silent attempt. Avoid flicker during background retries.
        if (wasConnected || !silent) {
            updateBadge();
        }
        stopPingTimer();
        scheduleReconnect();
    };

    ws.onerror = error => {
        console.error('[Chrome Relay] WebSocket error:', error);
    };
}

function disconnect() {
    if (ws) {
        ws.close(1000, 'Manual disconnect');
        ws = null;
    }
    connectionState = 'disconnected';
    updateBadge();
    stopPingTimer();
}

function scheduleReconnect() {
    setTimeout(() => {
        if (connectionState === 'disconnected') {
            // Silent reconnect: don't flicker the badge
            connect(true);
        }
    }, reconnectDelay);

    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

// --- Ping / Pong ---

function startPingTimer() {
    stopPingTimer();
    lastPongTime = Date.now();
    pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            // Check if we missed too many pongs (60s timeout)
            if (Date.now() - lastPongTime > 60000) {
                console.warn('[Chrome Relay] Pong timeout, reconnecting...');
                ws.close();
                return;
            }
            send({ type: 'ping' });
        }
    }, PING_INTERVAL_MS);
}

function stopPingTimer() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
}

// --- Keep-Alive via Alarms ---

function setupAlarms() {
    chrome.alarms.create(KEEPALIVE_INTERVAL_NAME, {
        periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
    });

    chrome.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === KEEPALIVE_INTERVAL_NAME) {
            // This fires periodically to keep the service worker alive
            if (connectionState === 'disconnected') {
                // Silent reconnect from alarm: don't flicker badge
                connect(true);
            } else if (ws && ws.readyState === WebSocket.OPEN) {
                send({ type: 'ping' });
            }
        }
    });
}

// --- Tab Listeners ---

function setupTabListeners() {
    chrome.tabs.onRemoved.addListener(tabId => {
        if (attachedTabs.has(tabId)) {
            attachedTabs.delete(tabId);
            sendStatus();
        }
    });
}

// --- Debugger Listeners ---

function setupDebuggerListeners() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
        if (source.tabId && attachedTabs.has(source.tabId)) {
            // Auto-dismiss "Leave site?" and other JS dialogs (beforeunload, alert, confirm)
            if (method === 'Page.javascriptDialogOpening') {
                console.log(`[Chrome Relay] Auto-dismissing dialog on tab ${source.tabId}: ${params?.type} "${(params?.message || '').substring(0, 60)}"`);
                chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
            }
            send({
                type: 'cdp_event',
                tabId: source.tabId,
                method: method,
                params: params || {},
            });
        }
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
        if (source.tabId) {
            attachedTabs.delete(source.tabId);
            sendStatus();
            console.log(`[Chrome Relay] Debugger detached from tab ${source.tabId}: ${reason}`);
        }
    });
}

// --- Status ---

function sendStatus() {
    send({
        type: 'status',
        attachedTabs: Array.from(attachedTabs),
    });
}

// --- Message Handler ---

async function handleMessage(raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch (e) {
        console.error('[Chrome Relay] Invalid JSON:', raw);
        return;
    }

    // Handle ping/pong
    if (msg.type === 'ping') {
        send({ type: 'pong' });
        return;
    }
    if (msg.type === 'pong') {
        lastPongTime = Date.now();
        return;
    }

    if (msg.type === 'config') {
        const nextPort = Number(msg.port);
        const nextToken = typeof msg.token === 'string' ? msg.token.trim() : '';
        if (!Number.isFinite(nextPort) || nextPort <= 0 || !nextToken) {
            return;
        }

        const changed = nextPort !== config.port || nextToken !== config.token;
        config.port = nextPort;
        config.token = nextToken;
        chrome.storage.local.set({
            relayPort: config.port,
            authToken: config.token,
        }).catch(() => {});

        if (changed && ws && ws.readyState === WebSocket.OPEN) {
            disconnect();
        }
        return;
    }

    // Handle command requests
    if (msg.id && msg.method) {
        try {
            const result = await executeCommand(msg.method, msg.params || {});
            send({ id: msg.id, result });
        } catch (e) {
            send({ id: msg.id, error: e.message || String(e) });
        }
    }
}

// --- Command Execution ---

async function executeCommand(method, params) {
    switch (method) {
        case 'tabs.list':
            return handleTabsList();

        case 'tabs.create':
            return handleTabsCreate(params);

        case 'tabs.navigate':
            return handleTabsNavigate(params);

        case 'tabs.screenshot':
            return handleTabsScreenshot(params);

        case 'debugger.attach':
            return handleDebuggerAttach(params);

        case 'debugger.detach':
            return handleDebuggerDetach(params);

        case 'cdp.send':
            return handleCdpSend(params);

        default:
            throw new Error(`Unknown method: ${method}`);
    }
}

async function handleTabsList() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(tab => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned,
        audible: tab.audible,
        status: tab.status,
        attached: attachedTabs.has(tab.id),
    }));
}

async function handleTabsCreate(params) {
    const tab = await chrome.tabs.create({
        url: params.url || 'about:blank',
        active: params.active !== false,
    });
    return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        windowId: tab.windowId,
    };
}

async function handleTabsNavigate(params) {
    if (!params.tabId) throw new Error('tabId is required');
    if (!params.url) throw new Error('url is required');

    const tab = await chrome.tabs.update(params.tabId, { url: params.url });
    return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
    };
}

async function handleTabsScreenshot(params) {
    const windowId = params.windowId || undefined;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: params.format || 'png',
        quality: params.quality || 80,
    });
    return { dataUrl };
}

async function handleDebuggerAttach(params) {
    if (!params.tabId) throw new Error('tabId is required');

    if (attachedTabs.has(params.tabId)) {
        return { alreadyAttached: true };
    }

    await chrome.debugger.attach({ tabId: params.tabId }, params.version || '1.3');
    attachedTabs.add(params.tabId);
    sendStatus();
    return { attached: true };
}

async function handleDebuggerDetach(params) {
    if (!params.tabId) throw new Error('tabId is required');

    if (!attachedTabs.has(params.tabId)) {
        return { alreadyDetached: true };
    }

    await chrome.debugger.detach({ tabId: params.tabId });
    attachedTabs.delete(params.tabId);
    sendStatus();
    return { detached: true };
}

async function handleCdpSend(params) {
    if (!params.tabId) throw new Error('tabId is required');
    if (!params.method) throw new Error('method is required');

    // Auto-attach if not already attached
    if (!attachedTabs.has(params.tabId)) {
        await chrome.debugger.attach({ tabId: params.tabId }, '1.3');
        attachedTabs.add(params.tabId);
        // Auto-dismiss "Leave site?" and other JS dialogs
        try {
            await chrome.debugger.sendCommand({ tabId: params.tabId }, 'Page.enable', {});
        } catch (e) {
            /* ignore */
        }
        sendStatus();
    }

    const result = await chrome.debugger.sendCommand({ tabId: params.tabId }, params.method, params.params || {});
    return result || {};
}

// --- Listen for config changes ---

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        let configChanged = false;
        if (changes.relayPort) {
            config.port = changes.relayPort.newValue;
            configChanged = true;
        }
        if (changes.authToken) {
            config.token = changes.authToken.newValue;
            configChanged = true;
        }
        if (configChanged) {
            // Reconnect with new config
            disconnect();
            connect();
        }
    }
});

// --- Message passing for popup/options ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'getStatus') {
        sendResponse({
            connectionState,
            attachedTabs: Array.from(attachedTabs),
            port: config.port,
        });
        return true;
    }

    if (message.type === 'reconnect') {
        disconnect();
        // Explicit reconnect from user: show "..." badge
        loadConfig().then(() => connect(false));
        sendResponse({ ok: true });
        return true;
    }

    if (message.type === 'attachTab') {
        handleDebuggerAttach({ tabId: message.tabId })
            .then(result => sendResponse({ ok: true, result }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    if (message.type === 'detachTab') {
        handleDebuggerDetach({ tabId: message.tabId })
            .then(result => sendResponse({ ok: true, result }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    return false;
});

// --- Start ---

init();
