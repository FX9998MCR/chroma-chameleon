# Chroma Chameleon

Online-Multiplayer-Versteckspiel im Browser, in 3D aus der Verfolgerperspektive.
**Chamäleons** sind weiße Mannequins, die sich mit Pinsel und Pipette selbst anmalen,
bis sie mit Wand, Boden oder Objekt verschmelzen – und mit einer Pose ihre Silhouette
brechen. **Sucher** laufen durch die Arena, schauen genau hin und markieren mit dem
Farbmarkierer, was ihnen verdächtig vorkommt. Wer getroffen wird, sucht mit.

- 2 – 24 Spieler pro Raum, private Räume per Code oder öffentliches Schnellspiel
- Tarnung ist **rein visuell**: Der Server versteckt niemanden. Ob man dich sieht,
  entscheidet allein deine Bemalung, deine Pose und dein Stillstand – wie im Vorbild.
- Third-Person-Kamera, Maussteuerung, Malmodus mit Pinsel direkt auf dem Körper
- Server-autoritative Bewegung und Treffer, Wände sind echte 3D-Hindernisse
- Prozedurale Low-Poly-Figuren und Arena, kein Download, keine Konten, keine Tracker

## Allein spielen

Im Menü **„Solo-Training mit 3 Bots"** wählen – das Spiel startet sofort mit
KI-Mitspielern. In jeder privaten Lobby kann der Host mit **+ Bot / − Bot** Bots
hinzufügen. Chamäleon-Bots suchen ein Versteck an einer Mauer oder im Gebüsch, malen
sich in deren Farbe, nehmen eine Pose ein und fliehen, wenn ein Sucher zu nah kommt.
Sucher-Bots patrouillieren und „sehen" nur mit Sichtlinie – und mit einer
Wahrscheinlichkeit, die von Farbabweichung zum Hintergrund, Abstand, Pose und Bewegung
abhängt. Ein gut bemaltes, stilles Chamäleon übersehen sie meistens; ein weißes
oder zappelndes nicht.

## Schnellstart

```bash
npm install
npm start          # http://localhost:3000
```

