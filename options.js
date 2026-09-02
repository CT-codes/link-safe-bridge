// Optionen: API-URL + Token speichern, Host-Berechtigung anfordern, Verbindung testen.

const apiUrlInput = document.getElementById('apiUrl');
const tokenInput = document.getElementById('token');
const directInput = document.getElementById('direct');
const inlineFavsInput = document.getElementById('inlineFavs');
const mirrorSecondaryInput = document.getElementById('mirrorSecondary');
const openInNewTabInput = document.getElementById('openInNewTab');
const statusBox = document.getElementById('status');

chrome.storage.local.get(['apiUrl', 'token', 'directMode', 'inlineFavorites', 'mirrorSecondary', 'openInNewTab'])
    .then(({ apiUrl, token, directMode, inlineFavorites, mirrorSecondary, openInNewTab }) => {
        if (apiUrl) apiUrlInput.value = apiUrl;
        if (token) tokenInput.value = token;
        directInput.checked = !!directMode;
        inlineFavsInput.checked = !!inlineFavorites;
        // Zweitablagen sind der Normalfall seit 1.2.0 — Vorgabe an
        mirrorSecondaryInput.checked = mirrorSecondary !== false;
        openInNewTabInput.checked = !!openInNewTab;
    });

function show(text, ok) {
    statusBox.textContent = text;
    statusBox.className = ok ? 'ok' : 'err';
}

/**
 * Der Klick-Abfang braucht mehr als die API-Domain: "webNavigation", um die
 * Lesezeichen-Navigation überhaupt zu sehen, und Zugriff auf alle Seiten, um im
 * Tab den Verlauf zu messen (history.length). Wird das abgelehnt, bleibt der
 * Schalter aus — halb aktiviert wäre schlimmer als gar nicht.
 */
async function ensureNavigationPermissions() {
    const granted = await chrome.permissions.request({
        permissions: ['webNavigation'],
        origins: ['http://*/*', 'https://*/*'],
    });
    if (!granted) {
        openInNewTabInput.checked = false;
    }
    return granted;
}

document.getElementById('save').addEventListener('click', async () => {
    const apiUrl = apiUrlInput.value.trim().replace(/\/+$/, '');
    const token = tokenInput.value.trim();

    if (!apiUrl || !token) {
        show('Bitte API-URL und Token ausfüllen.', false);
        return;
    }

    let origin;
    try {
        origin = new URL(apiUrl).origin + '/*';
    } catch (e) {
        show('Das ist keine gültige URL.', false);
        return;
    }

    // Host-Berechtigung nur für die eingetragene API-Domain anfordern
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
        show('Zugriff auf ' + origin + ' wurde nicht erlaubt.', false);
        return;
    }

    let navigationOk = true;
    if (openInNewTabInput.checked) {
        navigationOk = await ensureNavigationPermissions();
    }

    await chrome.storage.local.set({
        apiUrl,
        token,
        directMode: directInput.checked,
        inlineFavorites: inlineFavsInput.checked,
        mirrorSecondary: mirrorSecondaryInput.checked,
        openInNewTab: openInNewTabInput.checked,
    });

    // Verbindungstest
    try {
        const response = await fetch(`${apiUrl}/links?since=0`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
            show(`Gespeichert, aber die API meldet HTTP ${response.status} — Token prüfen.`, false);
            return;
        }
        const data = await response.json();
        // total = echte Gesamtzahl vom Server; items ist nur die erste Seite (100)
        const count = typeof data.total === 'number' ? data.total : data.items.length;
        const nachsatz = navigationOk
            ? ''
            : ' Der Klick-Abfang bleibt aus: die Berechtigung wurde abgelehnt.';
        show(`✓ Verbunden — ${count} Einträge gefunden. Sync läuft ab jetzt automatisch.${nachsatz}`, navigationOk);
        chrome.runtime.sendMessage({ action: 'sync-now' });
    } catch (e) {
        show('Gespeichert, aber Verbindung fehlgeschlagen: ' + e.message, false);
    }
});
