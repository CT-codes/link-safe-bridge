# Link-Safe Lesezeichen-Spiegel (Chrome/Edge-Extension)

Spiegelt deine Link-Safe-Sammlung als Ordner **„Link-Safe"** in die
Lesezeichenleiste — einweg (Link-Safe → Browser), automatisch alle 15 Minuten.
Eigene Lesezeichen außerhalb dieses Ordners werden nie angefasst.

## Installation (entpackt laden)

1. Chrome/Edge öffnen → Adresszeile: `chrome://extensions` (Edge: `edge://extensions`)
2. Oben rechts **Entwicklermodus** aktivieren
3. **„Entpackte Erweiterung laden"** → diesen Ordner (`extension/`) auswählen
4. Extension-Icon anklicken → **Optionen öffnen**:
   - **API-URL**: lokal `http://localhost:8000/api/index.php`,
     später `https://deine-domain.de/api/index.php`
   - **Token**: der `api_token` aus `api/config.php`
5. **Speichern & Verbindung testen** — beim Speichern fragt der Browser einmalig
   nach der Berechtigung für die API-Domain
6. Der erste Sync startet sofort; danach alle 15 Minuten und jederzeit manuell
   über das Popup („Jetzt synchronisieren")

## Wie es funktioniert

- Der Service Worker holt alle aktiven Links (`GET /links`, Read-only-Token,
  Papierkorb wird übersprungen) und baut die Ordnerstruktur im
  Lesezeichen-Ordner „Link-Safe" komplett neu auf
- Der Token kann nur lesen — selbst wenn er in falsche Hände gerät,
  kann damit nichts verändert oder gelöscht werden. Deshalb schreibt auch die
  Link-Prüfung ihr Ergebnis nicht selbst zurück, sondern übergibt es der App

## Links prüfen (Link-Rot-Wächter)

Popup → **„🔍 Links prüfen"** öffnet die Prüfseite. Sie schickt an jeden Link
eine einzelne HTTP-Anfrage (HEAD, bei zickigen Servern GET mit sofort
verworfenem Rumpf), 20 gleichzeitig, 15 s Zeitlimit. **Es wird keine Seite
geöffnet und nichts gerendert** — kein Tab, kein fremdes JavaScript, kein
Eintrag im Verlauf.

Warum im Browser und nicht auf dem Server: Die Anfrage kommt von deiner
IP-Adresse, mit dem TLS-Fingerabdruck und User-Agent eines echten Browsers.
Bot-Schutz-Systeme wie Cloudflare antworten darauf deutlich seltener mit
HTTP 403 als auf Anfragen aus einem Rechenzentrum — im Prüflauf vom 19.07.2026
waren 198 der 279 „verdächtigen" Links genau solche Fehlalarme. Der Schalter
„Mit meinen Cookies prüfen" hilft zusätzlich dort, wo Seiten `SameSite=None`
setzen; strikt gesetzte Session-Cookies gibt der Browser an eine Extension
nicht heraus.

Vor dem ersten Lauf muss einmalig die Berechtigung für beliebige Seiten
erteilt werden (Knopf auf der Prüfseite) — ohne sie darf die Extension fremde
Domains nicht abrufen.

**Die Prüfseite muss während des Laufs offen bleiben.** Sie ist bewusst eine
eigene Seite und kein Service-Worker-Job: MV3-Worker werden nach ~30 s
Leerlauf beendet, ein Lauf über mehrere tausend Links überlebt das nicht.
Wird der Tab geschlossen, ist der Lauf verloren (kein Fortsetzen).

Das Ergebnis geht nicht in die Link-Datenbank der App, sondern in eine eigene
Datenbank derselben Origin (`LinkSafeCheck`). Ist gerade kein Link-Safe-Tab
offen, wartet es in `chrome.storage.local` und wird beim nächsten Öffnen der
App zugestellt. In Link-Safe dann unter **Einstellungen → Datenpflege →
„🔍 Prüfergebnisse übernehmen"** einspielen; erst dabei entstehen die
Markierungen an den Links, und nur so wandern sie über den Sync aufs
Zweitgerät.

## Option: Ordner direkt in der Leiste

In den Optionen lässt sich der „Link-Safe"-Überordner abschalten — dann liegen
die Hauptordner (und lose Links) direkt in der Lesezeichenleiste. Die Extension
merkt sich per Lesezeichen-ID, welche Einträge ihr gehören: Eigene Lesezeichen
und sogar eigene Ordner mit gleichem Namen bleiben unangetastet. Beim
Zurückschalten wird wieder der Überordner verwendet und die direkten Einträge
werden aufgeräumt.

## Grenzen (bewusst einfach gehalten)

- Einweg: Änderungen in der Lesezeichenleiste wandern NICHT zurück nach Link-Safe
- Der Spiegel-Ordner wird pro Sync neu erzeugt — eigene Lesezeichen sollten
  nicht IN den „Link-Safe"-Ordner gelegt werden (sie würden beim nächsten
  Sync entfernt)
