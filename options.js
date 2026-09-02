// Optionen: API-URL + Token speichern, Host-Berechtigung anfordern, Verbindung testen.

const apiUrlInput = document.getElementById('apiUrl');
const tokenInput = document.getElementById('token');
const directInput = document.getElementById('direct');
const inlineFavsInput = document.getElementById('inlineFavs');
const statusBox = document.getElementById('status');

chrome.storage.local.get(['apiUrl', 'token', 'directMode', 'inlineFavorites'])
    .then(({ apiUrl, token, directMode, inlineFavorites }) => {
        if (apiUrl) apiUrlInput.value = apiUrl;
        if (token) tokenInput.value = token;
        directInput.checked = !!directMode;
        inlineFavsInput.checked = !!inlineFavorites;
    });

function show(text, ok) {
    statusBox.textContent = text;
    statusBox.className = ok ? 'ok' : 'err';
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

    await chrome.storage.local.set({
        apiUrl,
        token,
        directMode: directInput.checked,
        inlineFavorites: inlineFavsInput.checked,
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
        show(`✓ Verbunden — ${count} Einträge gefunden. Sync läuft ab jetzt automatisch.`, true);
        chrome.runtime.sendMessage({ action: 'sync-now' });
    } catch (e) {
        show('Gespeichert, aber Verbindung fehlgeschlagen: ' + e.message, false);
    }
});
