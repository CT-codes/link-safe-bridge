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
// Sie öffnet die App mit vorbefülltem Formular. Damit gelten Ordnerwahl,
// Pflichtfelder, ID-Vergabe und Sync unverändert — es gibt keine zweite Stelle,
// die das Datenmodell kennen müsste.

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

function openApp(url) {
    // Eigenes Fenster statt Tab — wie beim Bookmarklet: Speichern ist ein
    // kurzer Zwischenschritt, der den aktuellen Tab nicht verdrängen soll.
    chrome.windows.create({ url, type: 'popup', width: 900, height: 700 });
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
    });
    openApp(`${appBase}?${params.toString()}`);
});

document.getElementById('save-note').addEventListener('click', async () => {
    const appBase = await getAppBase();
    if (!appBase) {
        info.textContent = 'Erst die API-URL in den Optionen eintragen.';
        return;
    }
    openApp(`${appBase}?action=import&source=bookmarklet-note`);
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

// Die Prüfung läuft in einer eigenen Seite: das Popup schließt sich, sobald
// es den Fokus verliert — ein mehrminütiger Lauf würde darin abbrechen.
document.getElementById('check').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('check.html') });
    window.close();
});

document.getElementById('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
});

refreshStatus();
