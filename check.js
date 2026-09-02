// Link-Rot-Prüfung im Browser.
//
// Warum als Seite und nicht im Service Worker: MV3-Worker werden nach ~30 s
// Leerlauf beendet. Ein Lauf über mehrere tausend Links müsste sonst über
// Alarme gestückelt werden. Solange diese Seite offen ist, läuft der Lauf
// durch — dafür ist er beim Schließen des Tabs verloren (kein Fortsetzen).
//
// Geprüft wird mit einer einzelnen HTTP-Anfrage pro Link: HEAD, und nur wenn
// der Server damit erkennbar nicht umgehen kann, ein GET, dessen Rumpf sofort
// verworfen wird. Es wird nie eine Seite gerendert und kein fremdes Skript
// ausgeführt.
//
// Klassifikation wie im Standalone-Skript linkrot-check.php, mit einer
// bewussten Abweichung: fetch meldet Netzwerkfehler nur als undifferenzierten
// TypeError. DNS-Fehler, verweigerte Verbindung und Zertifikatsprobleme sind
// nicht auseinanderzuhalten. Solche Fälle landen deshalb auf 'verdaechtig'
// statt 'tot' — lieber ein lebender Link im Verdachtstopf als ein fälschlich
// totgesagter. Nur ein Timeout gilt sicher als 'tot'.

const POOL_SIZE = 20;       // gleichzeitige Prüfungen
const TIMEOUT_MS = 15000;   // pro Link, wie im PHP-Skript

const el = (id) => document.getElementById(id);
const ALL_HOSTS = { origins: ['http://*/*', 'https://*/*'] };

let abbrechen = false;
let letztesErgebnis = null;

// ===============================
// BERECHTIGUNG
// ===============================

async function refreshPermission() {
    const granted = await chrome.permissions.contains(ALL_HOSTS);
    const status = el('permStatus');
    status.textContent = granted
        ? 'Erteilt — die Prüfung kann laufen.'
        : 'Fehlt noch. Ohne diese Berechtigung darf die Extension fremde Seiten nicht abrufen.';
    status.className = 'status ' + (granted ? 'ok' : 'err');
    el('grant').disabled = granted;
    el('start').disabled = !granted;
    return granted;
}

el('grant').addEventListener('click', async () => {
    // Muss aus einer Nutzeraktion heraus passieren, sonst lehnt Chrome ab
    await chrome.permissions.request(ALL_HOSTS);
    await refreshPermission();
});

// ===============================
// PRÜFUNG
// ===============================

// Liefert { status, detail } — status: 'ok' | 'tot' | 'verdaechtig' | 'retry'
function classify(httpCode, wasHead) {
    if (httpCode >= 200 && httpCode < 400) return { status: 'ok', detail: `HTTP ${httpCode}` };

    if (httpCode === 404 || httpCode === 410) {
        // Manche Server beantworten HEAD fälschlich mit 404 → mit GET nachprüfen
        return wasHead ? { status: 'retry' } : { status: 'tot', detail: `HTTP ${httpCode}` };
    }
    if ([400, 405, 406, 501].includes(httpCode)) {
        return wasHead ? { status: 'retry' } : { status: 'verdaechtig', detail: `HTTP ${httpCode}` };
    }
    if ([401, 403, 429].includes(httpCode)) {
        return { status: 'verdaechtig', detail: `HTTP ${httpCode} (Login/Bot-Schutz?)` };
    }
    if (httpCode >= 500) return { status: 'verdaechtig', detail: `HTTP ${httpCode} (Serverfehler)` };
    return { status: 'verdaechtig', detail: `HTTP ${httpCode}` };
}

