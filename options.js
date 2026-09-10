// Optionen: API-URL + Token speichern, Host-Berechtigung anfordern, Verbindung
// testen — dazu die zwei Selbsthilfen für den Fall, dass etwas klemmt.

const apiUrlInput = document.getElementById('apiUrl');
const tokenInput = document.getElementById('token');
const directInput = document.getElementById('direct');
const inlineFavsInput = document.getElementById('inlineFavs');
const mirrorSecondaryInput = document.getElementById('mirrorSecondary');
const openInNewTabInput = document.getElementById('openInNewTab');
const saveInTabInput = document.getElementById('saveInTab');
const statusBox = document.getElementById('status');
const diagnoseBox = document.getElementById('diagnose-out');

chrome.storage.local
    .get(['apiUrl', 'token', 'directMode', 'inlineFavorites', 'mirrorSecondary', 'openInNewTab', 'saveInTab'])
    .then((s) => {
        if (s.apiUrl) apiUrlInput.value = s.apiUrl;
        if (s.token) tokenInput.value = s.token;
        directInput.checked = !!s.directMode;
        inlineFavsInput.checked = !!s.inlineFavorites;
        // Zweitablagen sind der Normalfall seit 1.2.0 — Vorgabe an
        mirrorSecondaryInput.checked = s.mirrorSecondary !== false;
        openInNewTabInput.checked = !!s.openInNewTab;
        saveInTabInput.checked = !!s.saveInTab;
    });

function show(text, ok) {
    statusBox.textContent = text;
    statusBox.className = ok ? 'ok' : 'err';
}

/**
 * Die Mittelklick-Hilfe braucht mehr als die API-Domain: "webNavigation", um die
 * Lesezeichen-Navigation überhaupt zu sehen, und Zugriff auf alle Seiten, um im
 * Tab den Verlauf zu messen (history.length).
 *
 * Die Frage kommt SOFORT beim Anhaken, nicht erst beim Speichern: Chrome
 * verlangt für permissions.request eine Nutzergeste, und ein Klick auf die
 * Checkbox ist eine. Wird abgelehnt, geht der Haken wieder weg — halb
 * aktiviert wäre schlimmer als gar nicht.
 */
openInNewTabInput.addEventListener('change', async () => {
    if (!openInNewTabInput.checked) return;
    const granted = await chrome.permissions.request({
        permissions: ['webNavigation'],
        origins: ['http://*/*', 'https://*/*'],
    });
    if (!granted) {
        openInNewTabInput.checked = false;
        show('Ohne die Berechtigung bleibt der Mittelklick beim Hintergrund-Tab.', false);
    } else {
        show('Berechtigung erteilt. Jetzt speichern — danach startet die Erweiterung einmal neu.', true);
    }
});

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
        mirrorSecondary: mirrorSecondaryInput.checked,
        openInNewTab: openInNewTabInput.checked,
        saveInTab: saveInTabInput.checked,
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
        await response.json(); // muss JSON sein — sonst antwortet da nicht die API

        // Hier stand bis 1.3.0 die Zahl aus `data.total`. Die zählt aber ALLE
        // Datensätze des Kontos seit Beginn: Tombstones gelöschter Links und
        // den Papierkorb eingeschlossen. Sie war deshalb um ein Vielfaches zu
        // hoch und veränderte sich nie nach unten. Die einzige belastbare Zahl
        // liefert der Sync selbst, wenn er durch ist — bis dahin keine.
        show('✓ Verbunden. Sync läuft …', true);

        // Warten, bis der Spiegel steht: erst danach kennt die Mittelklick-Hilfe die
        // Adressen, und erst danach darf neu gestartet werden.
        const sync = await chrome.runtime.sendMessage({ action: 'sync-now' });
        if (!sync?.ok) {
            show('Gespeichert, aber der Sync meldet: ' + (sync?.error || 'unbekannt'), false);
            return;
        }
        const bilanz = `${sync.links} aktive Links, ${sync.lesezeichen} Lesezeichen`;

        // Der Listener für webNavigation entsteht beim Start des Service
        // Workers. Wurde die Berechtigung gerade erst erteilt, ist ein Neustart
        // der sichere Weg — sonst griffe der Abfang erst irgendwann später.
        if (openInNewTabInput.checked) {
            show(`✓ Gespeichert und synchronisiert (${bilanz}). Erweiterung startet neu …`, true);
            setTimeout(() => chrome.runtime.reload(), 1200);
            return;
        }
        show(`✓ Gespeichert und synchronisiert — ${bilanz}.`, true);
    } catch (e) {
        show('Gespeichert, aber Verbindung fehlgeschlagen: ' + e.message, false);
    }
});

