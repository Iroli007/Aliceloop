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
let config = { port: 23001 };
let pingTimer = null;
let lastPongTime = 0;

// --- Initialization ---

async function init() {
    await connectWhenReady();
    setupAlarms();
    setupTabListeners();
    setupDebuggerListeners();
}

async function loadConfig() {
    // First try chrome.storage.local
    try {
        const stored = await chrome.storage.local.get(['relayPort']);
        if (stored.relayPort) config.port = stored.relayPort;
    } catch (e) {
        console.warn('[Chrome Relay] Failed to load config from storage:', e);
    }

    // Also try auto-config from the local relay server
    try {
        const response = await fetch(`http://127.0.0.1:${config.port}/api/browser-relay/config`);
        if (response.ok) {
            const autoConfig = await response.json();
            if (autoConfig.port) config.port = autoConfig.port;
            // Persist auto-config
            await chrome.storage.local.set({
                relayPort: config.port,
            });
            return true;
        }
    } catch (e) {
        // Auto-config not available, use stored values
    }

    return false;
}

async function connectWhenReady(silent = false) {
    const ready = await loadConfig();
    if (!ready) {
        connectionState = 'disconnected';
        if (!silent) {
            updateBadge();
        }
        scheduleReconnect();
        return;
    }

    connect(silent);
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

    const url = `ws://127.0.0.1:${config.port}/ws/browser-relay`;

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
            void connectWhenReady(true);
        }
    }, reconnectDelay);

    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

async function waitForTabComplete(tabId, timeoutMs = 10000) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.status === 'complete') {
            return;
        }
    } catch (e) {
        // Fall through to the listener-based wait.
    }

    await new Promise(resolve => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.onRemoved.removeListener(onRemoved);
        };

        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                cleanup();
                resolve();
            }
        };

        const onRemoved = removedTabId => {
            if (removedTabId === tabId) {
                cleanup();
                resolve();
            }
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.onRemoved.addListener(onRemoved);
    });
}

