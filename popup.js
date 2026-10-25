const info = document.getElementById('info');
const syncBtn = document.getElementById('sync');

async function refreshStatus() {
    const { lastStatus, lastSyncTime, lastSkipped } =
        await chrome.storage.local.get(['lastStatus', 'lastSyncTime', 'lastSkipped']);
    if (!lastStatus) {
        info.textContent = 'Noch kein Sync gelaufen. Zuerst die Optionen ausfüllen.';
        return;
    }
    const when = lastSyncTime ? new Date(lastSyncTime).toLocaleString('de-DE') : '';
    const lines = [lastStatus];
    if (typeof lastSkipped === 'number') {
        lines.push(`${lastSkipped} übersprungen${lastSkipped > 0 ? ' (ungültige URL)' : ''}`);
    }
    lines.push(`Stand: ${when}`);
    // #info hat white-space: pre-line — jede Zeile erscheint als eigene Zeile
    info.textContent = lines.join('\n');
}

// ===============================
// SPEICHERN — über die App, nicht über die API
// ===============================
//
// Der API-Token darf nur lesen (auth.php: Bearer gilt ausschließlich für GET),
// schreiben kann allein die Cookie-Session der App. Statt dafür einen
// Schreib-Token zu bauen, geht die Extension denselben Weg wie das Bookmarklet:
// Sie öffnet die Speicherseite der App (speichern.html, seit Link-Safe V2.31.0)
// mit vorbefüllten Feldern. Die speichert über dieselben Module wie das
// Formular der App — Ordnerwahl, Pflichtfelder, ID-Vergabe und Sync gelten
// unverändert, und es gibt keine zweite Stelle, die das Datenmodell kennen
// müsste.

// Aus "https://host/pfad/api/index.php" wird "https://host/pfad/" — die App
// liegt immer eine Ebene über ihrer API.
function appBaseFromApiUrl(apiUrl) {
    const url = new URL(apiUrl);
    const cut = url.pathname.indexOf('/api/');
    const base = cut >= 0 ? url.pathname.slice(0, cut + 1) : url.pathname.replace(/[^/]*$/, '');
    return url.origin + base;
}

async function getAppBase() {
    const { apiUrl } = await chrome.storage.local.get(['apiUrl']);
    if (!apiUrl) return null;
    try {
        return appBaseFromApiUrl(apiUrl);
    } catch (e) {
        return null;
    }
}

// Bis 1.3.1 öffnete die Extension die ganze App, und das Fenster musste
// 1280 Pixel breit sein, damit sie nicht in die Handyansicht rutschte. Die
// Speicherseite ist für ein kleines Fenster gebaut. Die Seite passt es danach
// selbst an: einmal genau aufs Formular, sobald sie fertig ist, und später wächst
// es mit (background.js, growSaveWindow). Die eingepasste Größe merkt sich die
// Bridge je Fensterart (saveWindowSizes) und öffnet das nächste Fenster gleich
// so — meist springt dann nichts mehr. Ohne gemerkte Größe startet es beim
// Link mit 980 × 830 (links der Ordnerbaum, rechts das Formular), bei der
// Notiz mit 560 × 760; dieselben Startgrößen nutzen die Bookmarklets der App.
// Alles gedeckelt auf den verfügbaren Bildschirm.
const FENSTER_LINK = { art: 'link', breite: 980, hoehe: 830 };
const FENSTER_NOTIZ = { art: 'note', breite: 560, hoehe: 760 };

async function openSavePage(url, fenster) {
    const { saveInTab = false, saveWindowSizes = {} } =
        await chrome.storage.local.get(['saveInTab', 'saveWindowSizes']);
    if (saveInTab) {
        // Ein Tab im normalen Browserfenster wird nie umgebaut. Erst im
        // Hintergrund öffnen und anmelden, dann nach vorn holen — mit dem
        // Tabwechsel schließt sich dieses Popup, die Anmeldung wäre sonst
        // womöglich nicht mehr unterwegs.
        const tab = await chrome.tabs.create({ url, active: false });
        if (fenster.art === 'link' && tab?.id != null) {
            try {
                await chrome.runtime.sendMessage({ action: 'watch-save-tab', tabId: tab.id });
            } catch (e) {
                // Dann wird die Kette im Symbol erst mit dem nächsten Sync grün
            }
        }
        await chrome.tabs.update(tab.id, { active: true });
        window.close();
        return;
    }

    const gemerkt = saveWindowSizes[fenster.art];
    const gueltig = (wert) => Number.isFinite(wert) && wert >= 300;
    const start = gemerkt && gueltig(gemerkt.width) && gueltig(gemerkt.height)
        ? { breite: gemerkt.width, hoehe: gemerkt.height }
        : fenster;

    const breite = Math.min(start.breite, screen.availWidth - 40);
    const hoehe = Math.min(start.hoehe, Math.max(500, screen.availHeight - 40));
    const win = await chrome.windows.create({
        url,
        type: 'popup',
        width: Math.round(breite),
        height: Math.round(hoehe),
        left: Math.round(screen.availLeft + (screen.availWidth - breite) / 2),
        top: Math.round(screen.availTop + (screen.availHeight - hoehe) / 2),
    });

    // Das Popup hier schließt sich gleich — das Mitwachsen übernimmt deshalb
    // der Hintergrund, und nur für genau dieses Fenster.
    const tabId = win?.tabs?.[0]?.id;
    if (tabId != null) {
        try {
            await chrome.runtime.sendMessage({
                action: 'watch-save-window', windowId: win.id, tabId, art: fenster.art,
            });
        } catch (e) {
            // Ohne Hintergrund bleibt es bei der Startgröße — gespeichert wird trotzdem
        }
    }
    window.close();
}

