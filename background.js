// Link-Safe → Lesezeichenleiste (Einweg-Spiegel)
//
// Holt alle aktiven Links über die Link-Safe-API (Read-only-Token) und baut
// sie als Ordner "Link-Safe" in der Lesezeichenleiste nach. Der Ordner gehört
// der Extension und wird bei jedem Sync komplett neu erzeugt — eigene
// Lesezeichen außerhalb dieses Ordners werden nie angefasst.

const MIRROR_TITLE = 'Link-Safe';
const FAVORITES_TITLE = 'Favoriten'; // Hauptordner-Name in der App (CONFIG.FAVORITES_FOLDER)
const BOOKMARKS_BAR_ID = '1'; // Lesezeichenleiste in Chromium

chrome.runtime.onInstalled.addListener(() => {
    richteAnzeigeEin().catch(() => { /* ohne Optionen noch nichts anzuzeigen */ });
});

// Der Spiegel entsteht bei jedem Browserstart neu und sonst nur auf Knopfdruck
// (Popup, Optionen). Bis 1.5.0 lief er zusätzlich alle 15 Minuten über einen
// Alarm — jeder Lauf baut den ganzen Ordner ab und wieder auf, das war zu oft.
// Die Berechtigung "alarms" ist mit dem Alarm entfallen.
chrome.runtime.onStartup.addListener(() => {
    richteAnzeigeEin().catch(() => { /* ohne Optionen noch nichts anzuzeigen */ });
    syncBookmarks().catch((e) => setStatus('Fehler: ' + e.message));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.action === 'sync-now') {
        syncBookmarks()
            .then((details) => sendResponse({ ok: true, ...details }))
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
    // Diagnose für die Optionsseite: Warum greift der Klick-Abfang (nicht)?
    if (msg?.action === 'nav-status') {
        navStatus()
            .then((status) => sendResponse({ ok: true, ...status }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // Spiegel-Ordner aus der Leiste räumen (für einen sauberen Neuanfang)
    if (msg?.action === 'remove-mirror') {
        removeMirror()
            .then((result) => sendResponse({ ok: true, ...result }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // Speicherfenster: popup.js meldet das eben geöffnete Fenster an …
    if (msg?.action === 'watch-save-window') {
        watchSaveWindow(msg.tabId, msg.windowId, msg.art)
            .then(() => sendResponse({ ok: true }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // … und das Skript darin meldet, wie viel Platz der Seite fehlt
    if (msg?.action === 'grow-save-window') {
        growSaveWindow(sender, msg)
            .then((result) => sendResponse({ ok: true, ...result }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // Speicherseite im normalen Tab: nur fürs Nachladen der Anzeige merken
    if (msg?.action === 'watch-save-tab') {
        watchSaveTab(msg.tabId)
            .then(() => sendResponse({ ok: true }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // Popup fragt, ob die Seite im Tab schon gespeichert ist, und wo — die
    // Ordner einzeln, es setzt jeden in eine eigene Zeile. Leer heißt „Ohne Ordner".
    if (msg?.action === 'saved-info') {
        gespeichertIn(msg.url)
            .then((orte) => sendResponse({ ok: true, gespeichert: Boolean(orte), ordner: orte ? orte.filter(Boolean) : [] }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;

    // Wartet ein Ergebnis auf Zustellung, sobald ein Tab der App fertig lädt?
    chrome.storage.local.get(['pendingResults']).then(({ pendingResults }) => {
        if (pendingResults) flushPendingResults().catch(() => { /* nächster Tab-Load probiert erneut */ });
    });

    // Ist es ein Speicherfenster der Bridge? Dann das Mitwachsen einrichten.
    savedWindows().then((fenster) => {
        if (fenster[tabId] != null) injectSaveWindowRelay(tabId).catch(() => { /* nächster Load */ });
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    savedWindows().then((fenster) => {
        if (fenster[tabId] == null) return;
        // Ein Link-Fenster schließt sich erst, wenn der Server den Link hat —
        // jetzt kann die Kette im Symbol grün werden (Gespeichert-Anzeige)
        if (fenster[tabId].art === 'link') nachSpeichern();
        delete fenster[tabId];
        return chrome.storage.session.set({ saveWindows: fenster });
    }).catch(() => { /* verwaist höchstens bis zum Browser-Neustart */ });
});

// ===============================
// Speicherfenster passt sich seinem Inhalt an
// ===============================
//
// Die Speicherseite der App öffnet in einer Startgröße (popup.js) und meldet
// danach selbst, was ihr fehlt oder zu viel ist — nur sie kennt ihr Layout:
// <html data-save-window-need="fit|grow Breite Höhe"> in CSS-Pixeln, siehe
// FENSTERGRÖSSE in speichern.js. Umbauen darf sich ein Fenster aus
// chrome.windows.create dort nicht selbst (window.resizeTo gilt nur für
// window.open-Fenster), die Extension darf es. Ein kleines Skript im Fenster
// (injectSaveWindowRelay) reicht den Wert deshalb hierher weiter.
//
//   „fit"  — einmal genau einpassen, sobald die Seite fertig ist; darf auch
//            verkleinern. Das Ergebnis wird je Fensterart gemerkt
//            (saveWindowSizes), popup.js öffnet das nächste Fenster so.
//   „grow" — danach nur noch wachsen, nie schrumpfen.
//
// Umgebaut werden ausschließlich Fenster, die popup.js selbst geöffnet und
// angemeldet hat — nie ein Tab im normalen Browserfenster. Gedeckelt auf den
// Bildschirm, zur Mitte hin (das Fenster wurde mittig geöffnet).

// Kleiner wird ein Fenster auch beim Einpassen nicht — Schutz gegen einen
// Messfehler, der es zu einem Strich zusammenfalten würde.
const SAVE_WINDOW_MIN = { width: 360, height: 300 };

// tabId → { windowId, art }; in storage.session, weil der Service Worker
// zwischen zwei Meldungen beendet werden kann.
async function savedWindows() {
    const { saveWindows = {} } = await chrome.storage.session.get(['saveWindows']);
    return saveWindows;
}

async function watchSaveWindow(tabId, windowId, art) {
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) {
        throw new Error('Kein gültiges Fenster übergeben.');
    }
    const fenster = await savedWindows();
    fenster[tabId] = { windowId, art: art === 'note' ? 'note' : 'link' };
    await chrome.storage.session.set({ saveWindows: fenster });

    // Ist die Seite schon fertig, bevor diese Meldung ankam, käme kein
    // onUpdated mehr — dann gleich hier einrichten.
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') await injectSaveWindowRelay(tabId);
}

async function injectSaveWindowRelay(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: relaySaveWindowNeed,
    });
}

// Läuft im Speicherfenster (isolierte Welt) — vollständig eigenständig, ohne
// Closures. Beobachtet das Attribut und meldet jeden neuen Bedarf einmal.
function relaySaveWindowNeed() {
    if (window.__linkSafeSaveWindowRelay) return;
    window.__linkSafeSaveWindowRelay = true;

    const root = document.documentElement;
    let gemeldet = '';
    const pruefen = () => {
        const bedarf = root.dataset.saveWindowNeed || '';
        if (!bedarf || bedarf === gemeldet) return;
        gemeldet = bedarf;
        const teile = bedarf.split(' ');
        const modus = teile[0] === 'fit' ? 'fit' : 'grow';
        if (teile[0] === 'fit' || teile[0] === 'grow') teile.shift();
        const [extraW, extraH] = teile.map(Number);
        if (!Number.isFinite(extraW) || !Number.isFinite(extraH)) return;
        if (modus === 'grow' && !(extraW > 0) && !(extraH > 0)) return;
        if (modus === 'fit' && !extraW && !extraH) return;
        chrome.runtime.sendMessage({
            action: 'grow-save-window',
            modus,
            extraW,
            extraH,
            bildschirm: {
                left: screen.availLeft,
                top: screen.availTop,
                width: screen.availWidth,
                height: screen.availHeight,
            },
        }).catch(() => { /* Hintergrund neu gestartet — nächster Bedarf probiert erneut */ });
    };
    new MutationObserver(pruefen).observe(root, {
        attributes: true,
        attributeFilter: ['data-save-window-need'],
    });
    pruefen();
}

// Nacheinander statt gleichzeitig: Zwei Meldungen kurz hintereinander würden
// sonst beide von derselben alten Größe aus rechnen und doppelt wachsen.
let growQueue = Promise.resolve();

function growSaveWindow(sender, msg) {
    const run = growQueue.then(() => growSaveWindowNow(sender, msg));
    growQueue = run.catch(() => { /* Kette nicht abreißen lassen */ });
    return run;
}

async function growSaveWindowNow(sender, msg) {
    const tabId = sender?.tab?.id;
    const fenster = await savedWindows();
    const eintrag = fenster[tabId];
    const windowId = eintrag?.windowId;
    if (windowId == null || sender.tab.windowId !== windowId) {
        return { gewachsen: false, grund: 'kein Speicherfenster der Bridge' };
    }

    const einpassen = msg.modus === 'fit';
    const zahl = (wert) => (Number.isFinite(Number(wert)) ? Number(wert) : 0);
    const grenze = (wert) => Math.min(Math.max(einpassen ? -2000 : 0, zahl(wert)), 2000);
    const extraW = grenze(msg.extraW);
    const extraH = grenze(msg.extraH);
    if (!extraW && !extraH) return { gewachsen: false };

    // Die Seite misst in CSS-Pixeln, das Fenster zählt in Bildschirmpunkten:
    // bei 110 % Zoom braucht jeder CSS-Pixel 1,1 Punkte. Ohne Zoomwert passt
    // es nicht ganz — die Seite meldet den Rest dann im nächsten Durchgang.
    // Math.ceil rundet auch beim Verkleinern zur Null hin: lieber ein Punkt
    // zu viel als ein Scrollbalken.
    let zoom = 1;
    try {
        zoom = (await chrome.tabs.getZoom(tabId)) || 1;
    } catch (e) {
        zoom = 1;
    }

    const win = await chrome.windows.get(windowId);
    const s = msg.bildschirm || {};
    const bLeft = zahl(s.left);
    const bTop = zahl(s.top);
    const bWidth = zahl(s.width) || win.width;
    const bHeight = zahl(s.height) || win.height;

    // Dieselbe Deckelung wie beim Öffnen in popup.js. Beim Wachsen nie unter
    // die jetzige Größe, beim Einpassen nie unter das Minimum.
    const maxWidth = Math.max(win.width, bWidth - 40);
    const maxHeight = Math.max(win.height, bHeight - 40);
    const minWidth = einpassen ? Math.min(win.width, SAVE_WINDOW_MIN.width) : win.width;
    const minHeight = einpassen ? Math.min(win.height, SAVE_WINDOW_MIN.height) : win.height;
    const width = Math.min(Math.max(win.width + Math.ceil(extraW * zoom), minWidth), maxWidth);
    const height = Math.min(Math.max(win.height + Math.ceil(extraH * zoom), minHeight), maxHeight);

    if (width !== win.width || height !== win.height) {
        // Zur Mitte hin, aber auf dem Bildschirm bleiben
        let left = win.left - Math.round((width - win.width) / 2);
        let top = win.top - Math.round((height - win.height) / 2);
        left = Math.min(Math.max(left, bLeft), bLeft + bWidth - width);
        top = Math.min(Math.max(top, bTop), bTop + bHeight - height);
        await chrome.windows.update(windowId, { width, height, left, top });
    }

    // Die eingepasste Größe ist die Startgröße fürs nächste Mal
    if (einpassen) {
        const { saveWindowSizes = {} } = await chrome.storage.local.get(['saveWindowSizes']);
        saveWindowSizes[eintrag.art] = { width, height };
        await chrome.storage.local.set({ saveWindowSizes });
    }

    if (width === win.width && height === win.height) {
        return { gewachsen: false, grund: einpassen ? 'passt schon' : 'Bildschirmrand' };
    }
    return { gewachsen: true, width, height, zoom };
}

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

/**
 * Alle aktiven Links laden (paginiert über den Sync-Cursor der API).
 *
 * Der Cursor ist ein ZEITSTEMPEL, kein Zeiger: Die API liefert `updated_at >
 * since`, aufsteigend sortiert, 100 Einträge je Seite. Rückte der Cursor auf
 * den GRÖSSTEN Zeitstempel der Seite vor, fiel alles durchs Raster, was genau
 * diesen Zeitstempel trägt und nicht mehr auf die Seite gepasst hat.
 *
 * Das ist kein Randfall. Ein Stapel-Upload schreibt bis zu 100 Datensätze in
 * einer Transaktion, viele davon in derselben Millisekunde — und genau so
 * entsteht ein Ordner, dessen Links am Stück umsortiert oder verschoben
 * wurden. Fällt eine Seitengrenze mitten in so einen Block, ist dessen Rest
 * bei JEDEM Sync unsichtbar: immer dieselben Links, ohne Fehlermeldung.
 *
 * Deshalb eine Millisekunde Überlappung. Die Einträge des letzten Zeitstempels
 * kommen auf der nächsten Seite noch einmal und werden über ihre ID verworfen.
 * Gemessen an 310 Links mit einem 60er-Block in einer Millisekunde: vorher
 * kamen 300 an (50 von 60 aus dem Block), jetzt alle 310.
 *
 * Mit `ab` holt sie nur, was sich seit diesem Zeitstempel geändert hat — so
 * zieht die Gespeichert-Anzeige nach dem Speichern nach, ohne alles zu laden.
 * Für sie liefert sie außerdem `adressen` (ID → Vergleichsform und Ordner,
 * null für Gelöschtes und Papierkorb) und `bis`, den jüngsten gesehenen
 * Zeitstempel. `updated_at` setzt der Server, nicht das Gerät (api/items.php).
 */
async function fetchAllLinks(apiUrl, token, ab = 0) {
    const links = [];
    const adressen = new Map();
    const gesehen = new Set();
    let since = ab;
    let bis = ab;
    const zaehler = { seiten: 0, doppelte: 0, luecken: 0 };

    for (;;) {
        const response = await fetch(`${apiUrl}/links?since=${since}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
            throw new Error(`API antwortet mit HTTP ${response.status}`);
        }
        const data = await response.json();
        zaehler.seiten++;

        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) break;

        let groesster = since;
        for (const item of items) {
            if (item.updatedAt > groesster) groesster = item.updatedAt;
            if (gesehen.has(item.id)) {
                zaehler.doppelte++;
                continue;
            }
            gesehen.add(item.id);
            if (!item.deleted && item.data && !item.data.trashed && item.data.url) {
                links.push(item.data);
                adressen.set(item.id, [normalizeUrlForCompare(item.data.url), placesOf(item.data)]);
            } else {
                adressen.set(item.id, null);
            }
        }
        if (groesster > bis) bis = groesster;

        if (!data.hasMore) break;

        const vorher = since;
        since = groesster - 1;
        if (since <= vorher) {
            // Eine ganze Seite in einer einzigen Millisekunde: Die Überlappung
            // käme nicht von der Stelle, vorwärts geht es nur mit Verlust.
            // Das gehört in die Diagnose statt ins Schweigen.
            since = groesster;
            zaehler.luecken++;
        }
        if (since <= vorher) break; // kein Fortschritt mehr möglich
    }

    return { links, adressen, bis, ...zaehler };
}

// ===============================
// LINK-ROT-PRÜFUNG: Datenquelle und Zustellung an die App
// ===============================

// Die Prüfseite braucht nur Kennung, URL, Titel und Ordner. Favicon und
// og:image sind data-URIs mit 30-80 KB pro Link — die würden die Nachricht
// bei ~4000 Links auf dreistellige Megabyte aufblähen.
async function fetchCheckTargets() {
    const { apiUrl, token } = await getConfig();
    const { links } = await fetchAllLinks(apiUrl, token);
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

// Ablageorte eines Links — Kurzfassung von placesOf() aus shared.js der App.
// Die Wahrheit steht in link.folders = [{ path, order }, …], erster Eintrag ist
// der Hauptort; link.folder ist nur dessen Spiegel. Bewusst eine Kopie und kein
// Import: die Extension läuft in einem eigenen Kontext und soll ohne die App
// startfähig bleiben. Wird die Regel in shared.js geändert, gehört sie hier nach.
function placesOf(link) {
    const seen = new Set();
    const paths = [];
    for (const raw of Array.isArray(link?.folders) ? link.folders : []) {
        const path = String((typeof raw === 'string' ? raw : raw?.path) ?? '');
        if (!path || seen.has(path)) continue;
        seen.add(path);
        paths.push(path);
    }

    const single = String(link?.folder || '');
    if (!paths.length) return single ? [single] : [''];
    // Ein Gerät auf älterem Stand hat den Hauptort verschoben, ohne `folders`
    // zu kennen: sein `folder` gewinnt, die Zweitablagen bleiben stehen.
    if (single && paths[0] !== single && !paths.includes(single)) {
        return [single, ...paths.slice(1)];
    }
    return paths;
}

// "A/B/C"-Pfade in einen Baum überführen. Liegt ein Link in mehreren Ordnern,
// erscheint er in jedem davon — Chrome erlaubt dieselbe URL beliebig oft.
// Ohne mirrorSecondary bleibt es beim Hauptort (Verhalten bis 1.1.0).
function buildTree(links, mirrorSecondary = true) {
    const root = { folders: new Map(), links: [] };
    for (const link of links) {
        const places = mirrorSecondary ? placesOf(link) : [placesOf(link)[0]];
        for (const place of places) {
            let node = root;
            for (const segment of String(place || '').split('/').filter(Boolean)) {
                if (!node.folders.has(segment)) {
                    node.folders.set(segment, { folders: new Map(), links: [] });
                }
                node = node.folders.get(segment);
            }
            node.links.push(link);
        }
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
            stats.urls.add(url);
        } catch (e) {
            // Einzelner problematischer Link darf den Sync nicht abbrechen
            stats.skipped++;
        }
    }
}

/**
 * Lose Lesezeichen direkt auf die Leiste legen — ohne Ordner darum.
 * Gibt die erzeugten IDs zurück: Nur über sie findet der nächste Sync sie
 * wieder, denn außerhalb des Überordners ist nichts an ihnen als „unser"
 * erkennbar.
 *
 * `abIndex` schreibt die Position auf der Leiste fest. Ohne ihn hängt sie
 * davon ab, was gerade sonst auf der Leiste steht — siehe detachFavorites().
 */
async function createLooseLinks(links, stats, abIndex = null) {
    const ids = [];
    for (const link of links.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'de'))) {
        const url = normalizeUrl(link.url);
        if (!url) {
            stats.skipped++;
            continue;
        }
        try {
            const ziel = { parentId: BOOKMARKS_BAR_ID, title: link.title || url, url };
            if (abIndex !== null) ziel.index = abIndex + ids.length;
            const node = await chrome.bookmarks.create(ziel);
            ids.push(node.id);
            stats.created++;
            stats.urls.add(url);
        } catch (e) {
            // Einzelner problematischer Link darf den Sync nicht abbrechen
            stats.skipped++;
        }
    }
    return ids;
}

/**
 * Option „Favoriten-Links direkt auf die Leiste legen": löst den Ordner
 * „Favoriten" aus dem Baum. Seine Links werden einzelne Lesezeichen auf der
 * Leiste, seine Unterordner eigene Ordner daneben.
 *
 * Gilt seit 1.3.1 in BEIDEN Modi. Bis 1.3.0 stand der Block innerhalb von
 * `if (directMode)` — wer im Überordner-Modus die Checkbox anhakte, bekam
 * nichts: kein Effekt, keine Meldung. Ein Schalter ohne Wirkung ist kaputt,
 * auch wenn ein Hinweistext darunter das erklärt.
 *
 * Muss VOR dem Aufbau des Spiegels laufen — was hier herausgelöst wird, darf
 * danach nicht noch einmal im Baum auftauchen.
 *
 * Alles landet mit ausdrücklichem Index am ANFANG der Leiste. Ohne den hing
 * die Position davon ab, ob der Überordner in diesem Lauf neu entstanden ist:
 * Beim ersten Sync gab es ihn noch nicht, die Favoriten kamen davor; beim
 * zweiten stand er schon, und sie rutschten dahinter. Gemessen an einem
 * Testbaum — Inhalt identisch, Reihenfolge nicht.
 */
async function detachFavorites(tree, stats) {
    if (!tree.folders.has(FAVORITES_TITLE)) return [];

    const fav = tree.folders.get(FAVORITES_TITLE);
    tree.folders.delete(FAVORITES_TITLE);

    const ids = await createLooseLinks(fav.links, stats, 0);
    for (const [name, child] of [...fav.folders.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
        const folder = await chrome.bookmarks.create({
            parentId: BOOKMARKS_BAR_ID,
            index: ids.length,
            title: name,
        });
        ids.push(folder.id);
        await createTree(folder.id, child, stats);
    }
    return ids;
}

async function syncBookmarks() {
    const { apiUrl, token } = await getConfig();
    const { directMode = false, inlineFavorites = false, mirrorSecondary = true, lastMode = null, mirrorIds = [] } =
        await chrome.storage.local.get(["directMode", "inlineFavorites", "mirrorSecondary", "lastMode", "mirrorIds"]);

    const { links, adressen, bis, seiten, doppelte, luecken } = await fetchAllLinks(apiUrl, token);

    // Gleich hier und nicht erst nach dem Umbau der Leiste: Je länger der
    // Abstand zum Laden, desto eher überschreibt dieser Stand eine
    // Nachlieferung, die inzwischen neuer ist. Ohne await — der Umbau muss
    // nicht auf die Anzeige warten.
    uebernehmeAdressen(adressen, bis)
        .catch(() => { /* Anzeige bleibt beim alten Stand, der Spiegel geht vor */ });

    const tree = buildTree(links, mirrorSecondary !== false);
    // urls: Grundlage für den Klick-Abfang (openInNewTab) — nur Adressen, die
    // wirklich als Lesezeichen entstanden sind, werden später abgefangen.
    const stats = { created: 0, skipped: 0, entfernteDoppel: 0, urls: new Set() };

    // Knoten vom letzten Sync entfernen, die direkt auf der Leiste liegen —
    // im Direkt-Modus der ganze Spiegel, im Überordner-Modus die losen
    // Favoriten. Die IDs stammen sicher von uns; eigene Lesezeichen des
    // Nutzers werden dadurch nie berührt.
    for (const id of mirrorIds) {
        try {
            await chrome.bookmarks.removeTree(String(id));
        } catch (e) {
            // Knoten wurde manuell gelöscht — nichts zu tun
        }
    }

    // Beim Wechsel in den Direkt-Modus den alten "Link-Safe"-Ordner abräumen —
    // aber NUR beim Wechsel: Ein später vom Nutzer selbst angelegter Ordner
    // gleichen Namens darf nicht bei jedem Sync sterben.
    if (directMode && lastMode !== 'direct') {
        const barChildren = await chrome.bookmarks.getChildren(BOOKMARKS_BAR_ID);
        const oldMirror = barChildren.find((n) => !n.url && n.title === MIRROR_TITLE);
        if (oldMirror) {
            await chrome.bookmarks.removeTree(oldMirror.id);
        }
    }

    // Favoriten aus dem Baum lösen, bevor der Spiegel entsteht — in beiden Modi.
    const favIds = inlineFavorites ? await detachFavorites(tree, stats) : [];

    if (directMode) {
        // Hauptordner + lose Links direkt auf die Leiste; erzeugte IDs merken
        const newIds = [...favIds];

        for (const [name, child] of [...tree.folders.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
            const folder = await chrome.bookmarks.create({ parentId: BOOKMARKS_BAR_ID, title: name });
            newIds.push(folder.id);
            await createTree(folder.id, child, stats);
        }
        newIds.push(...await createLooseLinks(tree.links, stats));

        await chrome.storage.local.set({ mirrorIds: newIds, lastMode: 'direct' });
    } else {
        // Standard: alles im Überordner "Link-Safe"
        const barChildren = await chrome.bookmarks.getChildren(BOOKMARKS_BAR_ID);
        const spiegel = barChildren.filter((n) => !n.url && n.title === MIRROR_TITLE);

        // Mehrere "Link-Safe"-Ordner entstehen, wenn zwei Installationen
        // nebeneinander synchronisiert haben — etwa eine alte und eine neu
        // geladene Kopie derselben Erweiterung. Der erste bleibt, die weiteren
        // fliegen raus, sonst wächst die Leiste mit jedem Wechsel um eine Kopie.
        for (const doppelt of spiegel.slice(1)) {
            await chrome.bookmarks.removeTree(doppelt.id);
            stats.entfernteDoppel++;
        }

        let mirror = spiegel[0];
        if (!mirror) {
            mirror = await chrome.bookmarks.create({ parentId: BOOKMARKS_BAR_ID, title: MIRROR_TITLE });
        }

        // Nur den Inhalt UNSERES Ordners erneuern
        for (const child of await chrome.bookmarks.getChildren(mirror.id)) {
            await chrome.bookmarks.removeTree(child.id);
        }
        await createTree(mirror.id, tree, stats);

        // Die losen Favoriten liegen AUSSERHALB des Überordners. Ohne ihre IDs
        // fände der nächste Sync sie nicht wieder — er räumt nur den Inhalt
        // von "Link-Safe" ab, und die Leiste wüchse mit jedem Lauf um einen
        // vollständigen Satz Favoriten.
        await chrome.storage.local.set({ mirrorIds: favIds, lastMode: 'folder' });
    }

    // Adressen des Spiegels festhalten: nur sie fängt der Klick-Abfang ab
    // In Vergleichsform ablegen — Chrome navigiert normalisiert (siehe canonicalUrl)
    await chrome.storage.local.set({ mirrorUrls: [...stats.urls].map(canonicalUrl) });

    const doppel = stats.entfernteDoppel > 0
        ? `, ${stats.entfernteDoppel} doppelten Spiegel entfernt`
        : '';
    await setStatus(
        `✓ ${stats.created} Lesezeichen aus ${links.length} Links${doppel}`,
        stats.created,
        stats.skipped,
    );

    // Zahlen des letzten Laufs für Optionsseite und Diagnose. `links` ist die
    // Zahl, die wirklich etwas aussagt: aktive, nicht gelöschte Links mit
    // Adresse. Die Gesamtzahl der API (`total`) zählt Tombstones und
    // Papierkorb mit und ist deshalb um ein Vielfaches zu hoch.
    const details = {
        links: links.length,
        lesezeichen: stats.created,
        uebersprungen: stats.skipped,
        seiten,
        doppelte,
        luecken,
    };
    await chrome.storage.local.set({ syncDetails: details });
    return details;
}

// ===============================
// GESPEICHERT-ANZEIGE AM SYMBOL
// ===============================
//
// Liegt die Seite im Tab schon in Link-Safe, wird die Kette im Symbol grün
// statt blau. Verglichen wird lokal gegen die Adressen, die der Sync ohnehin
// lädt; keine Adresse verlässt dafür den Browser. Weil das Symbol den Zustand
// nur über die Farbe zeigt, sagt es der Tooltip in Worten, mit den Ordnern
// dazu. Dasselbe zeigt das Popup über dem Speichern-Knopf ('saved-info').
//
// Bis zum Test von 1.5.0 war es ein grünes ✓-Badge. Das verdeckte die untere
// Ecke des Symbols, das auf dunklen Leisten ohnehin kaum zu sehen war (dünne
// Kette in #0056b3: 2,29 : 1 auf #202124). Seitdem liegt die Kette auf einer
// fast schwarzen Kachel und wechselt die Farbe (icon-*.png, icon-gespeichert-*.png).
//
// Die Liste liegt in storage.local — savedLinks: ID → [Vergleichsform,
// Ordner], savedLinksBis: jüngster Zeitstempel darin. Aktuell hält sie sich
// auf zwei Wegen:
//   - Jeder Sync baut sie neu (bei jedem Browserstart und auf Knopfdruck).
//   - Schließt sich eine Speicherseite, die die Bridge geöffnet hat, kommt
//     nur nach, was sich seit savedLinksBis geändert hat. Die Seite geht erst
//     zu, wenn der Server den Link hat (speichern.js schließt nur nach
//     „Gespeichert", nicht nach „Nur lokal gespeichert").
// Was in der App oder auf einem anderen Gerät geschieht, zeigt das Symbol
// erst nach dem nächsten Sync.
//
// Ob Chrome die Anzeige eines Tabs beim Seitenwechsel selbst zurücksetzt,
// sagt die Doku nicht (nur: beim Schließen). Deshalb wird sie bei jeder
// Änderung von Adresse oder Ladezustand neu gesetzt, auch auf „nicht gespeichert".

// Kachel #16181d. Kette #4f8fd0 (5,22 : 1 darauf) bzw. #4cc764 (8,17 : 1) —
// das Grün ist bewusst heller, so unterscheiden sich die Zustände auch in der
// Helligkeit. 16 für normale, 32 für hochauflösende Bildschirme.
const SYMBOL = { 16: 'icon-16.png', 32: 'icon-32.png' }; // wie default_icon im Manifest
const SYMBOL_GESPEICHERT = { 16: 'icon-gespeichert-16.png', 32: 'icon-gespeichert-32.png' };
const TITEL = 'Link-Safe Bridge'; // wie default_title im Manifest

// Wörtlich aus shared.js der App (normalizeUrlForCompare samt Tracking-Liste).
// Nach genau dieser Regel meldet die Speicherseite „Schon gespeichert", und
// Symbol und Speicherseite dürfen sich nie widersprechen. Wird sie dort
// geändert, gehört sie hier nach. Bewusst nicht canonicalUrl: Die dient dem
// Mittelklick und hält Protokoll, www. und Tracking-Parameter fest.
const TRACKING_PREFIXES = /^(utm_|mc_|pk_|piwik_|matomo_)/i;
const TRACKING_PARAMS = new Set([
    'fbclid', 'gclid', 'dclid', 'msclkid', 'wbraid', 'gbraid',
    'igshid', 'yclid', 'twclid', 'ttclid', 's_kwcid', 'spm', 'si',
]);

function isTrackingParam(name) {
    return TRACKING_PREFIXES.test(name) || TRACKING_PARAMS.has(name.toLowerCase());
}

function normalizeUrlForCompare(rawUrl) {
    const input = String(rawUrl || '').trim();
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : 'https://' + input);
        for (const key of [...url.searchParams.keys()]) {
            if (isTrackingParam(key)) url.searchParams.delete(key);
        }
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const path = url.pathname.replace(/\/+$/, '');
        const query = url.searchParams.toString();
        return host + path + (query ? '?' + query : '');
    } catch (e) {
        return input.toLowerCase();
    }
}

// Nacheinander statt gleichzeitig: Eine Nachlieferung und der Stand eines
// Syncs dürfen sich nicht gegenseitig überschreiben.
let adressQueue = Promise.resolve();

function nacheinander(aufgabe) {
    const run = adressQueue.then(aufgabe);
    adressQueue = run.catch(() => { /* Kette nicht abreißen lassen */ });
    return run;
}

// Vergleichsform → Ordner, gebaut aus storage.local. Lebt nur so lange wie
// der Service Worker; danach baut die nächste Frage sie neu. adressStand
// zählt jedes Schreiben mit — eine Karte, die während eines Schreibens
// entstanden ist, wird nicht behalten.
let adressCache = null;
let adressStand = 0;

async function gespeicherteAdressen() {
    if (adressCache) return adressCache;
    const stand = adressStand;
    const { savedLinks = {} } = await chrome.storage.local.get(['savedLinks']);
    const karte = new Map();
    for (const [url, orte] of Object.values(savedLinks)) {
        // Dieselbe Adresse zweimal gespeichert: alle Ordner beider nennen
        const bisher = karte.get(url);
        karte.set(url, bisher ? [...new Set([...bisher, ...orte])] : orte);
    }
    if (stand === adressStand) adressCache = karte;
    return karte;
}

// Ordner, in denen die Adresse liegt — oder null, wenn sie nicht gespeichert ist
async function gespeichertIn(url) {
    if (!/^https?:\/\//i.test(url || '')) return null;
    return (await gespeicherteAdressen()).get(normalizeUrlForCompare(url)) || null;
}

// Wie die Speicherseite: „A", „B" — oder „Ohne Ordner"
function ortText(orte) {
    return `„${orte.filter(Boolean).join('“, „') || 'Ohne Ordner'}“`;
}

async function markiereTab(tabId, url) {
    try {
        const orte = await gespeichertIn(url);
        if (orte) {
            await chrome.action.setIcon({ tabId, path: SYMBOL_GESPEICHERT });
            await chrome.action.setTitle({ tabId, title: `${TITEL} – schon gespeichert in ${ortText(orte)}` });
        } else {
            await chrome.action.setIcon({ tabId, path: SYMBOL });
            await chrome.action.setTitle({ tabId, title: TITEL });
        }
    } catch (e) {
        // Tab inzwischen geschlossen — nichts zu tun
    }
}

async function markiereAlleTabs() {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => markiereTab(tab.id, tab.url)));
}

// Schreibt ein Ergebnis von fetchAllLinks in die Liste. `voll` ersetzt sie
// (Sync), sonst kommen nur die Änderungen hinein. Läuft nur in der Warteschlange.
// Gibt true zurück, wenn eine Nachlieferung schon weiter war als dieser
// volle Stand — deren Änderungen fehlen dann in der eben geschriebenen Liste.
async function schreibeAdressen(adressen, bis, voll) {
    const { savedLinks = {}, savedLinksBis = 0 } =
        await chrome.storage.local.get(['savedLinks', 'savedLinksBis']);
    const liste = voll ? {} : savedLinks;
    for (const [id, eintrag] of adressen) {
        if (eintrag) liste[id] = eintrag;
        else delete liste[id];
    }
    adressStand++;
    adressCache = null;
    await chrome.storage.local.set({
        savedLinks: liste,
        savedLinksBis: voll ? bis : Math.max(bis, savedLinksBis),
    });
    return voll && savedLinksBis > bis;
}

// Voller Stand aus dem Sync. War eine Nachlieferung schon weiter, fehlen
// deren Änderungen in dieser Liste — dann ab hier noch einmal nachholen.
async function uebernehmeAdressen(adressen, bis) {
    const ueberholt = await nacheinander(() => schreibeAdressen(adressen, bis, true));
    await markiereAlleTabs();
    if (ueberholt) await aktualisiereAdressen();
}

// Nur die Änderungen seit dem letzten Stand holen. Ohne Liste (erster Start
// nach dem Update auf 1.5.0) lädt es einmal alles — die Lesezeichenleiste
// bleibt dabei unangetastet, das macht weiter nur der Sync.
async function aktualisiereAdressen() {
    await nacheinander(async () => {
        const { apiUrl, token } = await getConfig();
        const { savedLinks, savedLinksBis } =
            await chrome.storage.local.get(['savedLinks', 'savedLinksBis']);
        const voll = !savedLinks || !Number.isFinite(savedLinksBis);
        // Eine Millisekunde Überlappung wie in fetchAllLinks: Was doppelt
        // kommt, schreibt nur denselben Stand noch einmal.
        const ab = voll ? 0 : Math.max(0, savedLinksBis - 1);
        const { adressen, bis } = await fetchAllLinks(apiUrl, token, ab);
        await schreibeAdressen(adressen, bis, voll);
    });
    await markiereAlleTabs();
}

// Beim Start des Browsers und nach Installation oder Update
async function richteAnzeigeEin() {
    const { savedLinks } = await chrome.storage.local.get(['savedLinks']);
    if (savedLinks) await markiereAlleTabs();
    else await aktualisiereAdressen();
}

// Eine Speicherseite der Bridge hat sich geschlossen
function nachSpeichern() {
    aktualisiereAdressen().catch(() => { /* dann eben mit dem nächsten Sync */ });
}

// Speicherseiten im normalen Tab (Option saveInTab) — die Fenster führt
// saveWindows, diese hier werden nur fürs Nachladen gemerkt.
async function saveTabs() {
    const { saveTabs: tabs = [] } = await chrome.storage.session.get(['saveTabs']);
    return tabs;
}

async function watchSaveTab(tabId) {
    if (!Number.isInteger(tabId)) throw new Error('Kein gültiger Tab übergeben.');
    const tabs = await saveTabs();
    if (!tabs.includes(tabId)) await chrome.storage.session.set({ saveTabs: [...tabs, tabId] });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url && !changeInfo.status) return;
    markiereTab(tabId, tab.url);
});

// Chrome tauscht Tabs beim Vorladen aus — der neue trägt noch keine Anzeige
chrome.tabs.onReplaced.addListener((addedTabId) => {
    chrome.tabs.get(addedTabId)
        .then((tab) => markiereTab(addedTabId, tab.url))
        .catch(() => { /* schon wieder weg */ });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    saveTabs().then((tabs) => {
        if (!tabs.includes(tabId)) return;
        nachSpeichern();
        return chrome.storage.session.set({ saveTabs: tabs.filter((id) => id !== tabId) });
    }).catch(() => { /* verwaist höchstens bis zum Browser-Neustart */ });
});

// ===============================
// MITTELKLICK IN DER LESEZEICHENLEISTE: DEN NEUEN TAB NACH VORN HOLEN
// ===============================
//
// Chrome meldet einer Extension NICHT, dass ein Lesezeichen angeklickt wurde —
// die Bookmarks-API kann nur anlegen, ändern, löschen. Erkennbar ist der Klick
// erst an der Navigation, die er auslöst: webNavigation.onCommitted liefert
// transitionType "auto_bookmark".
//
// Beim Mittelklick macht Chrome die halbe Arbeit schon selbst: Es öffnet einen
// neuen Tab — nur eben im Hintergrund. Zu tun bleibt genau eins:
//
//   1. onCommitted sieht "auto_bookmark" in einem Tab, der NICHT im Vordergrund
//      liegt — das ist der Hintergrund-Tab eines Mittelklicks (oder Strg+Klick)
//   2. stammt die Adresse aus unserem Spiegel: Tab nach vorn holen
//
// Der Linksklick bleibt dabei unangetastet und öffnet wie gewohnt im selben Tab.
// Bis 1.2.4 wurde er abgefangen (neuer Tab daneben, alter Tab zurück) — das
// kostete ein sichtbares Anladen im alten Tab, einen halben Seitenaufruf und
// eine Verlaufsmessung per Skript-Injektion. Über den Mittelklick fällt das
// alles weg: Die Seite lädt genau einmal, im richtigen Tab.

const NAV_LOG_LAENGE = 12;

/**
 * Adresse in eine Vergleichsform bringen.
 *
 * Chrome normalisiert beim Navigieren: "https://example.com" im Lesezeichen
 * wird zu "https://example.com/", der Host wird kleingeschrieben, Umlaute
 * werden zu Punycode. Der rohe Stringvergleich gegen die gespeicherte Adresse
 * geht deshalb ins Leere.
 */
function canonicalUrl(raw) {
    try {
        const url = new URL(String(raw || ''));
        url.hash = '';
        // Der abschließende Schrägstrich unterscheidet keine Seiten:
        // ".../website/" und ".../website" sind dasselbe Ziel, und ob er im
        // Lesezeichen steht oder in der Navigation auftaucht, ist Zufall.
        if (!url.search && url.pathname.length > 1) {
            url.pathname = url.pathname.replace(/\/+$/, '');
        }
        const text = url.href;
        // "https://host/" und "https://host" sind dieselbe Seite
        return url.pathname === '/' && !url.search ? text.replace(/\/$/, '') : text;
    } catch (e) {
        return String(raw || '');
    }
}

// Mitschnitt der letzten Lesezeichen-Navigationen. Liegt in storage.session:
// überlebt den Schlaf des Service Workers, verschwindet mit dem Browser.
async function protokolliere(eintrag) {
    try {
        const { navLog = [] } = await chrome.storage.session.get(['navLog']);
        navLog.unshift({ zeit: Date.now(), ...eintrag });
        await chrome.storage.session.set({ navLog: navLog.slice(0, NAV_LOG_LAENGE) });
    } catch (e) {
        // Protokoll ist Diagnose, kein Zweck an sich
    }
}

// Wohin ging es los? Bei einer Server-Umleitung meldet onCommitted NUR die
// Zielseite — die steht dann zu Recht nicht im Spiegel, obwohl der Klick auf
// ein gespiegeltes Lesezeichen ging. Die Startadresse steckt allein im
// vorangehenden onBeforeNavigate, deshalb wird sie hier gemerkt. Rein im
// Speicher und ohne await: Beide Ereignisse gehören zur selben Navigation,
// dazwischen bleibt der Service Worker wach. Fehlt der Eintrag doch einmal,
// zählt eben nur die Zieladresse.
const navStart = new Map(); // tabId → { url, zeit }

function merkeNavigationsstart(details) {
    if (details.frameId !== 0) return;
    navStart.set(details.tabId, { url: details.url, zeit: Date.now() });
    if (navStart.size > 50) {
        for (const [id, wert] of navStart) {
            if (Date.now() - wert.zeit > 60000) navStart.delete(id);
        }
    }
}

async function handleBookmarkNavigation(details) {
    if (details.frameId !== 0) return;

    const { openInNewTab = false, mirrorUrls = [] } =
        await chrome.storage.local.get(['openInNewTab', 'mirrorUrls']);
    if (!openInNewTab) return;

    const istLesezeichen = details.transitionType === 'auto_bookmark';
    const start = navStart.get(details.tabId);
    navStart.delete(details.tabId);

    // Ziel- und Startadresse zählen beide: Die eine trifft den Normalfall, die
    // andere den Fall "Lesezeichen zeigt auf eine Adresse, die weiterleitet".
    const kandidaten = [details.url];
    if (start && start.url !== details.url && Date.now() - start.zeit < 60000) {
        kandidaten.push(start.url);
    }
    const imSpiegel = kandidaten.some((u) => mirrorUrls.includes(canonicalUrl(u)));

    // Normales Surfen interessiert hier nicht — protokolliert und geprüft wird
    // nur, was nach einem Lesezeichen aussieht oder aus dem Spiegel stammt.
    if (!istLesezeichen && !imSpiegel) return;

    const notiz = { url: details.url, typ: details.transitionType, imSpiegel };
    if (start && start.url !== details.url) notiz.startUrl = start.url;

    if (!istLesezeichen) {
        await protokolliere({ ...notiz, ergebnis: `kein Lesezeichen-Klick (${details.transitionType})` });
        return;
    }
    if (!imSpiegel) {
        // Für die Diagnose: Was steht denn zu diesem Host im Spiegel? Daran
        // sieht man auf einen Blick, worin sich die Adressen unterscheiden.
        let aehnliche = [];
        try {
            const host = new URL(details.url).host;
            aehnliche = mirrorUrls.filter((u) => u.includes(host)).slice(0, 3);
        } catch (e) {
            // chrome-extension://… und Ähnliches hat keinen brauchbaren Host
        }
        await protokolliere({ ...notiz, ergebnis: 'Adresse nicht im Spiegel', aehnliche });
        return;
    }

    try {
        const tab = await chrome.tabs.get(details.tabId);
        if (tab.active) {
            // Linksklick: Chrome hat im selben (aktiven) Tab geöffnet. Das
            // bleibt bewusst, wie es ist — umgeleitet wird nur der Mittelklick.
            await protokolliere({ ...notiz, ergebnis: 'Linksklick — bleibt im selben Tab' });
            return;
        }
        await chrome.tabs.update(details.tabId, { active: true });
        await protokolliere({ ...notiz, ergebnis: '✓ Tab nach vorn geholt' });
    } catch (e) {
        await protokolliere({ ...notiz, ergebnis: 'Fehler: ' + e.message });
    }
}

// webNavigation ist eine optionale Berechtigung: ohne sie gibt es
// chrome.webNavigation gar nicht. Nach dem Erteilen registrieren wir sofort
// nach, sonst griffe der Abfang erst beim nächsten Start des Service Workers.
function registerNavigationHooks() {
    if (!chrome.webNavigation) return false;
    if (!chrome.webNavigation.onCommitted.hasListener(handleBookmarkNavigation)) {
        chrome.webNavigation.onBeforeNavigate.addListener(merkeNavigationsstart);
        chrome.webNavigation.onCommitted.addListener(handleBookmarkNavigation);
    }
    return true;
}

chrome.permissions.onAdded.addListener(() => registerNavigationHooks());
registerNavigationHooks();

// Diagnose für die Optionsseite. Beantwortet in einem Rutsch, was für den
// Klick-Abfang zusammenkommen muss: Schalter an, beide Berechtigungen erteilt,
// Adressen aus dem Spiegel bekannt, Listener registriert — dazu der Mitschnitt
// der letzten Lesezeichen-Navigationen, der zeigt, was Chrome wirklich meldet.
async function navStatus() {
    const { openInNewTab = false, mirrorUrls = [], lastSyncTime = null, syncDetails = null } =
        await chrome.storage.local.get(['openInNewTab', 'mirrorUrls', 'lastSyncTime', 'syncDetails']);
    const { navLog = [] } = await chrome.storage.session.get(['navLog']);
    const navPermission = await chrome.permissions.contains({ permissions: ['webNavigation'] });
    const hostPermission = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
    return {
        schalter: openInNewTab,
        navPermission,
        hostPermission,
        adressen: mirrorUrls.length,
        beispiel: mirrorUrls[0] || null,
        listener: !!chrome.webNavigation
            && chrome.webNavigation.onCommitted.hasListener(handleBookmarkNavigation),
        lastSyncTime,
        syncDetails,
        navLog,
    };
}

// Alles entfernen, was die Erweiterung je in die Leiste gelegt hat: den
// Überordner (auch mehrfach vorhandene) und die gemerkten Direkt-Modus-Knoten.
// Für Reste einer ANDEREN Installation im Direkt-Modus reicht das nicht — deren
// Lesezeichen-IDs kennt diese Installation nicht, die müssen von Hand weg.
async function removeMirror() {
    const { mirrorIds = [] } = await chrome.storage.local.get(['mirrorIds']);
    let entfernt = 0;

    for (const id of mirrorIds) {
        try {
            await chrome.bookmarks.removeTree(String(id));
            entfernt++;
        } catch (e) {
            // Knoten war schon weg
        }
    }

    const barChildren = await chrome.bookmarks.getChildren(BOOKMARKS_BAR_ID);
    for (const node of barChildren.filter((n) => !n.url && n.title === MIRROR_TITLE)) {
        await chrome.bookmarks.removeTree(node.id);
        entfernt++;
    }

    await chrome.storage.local.set({ mirrorIds: [], mirrorUrls: [], lastMode: null });
    return { entfernt };
}