async function ensureDebuggerAttached(tabId) {
    if (attachedTabs.has(tabId)) {
        return false;
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
    try {
        await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    } catch (e) {
        // Best-effort.
    }
    sendStatus();
    return true;
}

async function runPageFunction(tabId, fn, args = []) {
    const wasAttached = await ensureDebuggerAttached(tabId);
    try {
        const response = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`,
            awaitPromise: true,
            returnByValue: true,
            includeCommandLineAPI: true,
        });

        if (response && response.exceptionDetails) {
            throw new Error(response.exceptionDetails.text || 'Page evaluation failed');
        }

        return response?.result?.value ?? null;
    } finally {
        if (wasAttached === false) {
            // Keep the debugger attached only for tabs already in relay use.
            // Temporary attachments are released by screenshot handling when needed.
        }
    }
}

function compactText(value, limit) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function collectSnapshotScript(options) {
    const input = options || {};
    const maxTextLength = typeof input.maxTextLength === 'number' ? input.maxTextLength : 4000;
    const maxElements = typeof input.maxElements === 'number' ? input.maxElements : 30;
    const counterKey = '__ALICELOOP_BROWSER_REF_COUNTER__';
    const scope = globalThis;
    let nextRef = Number.isFinite(scope[counterKey]) ? Number(scope[counterKey]) : 1;

    function compact(value, limit) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    }

    function getFrameElementForWindow(view) {
        try {
            return view && view.frameElement instanceof Element ? view.frameElement : null;
        } catch {
            return null;
        }
    }

    function isVisible(element) {
        let currentElement = element;
        while (currentElement) {
            const view = currentElement.ownerDocument?.defaultView || window;
            const style = view.getComputedStyle(currentElement);
            const rect = currentElement.getBoundingClientRect();
            if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0) {
                return false;
            }

            const frameElement = getFrameElementForWindow(view);
            if (!frameElement) {
                return true;
            }

            currentElement = frameElement;
        }

        return true;
    }

    function collectAccessibleRoots() {
        const roots = [];
        const seenRoots = new Set();
        const seenDocuments = new Set();

        function visit(root) {
            if (!root || seenRoots.has(root)) {
                return;
            }

            seenRoots.add(root);
            roots.push(root);

            const descendants = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
            for (const element of descendants) {
                if (element.shadowRoot) {
                    visit(element.shadowRoot);
                }

                if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') {
                    try {
                        const nestedDocument = element.contentDocument;
                        if (nestedDocument && !seenDocuments.has(nestedDocument)) {
                            seenDocuments.add(nestedDocument);
                            visit(nestedDocument);
                        }
                    } catch {
                        // Cross-origin frame; ignore it.
                    }
                }
            }
        }

        seenDocuments.add(document);
        visit(document);
        return roots;
    }

    function queryAllAcrossRoots(selector) {
        const results = [];
        const seenElements = new Set();
        for (const root of collectAccessibleRoots()) {
            let matches = [];
            try {
                matches = Array.from(root.querySelectorAll(selector));
            } catch {
                matches = [];
            }

            for (const element of matches) {
                if (seenElements.has(element)) {
                    continue;
                }

                seenElements.add(element);
                results.push(element);
            }
        }

        return results;
    }

    function ensureRef(element) {
        const existing = element.getAttribute('data-aliceloop-ref');
        if (existing) {
            return existing;
        }

        const next = `e${nextRef}`;
        nextRef += 1;
        element.setAttribute('data-aliceloop-ref', next);
        return next;
    }

    const interactiveSelector = [
        'a[href]',
        'button',
        'input',
        'textarea',
        'select',
        'summary',
        "[role='button']",
        "[role='link']",
        "[contenteditable='true']",
        'video',
        'audio',
        'img',
        'canvas',
        'svg',
        "[role='img']",
    ].join(',');

    const roots = collectAccessibleRoots();

    const headings = queryAllAcrossRoots('h1,h2,h3')
        .filter(isVisible)
        .slice(0, 12)
        .map(element => ({
            level: element.tagName.toLowerCase(),
            text: compact(element.textContent, 160),
        }))
        .filter(entry => entry.text.length > 0);

    const elements = queryAllAcrossRoots(interactiveSelector)
        .filter(isVisible)
        .slice(0, maxElements)
        .map(element => {
            const htmlElement = element;
            const ref = ensureRef(element);
            const text = compact(
                htmlElement.innerText || htmlElement.textContent || htmlElement.getAttribute('aria-label'),
                160,
            );
            const href = element.tagName === 'A' ? element.href : compact(element.getAttribute('href'), 240);
            const rawValue = Array.isArray(htmlElement.value)
                ? htmlElement.value.join(', ')
                : (typeof htmlElement.value === 'string' ? htmlElement.value : String(htmlElement.value ?? ''));

            return {
                ref,
                tag: element.tagName.toLowerCase(),
                role: compact(element.getAttribute('role'), 40),
                text,
                type: compact(htmlElement.type, 40),
                name: compact(htmlElement.name, 60),
                placeholder: compact(htmlElement.placeholder, 80),
                href,
                value: compact(rawValue, 120),
                disabled: Boolean(htmlElement.disabled) || element.getAttribute('aria-disabled') === 'true',
            };
        });

    scope[counterKey] = nextRef;

    return {
        url: window.location.href,
        title: compact(document.title, 200),
        headings,
        elements,
        pageText: compact(roots.map(root => {
            if (root.nodeType === Node.DOCUMENT_NODE) {
                return root.body ? root.body.innerText : '';
            }

            return root.textContent || '';
        }).join('\n'), maxTextLength),
    };
}

function readableScript(options) {
    const input = options || {};
    const maxTextLength = typeof input.maxTextLength === 'number' ? input.maxTextLength : 4000;
    const extractMain = input.extractMain !== false;

    function compact(value, limit) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    }

    function getMetaContent(selector) {
        const element = document.querySelector(selector);
        const content = element?.getAttribute('content');
        return content ? compact(content, 120) : null;
    }

    const publishedAt =
        getMetaContent('meta[property="article:published_time"]') ||
        getMetaContent('meta[name="pubdate"]') ||
        getMetaContent('meta[name="publishdate"]') ||
        document.querySelector('time[datetime]')?.getAttribute('datetime') ||
        null;

    const modifiedAt =
        getMetaContent('meta[property="article:modified_time"]') ||
        getMetaContent('meta[name="lastmod"]') ||
        null;

    const root = extractMain
        ? document.querySelector('main, article') || document.body
        : document.body;

    return {
        url: window.location.href,
        title: compact(document.title, 200),
        publishedAt: publishedAt ? compact(publishedAt, 120) : null,
        modifiedAt: modifiedAt ? compact(modifiedAt, 120) : null,
        pageText: compact(root ? root.innerText : document.body?.innerText ?? '', maxTextLength),
    };
}

function searchResultsScript(maxResults) {
    function compact(value, limit) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    }

    function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }

    function extractDomain(url) {
        try {
            return new URL(url, window.location.href).hostname.toLowerCase();
        } catch {
            return '';
        }
    }

    const results = [];
    const seen = new Set();

    function pushResult(title, url, snippet) {
        const normalizedTitle = compact(title, 180);
        const normalizedUrl = compact(url, 400);
        if (!normalizedTitle || !normalizedUrl || seen.has(normalizedUrl)) {
            return;
        }

        seen.add(normalizedUrl);
        results.push({
            title: normalizedTitle,
            url: normalizedUrl,
            snippet: compact(snippet, 280),
            domain: extractDomain(normalizedUrl),
        });
    }

    const structuredNodes = Array.from(document.querySelectorAll('.result, [data-testid=\'result\'], article'))
        .filter(isVisible);

    for (const node of structuredNodes) {
        if (results.length >= maxResults) {
            break;
        }

        const link = node.querySelector('a.result__a, h2 a, h3 a, a[href]');
        if (!link || !isVisible(link)) {
            continue;
        }

        const snippetNode =
            node.querySelector('.result__snippet, .snippet, [class*="snippet"], p') ||
            node.querySelector('div');

        pushResult(
            link.textContent || link.getAttribute('aria-label') || '',
            link.href || link.getAttribute('href') || '',
            snippetNode?.textContent || '',
        );
    }

    if (results.length < maxResults) {
        const genericLinks = Array.from(document.querySelectorAll('main a[href], article a[href], body a[href]'))
            .filter(link => isVisible(link));

        for (const link of genericLinks) {
            if (results.length >= maxResults) {
                break;
            }

            const text = compact(link.textContent || link.getAttribute('aria-label') || '', 180);
            const href = link.href || link.getAttribute('href') || '';
            if (text.length < 4) {
                continue;
            }

            pushResult(text, href, link.closest('article, section, div')?.textContent || '');
        }
    }

    return {
        url: window.location.href,
        results: results.slice(0, maxResults),
    };
}

function mediaProbeScript(options) {
    const requestedRef = options?.ref ?? null;

    function compact(value, limit) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    }

    function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }

    function ensureRef(element) {
        const counterKey = '__ALICELOOP_BROWSER_REF_COUNTER__';
        const scope = globalThis;
        let nextRef = Number.isFinite(scope[counterKey]) ? Number(scope[counterKey]) : 1;
        const existing = element.getAttribute('data-aliceloop-ref');
        if (existing) {
            return existing;
        }

        const next = `e${nextRef}`;
        nextRef += 1;
        scope[counterKey] = nextRef;
        element.setAttribute('data-aliceloop-ref', next);
        return next;
    }

    function uniqueTexts(values) {
        const normalized = values
            .map(value => compact(value, 200))
            .filter(value => value.length > 0);
        return Array.from(new Set(normalized)).slice(0, 8);
    }

    function collectTrackCaptions(media) {
        const captions = [];
        const tracks = Array.from(media.textTracks ?? []);
        for (const track of tracks) {
            const cues = Array.from(track.activeCues ?? []);
            for (const cue of cues) {
                const text = 'text' in cue ? String(cue.text ?? '') : '';
                if (text.trim()) {
                    captions.push(text);
                }
            }
        }

        return uniqueTexts(captions);
    }

    function collectDomCaptions() {
        const selectors = [
            "[class*='caption']",
            "[class*='Caption']",
            "[class*='subtitle']",
            "[class*='Subtitle']",
            "[class*='captions']",
            "[class*='subtitles']",
            "[data-testid*='caption']",
            "[data-testid*='subtitle']",
            "[aria-live='polite']",
            "[aria-live='assertive']",
        ];

        const texts = [];
        for (const node of Array.from(document.querySelectorAll(selectors.join(',')))) {
            if (!isVisible(node)) {
                continue;
            }

            const text = compact(node.textContent, 200);
            if (text.length >= 2) {
                texts.push(text);
            }
        }

        return uniqueTexts(texts);
    }

    const mediaElements = Array.from(document.querySelectorAll('video, audio'))
        .filter(isVisible)
        .map(element => {
            const media = element;
            const rect = media.getBoundingClientRect();
            const activeCaptions = collectTrackCaptions(media);
            return {
                element: media,
                ref: ensureRef(media),
                tag: media.tagName.toLowerCase(),
                label: compact(
                    media.getAttribute('aria-label')
                        || media.getAttribute('title')
                        || media.closest('[aria-label],[title]')?.getAttribute('aria-label')
                        || media.closest('[aria-label],[title]')?.getAttribute('title')
                        || media.currentSrc
                        || media.src,
                    160,
                ),
                area: Math.max(0, rect.width) * Math.max(0, rect.height),
                paused: media.paused,
                muted: media.muted || media.volume === 0,
                currentTime: Number.isFinite(media.currentTime) ? Number(media.currentTime) : null,
                duration: Number.isFinite(media.duration) ? Number(media.duration) : null,
                playbackRate: Number.isFinite(media.playbackRate) ? Number(media.playbackRate) : 1,
                textTrackCount: media.textTracks?.length ?? 0,
                activeCaptions,
                canCaptureAudio: typeof media.captureStream === 'function',
            };
        })
        .sort((left, right) => right.area - left.area);

    const requestedElement = requestedRef
        ? document.querySelector('[data-aliceloop-ref="' + String(requestedRef).replace(/"/g, '\\"') + '"]')
        : null;
    const requestedCandidate = requestedElement
        ? mediaElements.find(candidate => candidate.element === requestedElement)
        : null;
    const primaryCandidate = requestedCandidate ?? mediaElements[0] ?? null;
    const domCaptions = collectDomCaptions();
    const subtitles = primaryCandidate?.activeCaptions?.length
        ? primaryCandidate.activeCaptions
        : domCaptions;

    return {
        url: window.location.href,
        title: compact(document.title, 200),
        playerRef: primaryCandidate?.ref ?? null,
        subtitleSource: primaryCandidate?.activeCaptions?.length ? 'textTracks' : (domCaptions.length ? 'dom' : 'none'),
        subtitles,
        candidates: mediaElements.map(candidate => ({
            ref: candidate.ref,
            tag: candidate.tag,
            label: candidate.label,
            area: candidate.area,
            paused: candidate.paused,
            muted: candidate.muted,
            currentTime: candidate.currentTime,
            duration: candidate.duration,
            playbackRate: candidate.playbackRate,
            textTrackCount: candidate.textTrackCount,
            activeCaptions: candidate.activeCaptions,
            canCaptureAudio: candidate.canCaptureAudio,
        })),
    };
}

function captureAudioClipScript(options) {
    const requestedRef = options?.ref ?? null;
    const clipMs = Math.max(2000, Math.min(12000, options?.clipMs ?? 10000));

    function compact(value, limit) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    }

    function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }

    function ensureRef(element) {
        const counterKey = '__ALICELOOP_BROWSER_REF_COUNTER__';
        const scope = globalThis;
        let nextRef = Number.isFinite(scope[counterKey]) ? Number(scope[counterKey]) : 1;
        const existing = element.getAttribute('data-aliceloop-ref');
        if (existing) {
            return existing;
        }

        const next = `e${nextRef}`;
        nextRef += 1;
        scope[counterKey] = nextRef;
        element.setAttribute('data-aliceloop-ref', next);
        return next;
    }

    function findTargetMediaElement() {
        if (requestedRef) {
            const exact = document.querySelector('[data-aliceloop-ref="' + String(requestedRef).replace(/"/g, '\\"') + '"]');
            if (exact instanceof HTMLMediaElement) {
                return exact;
            }
        }

        return Array.from(document.querySelectorAll('video, audio'))
            .filter(element => element instanceof HTMLMediaElement)
            .filter(isVisible)
            .sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
            })[0] ?? null;
    }

    function toBase64(data) {
        let output = '';
        const chunkSize = 0x8000;
        for (let index = 0; index < data.length; index += chunkSize) {
            output += String.fromCharCode(...data.subarray(index, index + chunkSize));
        }

        return btoa(output);
    }

    const target = findTargetMediaElement();
    if (!target) {
        return {
            ok: false,
            ref: null,
            mediaType: null,
            currentTime: null,
            limitation: 'No visible media element is available on the current page.',
            url: window.location.href,
        };
    }

    const ref = ensureRef(target);
    if (typeof target.captureStream !== 'function') {
        return {
            ok: false,
            ref,
            mediaType: null,
            currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
            limitation: 'This media element does not expose captureStream().',
            url: window.location.href,
        };
    }

    if (target.paused) {
        return {
            ok: false,
            ref,
            mediaType: null,
            currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
            limitation: 'The media element is paused, so there is no live audio to sample.',
            url: window.location.href,
        };
    }

    return (async () => {
        try {
            const capturedStream = target.captureStream();
            const audioTracks = capturedStream.getAudioTracks();
            if (audioTracks.length === 0) {
                return {
                    ok: false,
                    ref,
                    mediaType: null,
                    currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
                    limitation: 'The media stream has no audio tracks.',
                    url: window.location.href,
                };
            }

            const audioStream = new MediaStream(audioTracks);
            const preferredMimeTypes = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/ogg;codecs=opus',
            ];
            const mimeType = preferredMimeTypes.find(value => MediaRecorder.isTypeSupported(value)) ?? '';
            const recorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);
            const chunks = [];

            recorder.addEventListener('dataavailable', event => {
                if (event.data && event.data.size > 0) {
                    chunks.push(event.data);
                }
            });

            await new Promise((resolvePromise, rejectPromise) => {
                recorder.addEventListener('error', () => {
                    rejectPromise(new Error('MediaRecorder failed while capturing tab audio.'));
                });
                recorder.addEventListener('stop', () => {
                    resolvePromise();
                });
                recorder.start();
                setTimeout(() => {
                    if (recorder.state !== 'inactive') {
                        recorder.stop();
                    }
                }, clipMs);
            });

            audioStream.getTracks().forEach(track => track.stop());
            capturedStream.getTracks().forEach(track => track.stop());

            const blob = new Blob(chunks, {
                type: recorder.mimeType || mimeType || 'audio/webm',
            });
            if (blob.size === 0) {
                return {
                    ok: false,
                    ref,
                    mediaType: null,
                    currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
                    limitation: 'The captured audio clip was empty.',
                    url: window.location.href,
                };
            }

            const buffer = new Uint8Array(await blob.arrayBuffer());
            return {
                ok: true,
                ref,
                mediaType: blob.type || recorder.mimeType || mimeType || 'audio/webm',
                currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
                dataBase64: toBase64(buffer),
                url: window.location.href,
            };
        } catch (error) {
            return {
                ok: false,
                ref,
                mediaType: null,
                currentTime: Number.isFinite(target.currentTime) ? Number(target.currentTime) : null,
                limitation: compact(error instanceof Error ? error.message : String(error), 240),
                url: window.location.href,
            };
        }
    })();
}

function clickPageScript(params) {
    const ref = params?.ref ?? '';
    function collectAccessibleRoots() {
        const roots = [];
        const seenRoots = new Set();
        const seenDocuments = new Set();

        function visit(root) {
            if (!root || seenRoots.has(root)) {
                return;
            }

            seenRoots.add(root);
            roots.push(root);

            const descendants = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
            for (const candidate of descendants) {
                if (candidate.shadowRoot) {
                    visit(candidate.shadowRoot);
                }

                if (candidate.tagName === 'IFRAME' || candidate.tagName === 'FRAME') {
                    try {
                        const nestedDocument = candidate.contentDocument;
                        if (nestedDocument && !seenDocuments.has(nestedDocument)) {
                            seenDocuments.add(nestedDocument);
                            visit(nestedDocument);
                        }
                    } catch {
                        // Cross-origin frame; ignore it.
                    }
                }
            }
        }

        seenDocuments.add(document);
        visit(document);
        return roots;
    }

    const selector = `[data-aliceloop-ref="${String(ref).replace(/"/g, '\\"')}"]`;
    const element = collectAccessibleRoots().map(root => {
        try {
            return root.querySelector(selector);
        } catch {
            return null;
        }
    }).find(Boolean);
    if (!element) {
        throw new Error(`No browser element matches ref ${ref}. Run browser_snapshot again to refresh refs.`);
    }

    if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }

    if (typeof element.click === 'function') {
        element.click();
    } else {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    return true;
}

function typePageScript(params) {
    const ref = params?.ref ?? '';
    const text = typeof params?.text === 'string' ? params.text : '';
    const submit = params?.submit === true;
    function collectAccessibleRoots() {
        const roots = [];
        const seenRoots = new Set();
        const seenDocuments = new Set();

        function visit(root) {
            if (!root || seenRoots.has(root)) {
                return;
            }

            seenRoots.add(root);
            roots.push(root);

            const descendants = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
            for (const candidate of descendants) {
                if (candidate.shadowRoot) {
                    visit(candidate.shadowRoot);
                }

                if (candidate.tagName === 'IFRAME' || candidate.tagName === 'FRAME') {
                    try {
                        const nestedDocument = candidate.contentDocument;
                        if (nestedDocument && !seenDocuments.has(nestedDocument)) {
                            seenDocuments.add(nestedDocument);
                            visit(nestedDocument);
                        }
                    } catch {
                        // Cross-origin frame; ignore it.
                    }
                }
            }
        }

        seenDocuments.add(document);
        visit(document);
        return roots;
    }

    const selector = `[data-aliceloop-ref="${String(ref).replace(/"/g, '\\"')}"]`;
    const element = collectAccessibleRoots().map(root => {
        try {
            return root.querySelector(selector);
        } catch {
            return null;
        }
    }).find(Boolean);
    if (!element) {
        throw new Error(`No browser element matches ref ${ref}. Run browser_snapshot again to refresh refs.`);
    }

    if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }

    const htmlElement = element;
    if (htmlElement.isContentEditable) {
        htmlElement.focus();
        htmlElement.textContent = text;
        htmlElement.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        htmlElement.dispatchEvent(new Event('change', { bubbles: true }));
    } else if ('value' in htmlElement) {
        htmlElement.focus();
        htmlElement.value = text;
        htmlElement.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        htmlElement.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        throw new Error(`Element ref ${ref} cannot be typed into.`);
    }

    if (submit) {
        const form = element.closest('form');
        if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit();
        } else {
            element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            element.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true, cancelable: true }));
            element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
        }
    }

    return true;
}

