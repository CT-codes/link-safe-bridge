# Link-Safe Bridge (Chrome/Edge-Extension)

Die Browser-Erweiterung zu [Link-Safe](https://link-safe.taenzer.net). Sie kann viererlei:

- **Spiegeln:** deine Link-Safe-Sammlung als Ordner in der Lesezeichenleiste —
  einweg (Link-Safe → Browser), automatisch bei jedem Browserstart
- **Speichern:** die aktuelle Seite oder eine schnelle Notiz nach Link-Safe geben
- **Erkennen:** die Kette im Symbol wird grün, wenn die offene Seite schon in
  Link-Safe liegt
- **Prüfen:** die Sammlung auf tote Links testen (Link-Rot-Wächter)

Eigene Lesezeichen außerhalb des gespiegelten Ordners werden nie angefasst.

## Installation (entpackt laden)

1. Diesen Ordner herunterladen (grüner Knopf **Code → Download ZIP**) und entpacken
2. Chrome/Edge öffnen → Adresszeile: `chrome://extensions` (Edge: `edge://extensions`)
3. Oben rechts **Entwicklermodus** aktivieren
4. **„Entpackte Erweiterung laden"** → den entpackten Ordner auswählen
5. Extension-Icon anklicken → **Optionen öffnen**:
   - **API-URL**: lokal `http://localhost:8000/api/index.php`,
     sonst `https://deine-domain.de/api/index.php`
   - **Token**: der `api_token` aus `api/config.php`
6. **Speichern & Verbindung testen** — beim Speichern fragt der Browser einmalig
   nach der Berechtigung für die API-Domain
7. Der erste Sync startet sofort; danach bei jedem Browserstart und jederzeit manuell
   über das Popup („Jetzt synchronisieren")

## Wie das Spiegeln funktioniert

- Der Service Worker holt alle aktiven Links (`GET /links`, Read-only-Token,
  Papierkorb wird übersprungen) und baut die Ordnerstruktur im
  Lesezeichen-Ordner „Link-Safe" komplett neu auf
- Das geschieht bei jedem Browserstart und auf Knopfdruck, sonst nicht —
  bis 1.5.0 lief es zusätzlich alle 15 Minuten. Was zwischendurch in der App
  geändert wird, kommt mit dem nächsten Start oder über „Jetzt synchronisieren"
- Der Token kann nur lesen — selbst wenn er in falsche Hände gerät,
  kann damit nichts verändert oder gelöscht werden. Deshalb schreibt auch die
  Link-Prüfung ihr Ergebnis nicht selbst zurück, sondern übergibt es der App

### Zweitablagen (Mehrfach-Ablage)

Ein Link kann in Link-Safe in mehreren Ordnern gleichzeitig liegen. Die Extension
legt ihn dann in **jedem** dieser Ordner als Lesezeichen an — dieselbe Adresse
mehrfach, so wie es die App zeigt. Wer das nicht will, hakt in den Optionen
*„Zweitablagen mitspiegeln"* ab; dann erscheint jeder Link nur an seinem
Hauptort, wie bis Version 1.1.0.

## Seiten und Notizen speichern

Im Popup:

- **„➕ Diese Seite speichern"** übernimmt Titel und Adresse des aktuellen Tabs.
  Ist auf der Seite Text markiert, wandert er als Notiz mit; sonst die
  Meta-Beschreibung der Seite.
- **„📝 Notiz schreiben"** öffnet direkt eine leere Notiz.

Beides öffnet ein kleines Fenster mit der **Speicherseite** von Link-Safe,
vorbefüllt mit den Daten des Tabs. Sobald die Seite fertig ist (Ordner,
Dublette und Anmeldung geprüft), passt sich das Fenster einmal genau auf das
Formular ein — auch kleiner — und merkt sich diese Größe fürs nächste Mal.
Danach wächst es nur noch mit, etwa bei „Neuer Ordner"; es schrumpft nie
wieder und geht nie über den Bildschirm hinaus. Wer es von Hand kleiner
zieht, behält seine Größe. Ohne gemerkte Größe startet es beim Link mit
980 × 830, bei der Notiz mit 560 × 760:

- Titel, Adresse, Ordner und Notiz; Favicon und Vorschaubild der Seite
  holt Link-Safe im Hintergrund und speichert sie mit
- Der Ordner wird mit derselben Suche gewählt wie in der App; die zuletzt
  benutzten Ordner stehen als Schnellwahl darunter. Ein neuer Ordner lässt
  sich direkt anlegen, weitere Ablageorte kommen über „+ auch hier ablegen"
  dazu
- Links steht der Ordnerbaum wie in der Seitenleiste der App — zum
  Stöbern, wenn einem der Name eines Ordners nicht einfällt. Klick auf einen
  Ordner macht ihn zum Ablageort, ⊕ legt den Link zusätzlich dort ab
- Ist der Link schon gespeichert, steht das sofort da, samt Ordner
- Nach dem Speichern lädt die Seite sofort hoch und schließt sich; gelingt
  das Hochladen nicht, bleibt sie offen und sagt es

Gespeichert wird in der App, nicht von der Extension. Das hat einen Grund:
Der API-Token darf ausschließlich lesen, schreiben kann nur die angemeldete
App. So bleiben Ordnerwahl, Pflichtfelder und der Sync genau dort, wo sie
hingehören, und die Extension muss das Datenmodell nicht kennen.

**Braucht Link-Safe ab V2.31.0** — ältere Versionen haben keine
Speicherseite. Bis 1.3.1 öffnete die Extension die ganze App mit
aufgeklapptem Formular in einem 1280 Pixel breiten Fenster.

Wer lieber im gewohnten Fenster arbeitet, hakt in den Optionen
*„Speichern-Fenster als normalen Tab öffnen"* an.

## Grüne Kette im Symbol: Seite schon gespeichert

Das Symbol der Extension ist eine dünne Kette auf fast schwarzem Grund. Liegt
die Seite im offenen Tab schon in Link-Safe, wird die Kette **grün** statt
blau. Weil das Symbol den Zustand nur über die Farbe zeigt, sagt es der
Tooltip in Worten und nennt die Ordner dazu. Das Popup zeigt oben
„✓ Schon gespeichert in:" mit jedem Ordner in einer eigenen Zeile, und der
Knopf heißt dann **„➕ Trotzdem speichern"**.

- Verglichen wird wie auf der Speicherseite: ohne `https://`, ohne `www.`,
  ohne Schrägstrich am Ende und ohne Tracking-Parameter (`utm_…`, `fbclid` …)
- Der Abgleich läuft lokal gegen die Liste, die der Sync ohnehin lädt —
  keine Adresse verlässt dafür den Browser
- Nach dem Speichern über die Extension wird die Kette grün, sobald sich die
  Speicherseite schließt. Was in der App oder auf einem anderen Gerät
  gespeichert, verschoben oder gelöscht wird, zeigt das Symbol mit dem
  nächsten Sync (beim nächsten Browserstart, oder sofort über „Jetzt synchronisieren")
- Nur für Links auf http/https-Seiten; Notizen und der Papierkorb zählen
  nicht mit. Leitet eine Seite auf eine andere Adresse um, ist die Kette nur
  an der Adresse grün, die gespeichert ist
- Die Farben heben sich auf hellen wie dunklen Browserleisten ab: blaue
  Kette `#4f8fd0` und grüne `#4cc764` auf dem Grund `#16181d` mit 5,2 : 1
  bzw. 8,2 : 1

Dafür braucht die Extension seit 1.5.0 die Berechtigung `tabs`: Mit ihr
erfährt sie die Adresse eines Tabs, ohne dass man vorher aufs Symbol klickt.
Die Adressen bleiben in der Extension.

## Mittelklick holt den neuen Tab nach vorn

Optional (Schalter in den Optionen): Ein **Mittelklick** auf ein gespiegeltes
Lesezeichen öffnet die Seite in einem neuen Tab, der sofort im Vordergrund
liegt. Der Linksklick bleibt unverändert und öffnet wie gewohnt im selben Tab;
eigene Lesezeichen fasst die Extension nie an.

Chrome macht dabei die halbe Arbeit schon selbst: Der Mittelklick öffnet
ohnehin einen neuen Tab — nur eben im Hintergrund. Zu tun bleibt, ihn nach vorn
zu holen. Dass der Klick aus der Lesezeichenleiste kam, erkennt die Extension
an der ausgelösten Navigation (`webNavigation`, Übergangstyp `auto_bookmark`);
ein Mittelklick auf einen Link *innerhalb* einer Seite meldet `link` und bleibt
deshalb im Hintergrund, wo er hingehört.

Bis Version 1.2.4 wurde stattdessen der Linksklick abgefangen: neuer Tab
daneben, alter Tab wieder zurück. Das kostete ein sichtbares Anladen im alten
Tab, einen halben Seitenaufruf beim Ziel und eine Verlaufsmessung per
Skript-Injektion — und aus einem leeren neuen Tab heraus konnte es gar nicht
greifen. Über den Mittelklick fällt das alles weg: Die Seite lädt genau einmal,
im richtigen Tab.

Die Lesezeichen bleiben dabei echte Lesezeichen: richtige Adresse, Favicon,
„Link-Adresse kopieren". Der Schalter fragt beim Speichern die Berechtigungen
`webNavigation` und Zugriff auf alle Seiten ab — Letzteres, damit Chrome die
Navigationen überhaupt meldet.

## Wenn etwas klemmt

Unten in den Optionen stehen zwei Knöpfe:

- **„Mittelklick prüfen"** sagt in Klartext, welche der fünf Bedingungen fehlt:
  Schalter an, Berechtigung `webNavigation`, Zugriff auf alle Seiten, Listener
  im Hintergrund registriert, Adressen aus dem Spiegel bekannt. Darunter steht
  ein **Mitschnitt der letzten Lesezeichen-Klicks** samt Übergangstyp, den
  Chrome gemeldet hat, und dem Grund, warum der Tab nach vorn geholt wurde oder
  eben nicht.
- **„Spiegel aus der Leiste entfernen"** räumt den Ordner „Link-Safe" (auch
  mehrfach vorhandene) und alles weg, was *diese* Installation direkt auf die
  Leiste gelegt hat. Der nächste Sync baut alles neu auf.

**Mehrere Kopien der Sammlung in der Leiste?** Das passiert, wenn zwei
Installationen nebeneinander synchronisiert haben — etwa eine alte und eine neu
geladene Kopie der Erweiterung. Seit 1.2.2 führt jeder Sync mehrfach vorhandene
„Link-Safe"-Ordner wieder zusammen und meldet das im Popup. Was eine **andere**
Installation im Direkt-Modus lose auf die Leiste gelegt hat, erkennt diese hier
nicht: Sie kennt deren Lesezeichen-IDs nicht. Solche Reste müssen von Hand weg
(Lesezeichen-Manager mit `Strg`+`Umschalt`+`O`).

## Links prüfen (Link-Rot-Wächter)

Optionen → **„🔍 Links prüfen"** öffnet die Prüfseite (bis 1.5.0 saß der Knopf
im Popup). Sie schickt an jeden Link eine einzelne HTTP-Anfrage (HEAD, bei
zickigen Servern GET mit sofort verworfenem Rumpf), 20 gleichzeitig, 15 s
Zeitlimit. **Es wird keine Seite
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
- Gespeichert wird immer über ein Fenster der App, nie direkt aus dem Popup
- Innerhalb eines Ordners stehen die Lesezeichen alphabetisch, nicht in der
  eigenen Reihenfolge aus der App

## Symbol und Lizenz

Die Kette im Symbol ist das Symbol „link" aus
[Feather Icons](https://github.com/feathericons/feather), für die Extension
auf eine dunkle Kachel gesetzt und eingefärbt. Feather Icons steht unter der
MIT-Lizenz; sie erlaubt die Nutzung, wenn der folgende Hinweis mitgeliefert
wird.

<details>
<summary>MIT-Lizenz von Feather Icons</summary>

```
The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

</details>