function normalizeUrl(raw) {
    const url = String(raw || '').trim();
    if (!url) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url;
    if (!/^https?:\/\//i.test(withScheme)) return null; // javascript:, file:, …
    try {
        new URL(withScheme);
        return withScheme;
    } catch (e) {
        return null;
    }
}

// Ein einzelner Abruf. Wirft bei Netzwerkfehler/Timeout, sonst HTTP-Status.
async function probe(url, { head, cookies }) {
    const res = await fetch(url, {
        method: head ? 'HEAD' : 'GET',
        redirect: 'follow',
        credentials: cookies ? 'include' : 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Bei GET ist der Rumpf noch nicht gelesen — Stream sofort verwerfen,
    // damit nur die Kopfzeilen über die Leitung gehen.
    if (!head) {
        try { await res.body?.cancel(); } catch (e) { /* schon geschlossen */ }
    }
    return res.status;
}

async function pruefeEinen(ziel, optionen) {
    const url = normalizeUrl(ziel.url);
    if (!url) {
        return { ...ziel, status: 'verdaechtig', detail: 'Keine prüfbare URL' };
    }

    const versuche = [{ url, head: true }, { url, head: false }];
    // http:// kann der Browser aus dem Extension-Kontext als Mixed Content
    // blocken. Dann bleibt der Versuch über https die einzige Aussage.
    if (optionen.upgradeHttp && url.startsWith('http://')) {
        versuche.push({ url: 'https://' + url.slice(7), head: true });
    }

    let letzterFehler = null;
    for (const versuch of versuche) {
        try {
            const code = await probe(versuch.url, { head: versuch.head, cookies: optionen.cookies });
            const ergebnis = classify(code, versuch.head);
            if (ergebnis.status !== 'retry') {
                return { ...ziel, url, status: ergebnis.status, detail: ergebnis.detail };
            }
            // 'retry' → nächster Versuch der Liste (GET)
        } catch (e) {
            letzterFehler = e;
            if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
                return { ...ziel, url, status: 'tot', detail: `Timeout nach ${TIMEOUT_MS / 1000}s` };
            }
            // Netzwerkfehler: weiter zum nächsten Versuch (GET bzw. https)
        }
    }

    return {
        ...ziel,
        url,
        status: 'verdaechtig',
        detail: letzterFehler
            ? 'Nicht erreichbar (DNS, Verbindung oder Zertifikat)'
            : 'Unklare Antwort',
    };
}

// Einfacher Worker-Pool: POOL_SIZE Läufer holen sich reihum das nächste Ziel.
async function pruefeAlle(ziele, optionen, onProgress) {
    const ergebnisse = new Array(ziele.length);
    let naechster = 0;
    let fertig = 0;

    const laeufer = async () => {
        while (!abbrechen) {
            const index = naechster++;
            if (index >= ziele.length) return;
            ergebnisse[index] = await pruefeEinen(ziele[index], optionen);
            fertig++;
            if (fertig % 5 === 0 || fertig === ziele.length) onProgress(fertig);
        }
    };

    await Promise.all(Array.from({ length: Math.min(POOL_SIZE, ziele.length) }, laeufer));
    onProgress(fertig);
    return ergebnisse.filter(Boolean);
}

// ===============================
// ABLAUF
// ===============================

function setRunStatus(text, klasse = '') {
    const box = el('runStatus');
    box.textContent = text;
    box.className = 'status ' + klasse;
}

function setProgress(done, total) {
    const prozent = total > 0 ? Math.round((done / total) * 100) : 0;
    el('barFill').style.width = prozent + '%';
    setRunStatus(`Geprüft: ${done} / ${total} (${prozent} %)`);
}

el('stop').addEventListener('click', () => {
    abbrechen = true;
    setRunStatus('Abbruch angefordert — laufende Anfragen werden noch zu Ende geführt …');
});

el('start').addEventListener('click', async () => {
    abbrechen = false;
    letztesErgebnis = null;
    el('start').disabled = true;
    el('stop').disabled = false;
    el('deliver').disabled = true;
    el('summary').style.display = 'none';
    setRunStatus('Lade Links aus Link-Safe …');

    try {
        const antwort = await chrome.runtime.sendMessage({ action: 'fetch-check-targets' });
        if (!antwort?.ok) throw new Error(antwort?.error || 'Links konnten nicht geladen werden.');

        const ziele = antwort.targets.filter((z) => z.url);
        if (ziele.length === 0) {
            setRunStatus('Keine Links zum Prüfen gefunden.', 'err');
            return;
        }

        setProgress(0, ziele.length);
        const optionen = {
            cookies: el('useCookies').checked,
            upgradeHttp: el('upgradeHttp').checked,
        };
        const start = Date.now();
        const ergebnisse = await pruefeAlle(ziele, optionen, (done) => setProgress(done, ziele.length));

        const auffaellig = ergebnisse
            .filter((e) => e.status === 'tot' || e.status === 'verdaechtig')
            .map((e) => ({ id: e.id, url: e.url, status: e.status, detail: e.detail }));
        const okIds = ergebnisse.filter((e) => e.status === 'ok').map((e) => e.id);

        letztesErgebnis = {
            generatedAt: Date.now(),
            checked: ergebnisse.length,
            auffaellig,
            okIds,
        };

        el('sumOk').textContent = okIds.length;
        el('sumDead').textContent = auffaellig.filter((e) => e.status === 'tot').length;
        el('sumSuspect').textContent = auffaellig.filter((e) => e.status === 'verdaechtig').length;
        el('summary').style.display = 'flex';

        const dauer = Math.round((Date.now() - start) / 1000);
        setRunStatus(
            (abbrechen ? 'Abgebrochen — ' : 'Fertig — ')
            + `${ergebnisse.length} von ${ziele.length} Links in ${dauer} s geprüft.`,
            'ok'
        );

        await uebergeben();
    } catch (e) {
        setRunStatus('Fehler: ' + e.message, 'err');
    } finally {
        el('start').disabled = false;
        el('stop').disabled = true;
        el('deliver').disabled = !letztesErgebnis;
    }
});

// ===============================
// ÜBERGABE
// ===============================

async function uebergeben() {
    if (!letztesErgebnis) return;
    const box = el('deliverStatus');
    box.className = 'status';
    box.textContent = 'Übergebe an die App …';

    try {
        const antwort = await chrome.runtime.sendMessage({
            action: 'deliver-results',
            payload: letztesErgebnis,
        });
        if (!antwort?.ok) throw new Error(antwort?.error || 'unbekannter Fehler');

        if (antwort.zugestellt) {
            box.className = 'status ok';
            box.textContent = 'Übergeben. In Link-Safe unter Einstellungen → Datenpflege übernehmen.';
        } else {
            box.className = 'status';
            box.textContent = `Ergebnis liegt bereit (${antwort.grund}). `
                + 'Es wird automatisch übergeben, sobald du Link-Safe im Browser öffnest.';
        }
    } catch (e) {
        box.className = 'status err';
        box.textContent = 'Übergabe fehlgeschlagen: ' + e.message;
    }
}

el('deliver').addEventListener('click', uebergeben);

refreshPermission();
