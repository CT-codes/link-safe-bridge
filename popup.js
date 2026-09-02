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
