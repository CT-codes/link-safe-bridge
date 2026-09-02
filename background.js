// Link-Safe → Lesezeichenleiste (Einweg-Spiegel)
//
// Holt alle aktiven Links über die Link-Safe-API (Read-only-Token) und baut
// sie als Ordner "Link-Safe" in der Lesezeichenleiste nach. Der Ordner gehört
// der Extension und wird bei jedem Sync komplett neu erzeugt — eigene
// Lesezeichen außerhalb dieses Ordners werden nie angefasst.

const SYNC_ALARM = 'linksafe-sync';
const MIRROR_TITLE = 'Link-Safe';
const FAVORITES_TITLE = 'Favoriten'; // Hauptordner-Name in der App (CONFIG.FAVORITES_FOLDER)
const BOOKMARKS_BAR_ID = '1'; // Lesezeichenleiste in Chromium

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 15 });
});

chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 15 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
        syncBookmarks().catch((e) => setStatus('Fehler: ' + e.message));
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.action === 'sync-now') {
        syncBookmarks()
            .then(() => sendResponse({ ok: true }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true; // async response
    }

    // Prüfseite holt sich die Liste der zu prüfenden Links. Bewusst über den
    // Hintergrund statt einer zweiten fetchAllLinks-Kopie in check.js — eine
    // Quelle für Paginierung und URL-Normalisierung.
    if (msg?.action === 'fetch-check-targets') {
        fetchCheckTargets()
            .then((targets) => sendResponse({ ok: true, targets }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // Prüfergebnis entgegennehmen und (sofort oder sobald ein App-Tab offen
    // ist) in die Übergabe-Datenbank der App schieben.
    if (msg?.action === 'deliver-results') {
        deliverResults(msg.payload)
            .then((result) => sendResponse({ ok: true, ...result }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }
});

// Wartet ein Ergebnis auf Zustellung, sobald ein Tab der App fertig lädt?
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    chrome.storage.local.get(['pendingResults']).then(({ pendingResults }) => {
        if (pendingResults) flushPendingResults().catch(() => { /* nächster Tab-Load probiert erneut */ });
    });
});

async function setStatus(text, count = null, skipped = null) {
    const status = { lastStatus: text, lastSyncTime: Date.now() };
    if (count !== null) status.lastCount = count;
    if (skipped !== null) status.lastSkipped = skipped;
    await chrome.storage.local.set(status);
}

async function getConfig() {
    const { apiUrl, token } = await chrome.storage.local.get(['apiUrl', 'token']);
    if (!apiUrl || !token) {
        throw new Error('Bitte zuerst API-URL und Token in den Optionen eintragen.');
    }
    return { apiUrl: apiUrl.replace(/\/+$/, ''), token };
}

// Alle aktiven Links laden (paginiert über den Sync-Cursor der API)
async function fetchAllLinks(apiUrl, token) {
    const links = [];
    let since = 0;
    let hasMore = true;
    while (hasMore) {
        const response = await fetch(`${apiUrl}/links?since=${since}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
            throw new Error(`API antwortet mit HTTP ${response.status}`);
        }
        const data = await response.json();
        for (const item of data.items) {
            if (item.updatedAt > since) since = item.updatedAt;
            if (!item.deleted && item.data && !item.data.trashed && item.data.url) {
                links.push(item.data);
            }
        }
        hasMore = data.hasMore;
    }
    return links;
}

// ===============================
// LINK-ROT-PRÜFUNG: Datenquelle und Zustellung an die App
// ===============================

// Die Prüfseite braucht nur Kennung, URL, Titel und Ordner. Favicon und
// og:image sind data-URIs mit 30-80 KB pro Link — die würden die Nachricht
// bei ~4000 Links auf dreistellige Megabyte aufblähen.
async function fetchCheckTargets() {
    const { apiUrl, token } = await getConfig();
    const links = await fetchAllLinks(apiUrl, token);
    return links.map((link) => ({
        id: link.id,
        url: link.url,
        title: link.title || '',
        folder: link.folder || '',
    }));
}

/**
 * Nimmt das Prüfergebnis entgegen und legt es in der App ab.
 *
 * Die Extension schreibt NICHT in die Link-Datenbank der App (LinkDB), sondern
 * in eine eigene Datenbank derselben Origin (LinkSafeCheck). Die App holt es
 * dort ab und schreibt die Marker über ihren eigenen Pfad an die Links — nur
 * so landen sie auch in der Sync-Warteschlange und damit auf dem Zweitgerät.
 *
 * Ist gerade kein App-Tab offen, bleibt das Ergebnis in chrome.storage.local
 * liegen und wird beim nächsten Laden der App zugestellt (tabs.onUpdated).
 */
async function deliverResults(payload) {
    if (!payload || !Array.isArray(payload.auffaellig)) {
        throw new Error('Kein gültiges Prüfergebnis übergeben.');
    }
    await chrome.storage.local.set({ pendingResults: payload });
    return flushPendingResults();
}

async function flushPendingResults() {
    const { pendingResults } = await chrome.storage.local.get(['pendingResults']);
    if (!pendingResults) return { zugestellt: false, grund: 'nichts offen' };

    const { apiUrl } = await chrome.storage.local.get(['apiUrl']);
    if (!apiUrl) return { zugestellt: false, grund: 'keine API-URL konfiguriert' };

    // Die App liegt auf derselben Origin wie ihre API (…/api/index.php)
    const origin = new URL(apiUrl).origin;
    const tabs = await chrome.tabs.query({ url: origin + '/*' });
    if (tabs.length === 0) {
        return { zugestellt: false, grund: 'kein Tab der App offen' };
    }

    for (const tab of tabs) {
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: writeIntoStagingDb,
                args: [pendingResults],
            });
            if (result?.result === true) {
                await chrome.storage.local.remove('pendingResults');
                await chrome.storage.local.set({ lastDelivery: Date.now() });
                return { zugestellt: true };
            }
        } catch (e) {
            // Tab nicht injizierbar (z.B. noch am Laden) — nächsten versuchen
        }
    }
    return { zugestellt: false, grund: 'Übergabe fehlgeschlagen' };
}

// Läuft im Tab der App (isolierte Welt, aber deren Origin) — deshalb muss die
// Funktion vollständig eigenständig sein: keine Closures, keine Importe.
function writeIntoStagingDb(paket) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('LinkSafeCheck', 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('results')) {
                db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('results', 'readwrite');
            tx.objectStore('results').add(paket);
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => { db.close(); reject(tx.error); };
            tx.onabort = () => { db.close(); reject(tx.error); };
        };
        request.onerror = () => reject(request.error);
    });
}

// "A/B/C"-Pfade in einen Baum überführen
function buildTree(links) {
    const root = { folders: new Map(), links: [] };
    for (const link of links) {
        let node = root;
        const path = (link.folder || '').split('/').filter(Boolean);
        for (const segment of path) {
            if (!node.folders.has(segment)) {
                node.folders.set(segment, { folders: new Map(), links: [] });
            }
            node = node.folders.get(segment);
        }
        node.links.push(link);
    }
    return root;
}

// URL wie in der App normalisieren (https:// ergänzen, wenn kein Schema).
// Gibt null zurück, wenn daraus kein gültiges Browser-Lesezeichen werden
// kann — chrome.bookmarks.create wirft sonst "Invalid URL" und der ganze
// Sync bricht ab.
function normalizeUrl(raw) {
    const url = String(raw || '').trim();
    if (!url) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url;
    if (!/^https?:\/\//i.test(withScheme)) return null; // javascript:, file:, …
    try {
        new URL(withScheme);
    } catch (e) {
        return null;
    }
    return withScheme;
}

async function createTree(parentId, node, stats) {
    for (const [name, child] of [...node.folders.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
        const folder = await chrome.bookmarks.create({ parentId, title: name });
        await createTree(folder.id, child, stats);
    }
    for (const link of node.links.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'de'))) {
        const url = normalizeUrl(link.url);
        if (!url) {
            stats.skipped++;
            continue;
        }
        try {
            await chrome.bookmarks.create({
                parentId,
                title: link.title || url,
                url,
            });
            stats.created++;
        } catch (e) {
            // Einzelner problematischer Link darf den Sync nicht abbrechen
            stats.skipped++;
        }
    }
}

async function syncBookmarks() {
    const { apiUrl, token } = await getConfig();
    const { directMode = false, inlineFavorites = false, lastMode = null, mirrorIds = [] } =
        await chrome.storage.local.get(['directMode', 'inlineFavorites', 'lastMode', 'mirrorIds']);

    const links = await fetchAllLinks(apiUrl, token);
    const tree = buildTree(links);
    const stats = { created: 0, skipped: 0 };

    // Direkt-Modus-Knoten vom letzten Sync entfernen. Die IDs stammen sicher
    // von uns — eigene Lesezeichen des Nutzers werden dadurch nie berührt.
    for (const id of mirrorIds) {
        try {
            await chrome.bookmarks.removeTree(String(id));
        } catch (e) {
            // Knoten wurde manuell gelöscht — nichts zu tun
        }
    }

    if (directMode) {
        // Beim Wechsel aus dem Überordner-Modus den alten "Link-Safe"-Ordner
        // abräumen — aber NUR beim Wechsel: Ein später vom Nutzer selbst
        // angelegter Ordner gleichen Namens darf nicht bei jedem Sync sterben.
        if (lastMode !== 'direct') {
            const barChildren = await chrome.bookmarks.getChildren(BOOKMARKS_BAR_ID);
            const oldMirror = barChildren.find((n) => !n.url && n.title === MIRROR_TITLE);
            if (oldMirror) {
                await chrome.bookmarks.removeTree(oldMirror.id);
            }
        }

        // Hauptordner + lose Links direkt auf die Leiste; erzeugte IDs merken
        const newIds = [];

        // Option: Favoriten-Links einzeln an den Anfang der Leiste,
        // Unterordner der Favoriten werden zu eigenen Top-Level-Ordnern
        if (inlineFavorites && tree.folders.has(FAVORITES_TITLE)) {
            const fav = tree.folders.get(FAVORITES_TITLE);
            tree.folders.delete(FAVORITES_TITLE);

            for (const link of fav.links.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'de'))) {
                const url = normalizeUrl(link.url);
                if (!url) {
                    stats.skipped++;
                    continue;
                }
                try {
                    const node = await chrome.bookmarks.create({
                        parentId: BOOKMARKS_BAR_ID,
                        title: link.title || url,
                        url,
                    });
                    newIds.push(node.id);
                    stats.created++;
                } catch (e) {
                    stats.skipped++;
                }
            }
            for (const [name, child] of [...fav.folders.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
                const folder = await chrome.bookmarks.create({ parentId: BOOKMARKS_BAR_ID, title: name });
                newIds.push(folder.id);
                await createTree(folder.id, child, stats);
            }
        }

        for (const [name, child] of [...tree.folders.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
            const folder = await chrome.bookmarks.create({ parentId: BOOKMARKS_BAR_ID, title: name });
            newIds.push(folder.id);
            await createTree(folder.id, child, stats);
        }
        for (const link of tree.links.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'de'))) {
            const url = normalizeUrl(link.url);
            if (!url) {
                stats.skipped++;
                continue;
            }
            try {
                const node = await chrome.bookmarks.create({
                    parentId: BOOKMARKS_BAR_ID,
                    title: link.title || url,
                    url,
                });
                newIds.push(node.id);
                stats.created++;
            } catch (e) {
                stats.skipped++;
            }
        }
        await chrome.storage.local.set({ mirrorIds: newIds, lastMode: 'direct' });
    } else {
        // Standard: alles im Überordner "Link-Safe"
        const barChildren = await chrome.bookmarks.getChildren(BOOKMARKS_BAR_ID);
        let mirror = barChildren.find((n) => !n.url && n.title === MIRROR_TITLE);
        if (!mirror) {
            mirror = await chrome.bookmarks.create({ parentId: BOOKMARKS_BAR_ID, title: MIRROR_TITLE });
        }

        // Nur den Inhalt UNSERES Ordners erneuern
        for (const child of await chrome.bookmarks.getChildren(mirror.id)) {
            await chrome.bookmarks.removeTree(child.id);
        }
        await createTree(mirror.id, tree, stats);
        await chrome.storage.local.set({ mirrorIds: [], lastMode: 'folder' });
    }

    await setStatus(`✓ ${stats.created} Links synchronisiert`, stats.created, stats.skipped);
}