// Markierter Text schlägt die Meta-Beschreibung — wer etwas markiert hat, will
// genau das als Notiz am Link. Schlägt die Injektion fehl (keine Berechtigung,
// interne Seite), bleibt das Feld leer; gespeichert wird trotzdem.
async function pageDescription(tabId) {
    try {
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const selection = String(window.getSelection() || '').trim();
                const meta = document.querySelector('meta[name="description"]')?.content
                    || document.querySelector('meta[property="og:description"]')?.content
                    || '';
                return selection || meta;
            },
        });
        return typeof res?.result === 'string' ? res.result : '';
    } catch (e) {
        return '';
    }
}

// Liegt die Seite im Tab schon in Link-Safe? Dasselbe wie die grüne Kette im Symbol
// (background.js, Gespeichert-Anzeige), hier in Worten — und der Knopf sagt,
// was er dann tut. Den Stand kennt nur der Hintergrund; antwortet er nicht,
// bleibt das Popup wie bisher.
async function refreshSaved() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    let antwort;
    try {
        antwort = await chrome.runtime.sendMessage({ action: 'saved-info', url: tab.url });
    } catch (e) {
        return;
    }
    if (!antwort?.ok || !antwort.gespeichert) return;

    // Jeder Ordner in eine eigene Zeile — als Liste, dann sagt ein
    // Screenreader auch, wie viele es sind
    const zeile = document.createElement('p');
    const haken = document.createElement('span');
    haken.setAttribute('aria-hidden', 'true');
    haken.textContent = '✓ ';
    zeile.append(haken, 'Schon gespeichert in:');
    const liste = document.createElement('ul');
    const ordner = Array.isArray(antwort.ordner) && antwort.ordner.length ? antwort.ordner : ['Ohne Ordner'];
    for (const name of ordner) {
        const eintrag = document.createElement('li');
        eintrag.textContent = name;
        liste.append(eintrag);
    }
    const hinweis = document.getElementById('saved');
    hinweis.replaceChildren(zeile, liste);
    hinweis.hidden = false;
    const knopf = document.getElementById('save-page');
    knopf.textContent = '➕ Trotzdem speichern';
    // Wer den Knopf mit dem Screenreader ansteuert, hört das Wo gleich mit
    knopf.setAttribute('aria-describedby', 'saved');
}

document.getElementById('save-page').addEventListener('click', async () => {
    const appBase = await getAppBase();
    if (!appBase) {
        info.textContent = 'Erst die API-URL in den Optionen eintragen.';
        return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:\/\//i.test(tab.url || '')) {
        info.textContent = 'Diese Seite lässt sich nicht speichern (nur http/https).';
        return;
    }

    const params = new URLSearchParams({
        action: 'import',
        source: 'bookmarklet',
        title: tab.title || '',
        url: tab.url,
        description: await pageDescription(tab.id),
        // Sagt der Seite, dass die Bridge das Fenster vergrößert (nicht sie selbst)
        via: 'bridge',
    });
    openSavePage(`${appBase}speichern.html?${params.toString()}`, FENSTER_LINK);
});

document.getElementById('save-note').addEventListener('click', async () => {
    const appBase = await getAppBase();
    if (!appBase) {
        info.textContent = 'Erst die API-URL in den Optionen eintragen.';
        return;
    }
    openSavePage(`${appBase}speichern.html?action=import&source=bookmarklet-note&via=bridge`, FENSTER_NOTIZ);
});

syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Synchronisiere …';
    const result = await chrome.runtime.sendMessage({ action: 'sync-now' });
    if (!result?.ok) {
        info.textContent = 'Fehler: ' + (result?.error || 'unbekannt');
    } else {
        await refreshStatus();
    }
    syncBtn.disabled = false;
    syncBtn.textContent = '🔄 Jetzt synchronisieren';
});

document.getElementById('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
});

refreshStatus();
refreshSaved();