function scrollPageScript(params) {
    const direction = params?.direction || 'down';
    const amount = Math.max(50, Math.min(4000, Math.round(params?.amount ?? 800)));
    const deltas = {
        up: { x: 0, y: -amount },
        down: { x: 0, y: amount },
        left: { x: -amount, y: 0 },
        right: { x: amount, y: 0 },
    };
    const delta = deltas[direction] || deltas.down;
    window.scrollBy(delta.x, delta.y);
    return true;
}

function evalPageScript(expression) {
    return (async () => {
        const resolved = await (0, eval)(expression);
        if (resolved === undefined || resolved === null) {
            return resolved ?? null;
        }

        if (typeof resolved === 'string' || typeof resolved === 'number' || typeof resolved === 'boolean') {
            return resolved;
        }

        if (typeof resolved === 'bigint') {
            return resolved.toString();
        }

        try {
            return JSON.parse(JSON.stringify(resolved));
        } catch {
            return String(resolved);
        }
    })();
}

function backPageScript() {
    history.back();
    return true;
}

function forwardPageScript() {
    history.forward();
    return true;
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
                void connectWhenReady(true);
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
        if (!Number.isFinite(nextPort) || nextPort <= 0) {
            return;
        }

        const changed = nextPort !== config.port;
        config.port = nextPort;
        chrome.storage.local.set({
            relayPort: config.port,
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
    await waitForTabComplete(params.tabId);
    const snapshot = await runPageFunction(params.tabId, collectSnapshotScript, [{
        maxTextLength: params.maxTextLength,
        maxElements: params.maxElements,
    }]);
    return {
        ...snapshot,
        backend: 'desktop_chrome',
        tabId: tab.id,
    };
}

async function handleTabsSnapshot(params) {
    if (!params.tabId) throw new Error('tabId is required');
    const snapshot = await runPageFunction(params.tabId, collectSnapshotScript, [{
        maxTextLength: params.maxTextLength,
        maxElements: params.maxElements,
    }]);
    return {
        ...snapshot,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsClick(params) {
    if (!params.tabId) throw new Error('tabId is required');
    if (!params.ref) throw new Error('ref is required');

    await runPageFunction(params.tabId, clickPageScript, [{ ref: params.ref }]);
    const timeoutMs = params.waitUntil === 'load' || params.waitUntil === 'networkidle' ? 10000 : 1500;
    await waitForTabComplete(params.tabId, timeoutMs);
    const snapshot = await runPageFunction(params.tabId, collectSnapshotScript, [{
        maxTextLength: params.maxTextLength,
        maxElements: params.maxElements,
    }]);
    return {
        ...snapshot,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsType(params) {
    if (!params.tabId) throw new Error('tabId is required');
    if (!params.ref) throw new Error('ref is required');

    await runPageFunction(params.tabId, typePageScript, [{
        ref: params.ref,
        text: params.text || '',
        submit: params.submit === true,
    }]);
    const timeoutMs = params.submit ? 10000 : 1500;
    await waitForTabComplete(params.tabId, timeoutMs);
    const snapshot = await runPageFunction(params.tabId, collectSnapshotScript, [{
        maxTextLength: params.maxTextLength,
        maxElements: params.maxElements,
    }]);
    return {
        ...snapshot,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsScreenshot(params) {
    if (!params.tabId) throw new Error('tabId is required');

    const attachedNow = await ensureDebuggerAttached(params.tabId);
    try {
        const tab = await chrome.tabs.get(params.tabId);
        let clip = undefined;
        if (params.ref) {
            clip = await runPageFunction(params.tabId, function (input) {
                function getFrameElementForWindow(view) {
                    try {
                        return view && view.frameElement instanceof Element ? view.frameElement : null;
                    } catch {
                        return null;
                    }
                }

                function collectAccessibleRoots() {
                    const roots = [];
                    const seenRoots = new Set();
                    const seenDocuments = new Set();

                    function visit(root) {
                        if (!root || seenRoots.has(root)) {
                            return;
                        }

                        seenRoots.add(root);
                        roots.push(root);

                        const descendants = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
                        for (const candidate of descendants) {
                            if (candidate.shadowRoot) {
                                visit(candidate.shadowRoot);
                            }

                            if (candidate.tagName === 'IFRAME' || candidate.tagName === 'FRAME') {
                                try {
                                    const nestedDocument = candidate.contentDocument;
                                    if (nestedDocument && !seenDocuments.has(nestedDocument)) {
                                        seenDocuments.add(nestedDocument);
                                        visit(nestedDocument);
                                    }
                                } catch {
                                    // Cross-origin frame; ignore it.
                                }
                            }
                        }
                    }

                    seenDocuments.add(document);
                    visit(document);
                    return roots;
                }

                function getViewportRect(element) {
                    const rect = element.getBoundingClientRect();
                    let x = rect.x;
                    let y = rect.y;
                    let currentWindow = element.ownerDocument?.defaultView || null;
                    while (currentWindow) {
                        const frameElement = getFrameElementForWindow(currentWindow);
                        if (!frameElement) {
                            break;
                        }

                        const frameRect = frameElement.getBoundingClientRect();
                        x += frameRect.x;
                        y += frameRect.y;
                        currentWindow = frameElement.ownerDocument?.defaultView || null;
                    }

                    return {
                        x: Math.max(0, x),
                        y: Math.max(0, y),
                        width: Math.max(1, rect.width),
                        height: Math.max(1, rect.height),
                    };
                }

                const selector = `[data-aliceloop-ref="${String(input.ref).replace(/"/g, '\\"')}"]`;
                const element = collectAccessibleRoots().map(root => {
                    try {
                        return root.querySelector(selector);
                    } catch {
                        return null;
                    }
                }).find(Boolean);
                if (!element) {
                    return null;
                }
                if (typeof element.scrollIntoView === 'function') {
                    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                }
                return getViewportRect(element);
            }, [{ ref: params.ref }]);
        }

        const result = await chrome.debugger.sendCommand({ tabId: params.tabId }, 'Page.captureScreenshot', {
            format: params.format || 'png',
            fromSurface: true,
            captureBeyondViewport: params.fullPage !== false,
            clip: clip || undefined,
        });

        return {
            dataUrl: `data:image/png;base64,${result.data}`,
            url: tab.url,
            tabId: params.tabId,
        };
    } finally {
        if (attachedNow) {
            await chrome.debugger.detach({ tabId: params.tabId }).catch(() => undefined);
        }
    }
}

async function handleTabsMediaProbe(params) {
    if (!params.tabId) throw new Error('tabId is required');
    const result = await runPageFunction(params.tabId, mediaProbeScript, [{
        ref: params.ref ?? null,
    }]);
    return {
        ...result,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsCaptureAudio(params) {
    if (!params.tabId) throw new Error('tabId is required');
    const result = await runPageFunction(params.tabId, captureAudioClipScript, [{
        ref: params.ref ?? null,
        clipMs: typeof params.clipMs === 'number' ? params.clipMs : undefined,
    }]);
    return {
        ...result,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsReadable(params) {
    if (!params.tabId) throw new Error('tabId is required');
    const result = await runPageFunction(params.tabId, readableScript, [{
        maxTextLength: params.maxTextLength,
        extractMain: params.extractMain,
    }]);
    return {
        ...result,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsSearchResults(params) {
    if (!params.tabId) throw new Error('tabId is required');
    const result = await runPageFunction(params.tabId, searchResultsScript, [Number.isFinite(params.maxResults) ? params.maxResults : 5]);
    return {
        ...result,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsReadDom(params) {
    return handleTabsSnapshot(params);
}

async function handleTabsScroll(params) {
    if (!params.tabId) throw new Error('tabId is required');
    await runPageFunction(params.tabId, scrollPageScript, [{
        direction: params.direction || 'down',
        amount: params.amount,
    }]);
    const snapshot = await runPageFunction(params.tabId, collectSnapshotScript, [{
        maxTextLength: params.maxTextLength,
        maxElements: params.maxElements,
    }]);
    return {
        ...snapshot,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsEval(params) {
    if (!params.tabId) throw new Error('tabId is required');
    if (!params.expression) throw new Error('expression is required');
    const result = await runPageFunction(params.tabId, evalPageScript, [params.expression]);
    const tab = await chrome.tabs.get(params.tabId);
    return {
        url: tab.url,
        backend: 'desktop_chrome',
        tabId: params.tabId,
        result,
    };
}

async function handleTabsBack(params) {
    if (!params.tabId) throw new Error('tabId is required');
    await runPageFunction(params.tabId, backPageScript, []);
    await waitForTabComplete(params.tabId);
    const snapshot = await runPageFunction(params.tabId, collectSnapshotScript, [{
        maxTextLength: params.maxTextLength,
        maxElements: params.maxElements,
    }]);
    return {
        ...snapshot,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsForward(params) {
    if (!params.tabId) throw new Error('tabId is required');
    await runPageFunction(params.tabId, forwardPageScript, []);
    await waitForTabComplete(params.tabId);
    const snapshot = await runPageFunction(params.tabId, collectSnapshotScript, [{
        maxTextLength: params.maxTextLength,
        maxElements: params.maxElements,
    }]);
    return {
        ...snapshot,
        backend: 'desktop_chrome',
        tabId: params.tabId,
    };
}

async function handleTabsClose(params) {
    if (!params.tabId) throw new Error('tabId is required');
    await chrome.tabs.remove(params.tabId);
    return { ok: true, tabId: params.tabId };
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

    if (!attachedTabs.has(params.tabId)) {
        await chrome.debugger.attach({ tabId: params.tabId }, '1.3');
        attachedTabs.add(params.tabId);
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

async function executeCommand(method, params) {
    switch (method) {
        case 'tabs.list':
            return handleTabsList();
        case 'tabs.create':
            return handleTabsCreate(params);
        case 'tabs.navigate':
            return handleTabsNavigate(params);
        case 'tabs.snapshot':
            return handleTabsSnapshot(params);
        case 'tabs.click':
            return handleTabsClick(params);
        case 'tabs.type':
            return handleTabsType(params);
        case 'tabs.screenshot':
            return handleTabsScreenshot(params);
        case 'tabs.mediaProbe':
            return handleTabsMediaProbe(params);
        case 'tabs.captureAudioClip':
            return handleTabsCaptureAudio(params);
        case 'tabs.readable':
            return handleTabsReadable(params);
        case 'tabs.searchResults':
            return handleTabsSearchResults(params);
        case 'tabs.readDom':
            return handleTabsReadDom(params);
        case 'tabs.scroll':
            return handleTabsScroll(params);
        case 'tabs.eval':
            return handleTabsEval(params);
        case 'tabs.back':
            return handleTabsBack(params);
        case 'tabs.forward':
            return handleTabsForward(params);
        case 'tabs.close':
            return handleTabsClose(params);
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

// --- Listen for config changes ---

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        let configChanged = false;
        if (changes.relayPort) {
            config.port = changes.relayPort.newValue;
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