// --- Selbsthilfe ---

document.getElementById('diagnose').addEventListener('click', async () => {
    const s = await chrome.runtime.sendMessage({ action: 'nav-status' });
    if (!s?.ok) {
        diagnoseBox.textContent = 'Der Hintergrund antwortet nicht: ' + (s?.error || 'unbekannt');
        return;
    }

    const ja = (b) => (b ? '✓' : '✗');
    const kurz = (url) => (url && url.length > 62 ? url.slice(0, 59) + '…' : url || '');
    const zeilen = [
        `${ja(s.schalter)} Schalter „Mittelklick nach vorn" ist ${s.schalter ? 'an' : 'AUS'}`,
        `${ja(s.navPermission)} Berechtigung webNavigation`,
        `${ja(s.hostPermission)} Zugriff auf alle Seiten (damit Chrome die Navigationen meldet)`,
        `${ja(s.listener)} Listener im Hintergrund registriert`,
        `${ja(s.adressen > 0)} ${s.adressen} Adressen aus dem Spiegel bekannt`,
        `   letzter Sync: ${s.lastSyncTime ? new Date(s.lastSyncTime).toLocaleString('de-DE') : 'noch keiner'}`,
    ];
    if (s.beispiel) {
        zeilen.push(`   Beispieladresse: ${kurz(s.beispiel)}`);
    }

    // Woraus der Spiegel entstanden ist. „Doppelte verworfen" ist der Beleg,
    // dass die Seitenüberlappung greift: Ohne sie wären genau diese Einträge
    // zwischen zwei Seiten verschwunden. „Lücken" darf nur dann über 0 stehen,
    // wenn mehr als 100 Links in derselben Millisekunde geschrieben wurden —
    // dann fehlt wirklich etwas.
    const d = s.syncDetails;
    if (d) {
        zeilen.push('');
        zeilen.push('Letzter Sync:');
        zeilen.push(`   ${d.links} aktive Links → ${d.lesezeichen} Lesezeichen`);
        zeilen.push(`   ${d.seiten} Seiten geladen, ${d.doppelte} Doppelte verworfen`);
        if (d.uebersprungen > 0) {
            zeilen.push(`   ${d.uebersprungen} Links ohne gültige Adresse übersprungen`);
        }
        if (d.luecken > 0) {
            zeilen.push(`   ⚠ ${d.luecken} Lücke(n): über 100 Links teilen sich eine Millisekunde`);
        }
    }

    zeilen.push('');
    zeilen.push('Letzte Lesezeichen-Klicks:');
    if (!s.navLog?.length) {
        zeilen.push('   — noch nichts mitgeschnitten. Klick ein gespiegeltes');
        zeilen.push('     Lesezeichen mit der MITTLEREN Maustaste an und drück');
        zeilen.push('     diesen Knopf erneut.');
    } else {
        for (const e of s.navLog) {
            const uhr = new Date(e.zeit).toLocaleTimeString('de-DE');
            zeilen.push(`   ${uhr}  ${e.ergebnis}`);
            zeilen.push(`             Typ: ${e.typ} · im Spiegel: ${e.imSpiegel ? 'ja' : 'nein'}`);
            zeilen.push(`             ${kurz(e.url)}`);
            if (e.startUrl) {
                zeilen.push(`             kam von: ${kurz(e.startUrl)}`);
            }
            if (e.aehnliche?.length) {
                zeilen.push('             im Spiegel steht zu diesem Host:');
                for (const a of e.aehnliche) zeilen.push(`               ${kurz(a)}`);
            } else if (e.aehnliche) {
                zeilen.push('             zu diesem Host steht nichts im Spiegel');
            }
        }
    }
    diagnoseBox.textContent = zeilen.join('\n');
});

document.getElementById('removeMirror').addEventListener('click', async () => {
    const r = await chrome.runtime.sendMessage({ action: 'remove-mirror' });
    if (!r?.ok) {
        diagnoseBox.textContent = 'Fehlgeschlagen: ' + (r?.error || 'unbekannt');
        return;
    }
    diagnoseBox.textContent = `${r.entfernt} Eintrag/Einträge aus der Leiste entfernt. `
        + 'Der nächste Sync baut den Spiegel neu auf — oder gleich im Popup '
        + '„Jetzt synchronisieren" drücken.';
});