Zum Spielen mit anderen den Server auf einem erreichbaren Rechner starten (siehe
[Deployment](#deployment)) und den Einladungslink aus der Lobby teilen
(`https://dein-server/?raum=CODE`).

## Spielregeln

Jede Runde hat drei Phasen:

| Phase | Dauer | Was passiert |
|---|---|---|
| Verstecken & Anmalen | 15 s | Chamäleons suchen ein Versteck und malen sich an. Sucher stehen mit verbundenen Augen am Startpunkt. |
| Suche | 150 s | Sucher werden freigelassen. Wer getroffen wird, wird nach 3 s selbst Sucher. Malen bleibt erlaubt – aber wer malt, steht still. |
| Auswertung | 8 s | Punktetafel, danach beginnt automatisch die nächste Runde mit neuen Rollen. |

**Chamäleons gewinnen**, wenn beim Ablauf der Zeit noch mindestens eines unentdeckt ist.
**Sucher gewinnen**, wenn alle gefunden sind. Ein Sucher je angefangene vier Spieler;
wer zuletzt am seltensten Sucher war, kommt zuerst dran.

### Anmalen

`F` öffnet den Malmodus. Die Figur friert ein, der Cursor wird frei, die Kamera kreist um
dich (rechte Maustaste zieht sie herum).

1. Cursor auf eine Wand, den Boden oder ein Objekt halten und **Leertaste** drücken:
   die Pipette übernimmt genau diese Farbe.
2. Mit gehaltener **linker Maustaste** über den eigenen Körper streichen. Jede Seite
   jedes Körperteils lässt sich einzeln bemalen – Vorderseite hell, Schattenseite dunkler.
3. **Helligkeit** verschiebt den Farbton für Licht- und Schattenseiten, **Pinsel**
   (auch Mausrad) ändert die Größe. **Ganz füllen** legt die Farbe über alles,
   **Rückgängig** nimmt den letzten Strich zurück, **Weiß** löscht.
4. `F` oder **Fertig** beendet das Malen. Die Textur wird an alle Mitspieler übertragen.

Eine einzige flache Farbe wirkt oft wie aufgeklebt. Wer die dem Licht zugewandte Seite
heller und die Schattenseite dunkler malt und sich dann *vor* die passende Fläche stellt,
ist praktisch unsichtbar.

### Posen

`R` schaltet durch: Stehen, Hocken, Sitzen, Liegen, Wandpresse, Kugel. Eine Pose
verändert die Silhouette – und die Trefferzone: Liegende Figuren sind nur 35 cm hoch.
Jede Bewegung löst die Pose.

### Steuerung

| Taste | Chamäleon | Sucher |
|---|---|---|
| Maus | umschauen (Klick fängt die Maus, `Esc` gibt sie frei) | umschauen |
| `W A S D` | laufen, relativ zur Blickrichtung | laufen |
| `Shift` | sprinten (Ausdauer, hinterlässt **Farbspur** in deiner Durchschnittsfarbe) | **Dash** – kurzer Schub, 7 s |
| `F` | **Malmodus** an/aus | – |
| `Leertaste` | Pipette (im Malmodus) | – |
| `R` | **Pose** wechseln | – |
| `Q` | **Köder**: eine bemalte, posierende Kopie von dir – wer sie trifft, ist 1,6 s benommen (24 s) | – |
| Linke Maustaste | malen (im Malmodus) | **Farbmarkierer**: Treffer = gefunden (1 s, 16 m Reichweite) |
| `Tab` | Punktetafel | Punktetafel |
| `Enter` | Chat | Chat |

### Punkte

| Ereignis | Punkte |
|---|---|
| Chamäleon: je unentdeckte Sekunde | 1 |
| Chamäleon: Runde überstanden | 120 |
| Chamäleon: als Letztes übrig | +80 |
| Chamäleon: Köder hat einen Sucher reingelegt | 45 |
| Sucher: ein Chamäleon gefunden | 90 |

## Architektur

```
server/index.js    HTTP-Server für Spieldateien + WebSocket-Server, Räume, Ratenbegrenzung
server/room.js     Ein Raum: Beitritt, Lobby, Chat, Snapshot-Versand im 20-Hz-Takt
server/game.js     Autoritative Simulation: Phasen, Rollen, Schuss-Hitscan, Posen, Köder
server/bots.js     KI-Mitspieler: Wegfindung, Verstecken + Anmalen, Wahrnehmungsmodell
shared/constants.js  Alle Spielwerte an einer Stelle (Tempo, Abklingzeiten, Punkte …)
shared/map.js        Arena-Generator (deterministisch per Seed) + Kachel-Hilfen
shared/physics.js    Bewegung relativ zur Blickrichtung, Kollision, 3D-Strahlen gegen Mauern,
                     Zylinder-Treffer – identisch auf Server und Client
public/js/main.js    Menü, Lobby, Spielschleife, Client-Vorhersage der eigenen Bewegung
public/js/render.js  Three.js-Szene, Third-Person-Kamera mit Wandausweichen, Figuren, Effekte
public/js/models.js  Mannequin aus Quadern mit Textur-Atlas (jede Fläche einzeln bemalbar), Posen
public/js/paint.js   Malmodus: Pinsel, Pipette, Helligkeit, Rückgängig, PNG-Sync
public/js/world.js   Arena aus der Karte: Boden, farbige Mauern, Büsche, Wasser, Farb-Pipette
public/js/hud.js     DOM-Anzeige, Meldungen, Tafeln, Chat
public/js/audio.js   Synthetische Soundeffekte per WebAudio
test/                node:test – Karte, Physik, Spielregeln, Server-Integration
```

**Netzcode.** Der Client schickt 30-mal pro Sekunde Tasten, Blickrichtung und einmalige
Aktionen. Der Server simuliert mit 20 Hz und sendet jedem Spieler einen Snapshot. Die
eigene Figur wird lokal vorhergesagt; Mitspieler werden mit 110 ms Puffer interpoliert.

**Bemalung.** Jede Figur trägt eine 512×512-Textur (Atlas: 11 Körperteile × 6 Flächen).
Der Client malt auf ein Canvas und schickt es als PNG (höchstens 4-mal pro Sekunde, max.
420 KB) an den Server, der es an alle im Raum weiterreicht und Neuankömmlingen
nachliefert. Bots senden statt PNG eine Füllfarbe. Bei Rundenstart wird alles weiß.

**Treffer.** Ein Schuss ist ein Strahl aus Augenhöhe entlang der Blickrichtung mit
leichter Streuung. Er endet an der ersten Mauer (3D-DDA über das Kachelraster mit
Wandhöhen); trifft er vorher den Zylinder einer Figur – Radius 34 cm, Höhe je Pose –
zählt der Treffer. Köder sind für Sucher von echten Figuren nicht zu unterscheiden.

**Karte.** 64 × 44 Kacheln. Farbzonen per Voronoi, Mauerblöcke, Büsche, Wasser und
frei stehende Säulen als Haken-Anker. Ein Flood-Fill garantiert, dass jede begehbare
Kachel erreichbar ist. Jeder Raum bekommt einen eigenen Seed.

## Tests

```bash
npm test
```

55 Tests: Kartengenerator, Physik (Kollision, Gleiten, blickrelative Bewegung, 3D-Strahlen
gegen Boden/Mauer/Säule, Zylinder-Treffer, Wandfarben), Spielregeln (Rollen, Phasen,
Schuss mit Sichtlinie und Reichweite, Posen inkl. Trefferhöhe, Malmodus-Sperre, Bemalung,
Köder, Ausdauer, Punkte), Bots (Wegfindung, Verstecken + Anmalen, Wahrnehmung, Stresstest)
und Integrationstests mit echtem HTTP-/WebSocket-Server inklusive Textur-Relay.

## Deployment

**Direkt mit Node (≥ 20):**

```bash
PORT=3000 npm start
```

**Docker:**

```bash
docker build -t chroma-chameleon .
docker run -p 3000:3000 chroma-chameleon
```

Hinter einem Reverse-Proxy (nginx, Caddy, Traefik) muss WebSocket-Upgrade
durchgereicht werden. Mit HTTPS verbindet der Client automatisch per `wss://`.
`GET /health` liefert Räume und Spielerzahl als JSON.

Anbieter mit kostenlosem Einstieg, bei denen das ohne Änderungen läuft: Fly.io,
Railway, Render (Web Service, Start-Befehl `npm start`).

## Eigene Modelle

Die Figuren sind prozedural aus Quadern gebaut (`public/js/models.js`). Wer ein eigenes
Blender-Modell nutzen möchte: als `.glb` exportieren, mit `GLTFLoader` aus `three/addons`
laden und in `makeHumanoid` einhängen. Wichtig: alle Körperteile müssen **ein** Material
mit **einer** UV-Map teilen (die Bemalung ist eine Textur), die Gelenke heißen wie in
`PARTS`, und `userData.parts` muss die bemalbaren Meshes enthalten – dann funktionieren
Pinsel, Posen und Animation unverändert.

## Leistungsmodus

Im Menü lässt sich ein Leistungsmodus einschalten (keine Schatten, Pixelratio 1),
alternativ per URL `?lowfx=1`. Empfohlen für Laptops ohne dedizierte Grafik.

## Fehlersuche

**Nach einem Update (`git pull`) startet das Spiel nicht oder Knöpfe reagieren nicht**

1. Prüfen, ob das Update wirklich angekommen ist: `git log -1 --oneline` muss den
   neuesten Stand zeigen. Meldet `git pull` *„Your local changes … would be
   overwritten"* (meist `package-lock.json`), dann
   `git checkout -- package-lock.json` und erneut `git pull origin main`.
2. `npm install` ausführen (Abhängigkeiten), danach den Server neu starten:
   altes Fenster mit Strg+C beenden, `npm start`.
3. Im Browser die Seite mit **Strg+F5** neu laden (leert den Cache).
4. Erscheint ein roter Kasten **„Das Spiel konnte nicht gestartet werden"**, steht
   dort die Ursache (z. B. fehlendes WebGL oder fehlende Dateien). Ohne Kasten:
   F12 → Reiter „Konsole" öffnen und rote Meldungen prüfen.

**Meldung „Port 3000 ist schon belegt"** – der Server läuft noch in einem anderen
Fenster. Dort mit Strg+C beenden, oder mit `set PORT=3001` (Windows) bzw.
`PORT=3001 npm start` einen anderen Port wählen.

**WebGL nicht verfügbar** – im Browser die Hardwarebeschleunigung einschalten
(Chrome/Edge: Einstellungen → System) oder `?lowfx=1` an die Adresse anhängen.

**Verbindung wird sofort getrennt / „Protokollversion"** – Browser und Server
passen nicht zusammen: Server neu starten und Seite mit Strg+F5 laden.

## Lizenz

MIT
