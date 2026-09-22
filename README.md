# Chroma Chameleon

Online-Multiplayer-Versteckspiel im Browser. **Chamäleons** nehmen die Farbe des
Bodens an und werden im Stillstand fast unsichtbar. **Jäger** suchen sie mit
Puls-Scans, Nähe und einem schnellen Zungenschlag. Wer erwischt wird, jagt mit.

- 2 – 24 Spieler pro Raum, private Räume per Code oder öffentliches Schnellspiel
- Server-autoritativ: Kollision, Tarnung und Fangen entscheidet ausschließlich der Server.
  Was ein Jäger nicht sehen darf, verlässt den Server nicht (kein Wallhack möglich).
- 3D-Darstellung mit Three.js, prozedurale Low-Poly-Modelle, kein Download nötig
- Keine externen Dienste, keine Konten, keine Tracker

## Allein spielen

Im Menü **„Solo-Training mit 3 Bots"** wählen – das Spiel startet sofort mit
KI-Mitspielern. In jeder privaten Lobby kann der Host mit **+ Bot / − Bot** beliebig
viele Bots hinzufügen (bis zur Raumgrenze von 24). Bots verstecken sich, färben sich
ein, fliehen vor nahen Jägern, setzen Köder und nutzen den Zungenhaken; als Jäger
patrouillieren sie, scannen, verfolgen Sichtungen und schlagen zu. Sie spielen nach
denselben Regeln und mit derselben Sichtbarkeitslogik wie Menschen – auch sie fallen
auf Köder herein.

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
| Vorbereitung | 15 s | Chamäleons laufen los und nehmen Farbe auf. Jäger stehen mit verbundenen Augen am Startpunkt. |
| Jagd | 150 s | Jäger werden freigelassen. Gefangene Chamäleons werden nach 3 s selbst Jäger. |
| Auswertung | 8 s | Punktetafel, danach beginnt automatisch die nächste Runde mit neuen Rollen. |

**Chamäleons gewinnen**, wenn beim Ablauf der Zeit noch mindestens eines frei ist.
**Jäger gewinnen**, wenn alle gefangen sind. Ein Jäger je angefangene vier Spieler;
wer zuletzt am seltensten Jäger war, kommt zuerst dran.

### Tarnung

Die Sichtbarkeit eines Chamäleons setzt sich zusammen aus

- **Farbübereinstimmung** mit dem Boden (55 %) – per `E` aufnehmen, dauert 0,75 s
  und flimmert danach kurz sichtbar;
- **Bewegungslosigkeit** (45 %) – nach 0,9 s Stillstand volle Wirkung;
- **Gebüsch** gibt Zusatzdeckung, **Wasser** verrät durch Wellen.

Ohne Stillstand ist man nie besser als 72 % getarnt. Ein Jäger sieht innerhalb von
3 Kacheln Umrisse, innerhalb von 1,5 Kacheln alles. Die Tarnungs-Anzeige links unten
zeigt dir jederzeit, wie gut du gerade verborgen bist.

### Steuerung

| Taste | Chamäleon | Jäger |
|---|---|---|
| `W A S D` / Pfeile | laufen | laufen |
| `Shift` | sprinten (Ausdauer, hinterlässt **Farbspur**) | **Dash** – kurzer Schub, 7 s Abklingzeit |
| `E` halten | **Bodenfarbe aufnehmen** | – |
| Rechtsklick / `F` | **Zungenhaken** zur nächsten Säule in Zielrichtung (6 s) | – |
| `Q` | **Köder** absetzen – ein Jäger, der zuschlägt, ist 1,6 s betäubt (24 s) | – |
| Linksklick | – | **Zungenschlag** – fängt, was direkt vor dir ist (1,15 s) |
| `Leertaste` | – | **Puls-Scan** – markiert alles, was sich in den letzten 1,6 s bewegt hat (9 s) |
| `Tab` | Punktetafel | Punktetafel |
| `Enter` | Chat | Chat |

### Punkte

| Ereignis | Punkte |
|---|---|
| Chamäleon: je überlebte Sekunde | 1 |
| Chamäleon: Runde überlebt | 120 |
| Chamäleon: als Letztes übrig | +80 |
| Chamäleon: Köder hat einen Jäger betäubt | 45 |
| Jäger: ein Chamäleon gefangen | 90 |

## Architektur

```
server/index.js    HTTP-Server für Spieldateien + WebSocket-Server, Räume, Ratenbegrenzung
server/room.js     Ein Raum: Beitritt, Lobby, Chat, Snapshot-Versand im 20-Hz-Takt
server/game.js     Autoritative Simulation: Phasen, Rollen, Fangen, Scan, Haken, Köder,
                   Sichtbarkeits-Culling je Empfänger
server/bots.js     KI-Mitspieler: Breitensuche-Wegfindung, Versteck-/Flucht-/Jagdlogik
shared/constants.js  Alle Spielwerte an einer Stelle (Tempo, Abklingzeiten, Punkte …)
shared/map.js        Arena-Generator (deterministisch per Seed) + Kachel-Hilfen
shared/physics.js    Bewegung, Kollision, Tarnungs-Mathematik – identisch auf Server und Client
public/js/main.js    Menü, Lobby, Spielschleife, Client-Vorhersage der eigenen Bewegung
public/js/render.js  Three.js-Szene, Interpolation der Mitspieler, Effekte
public/js/models.js  Prozedurale Modelle (Chamäleon, Jäger-Drohne, Säule, Zunge)
public/js/world.js   Arena aus der Karte: Bodentextur, Mauern, Büsche, Wasser
public/js/hud.js     DOM-Anzeige, Meldungen, Tafeln, Chat
public/js/audio.js   Synthetische Soundeffekte per WebAudio
test/                node:test – Karte, Physik, Spielregeln, Server-Integration
```

**Netzcode.** Der Client schickt 30-mal pro Sekunde seinen Eingabezustand (gehaltene
Tasten, Zielwinkel, einmalige Aktionen). Der Server simuliert mit 20 Hz und sendet jedem
Spieler einen eigenen Snapshot. Die eigene Figur wird lokal vorhergesagt und weich mit
der Serverposition abgeglichen; Mitspieler werden mit 110 ms Puffer interpoliert.
Der Eingabeversand läuft in einem eigenen Timer, unabhängig von der Bildrate.

**Sichtbarkeit.** Für jeden Jäger berechnet der Server je Chamäleon einen Alpha-Wert aus
Tarnung, Abstand und Scan-Markierung. Liegt er unter 5 %, wird die Figur gar nicht
gesendet. Köder erscheinen in Jäger-Snapshots als gewöhnliche, stillstehende Chamäleons
ohne Namen – sie sind vom Original nicht zu unterscheiden. Namen von Chamäleons werden
Jägern nie übermittelt.

**Karte.** 64 × 44 Kacheln. Farbzonen per Voronoi, Mauerblöcke, Büsche, Wasser und
frei stehende Säulen als Haken-Anker. Ein Flood-Fill garantiert, dass jede begehbare
Kachel erreichbar ist. Jeder Raum bekommt einen eigenen Seed.

## Tests

```bash
npm test
```

55 Tests: Kartengenerator (Determinismus, Zusammenhang, Anker), Physik (Kollision,
Gleiten, Tempo, Tarnung), Spielregeln (Rollen, Phasen, Fangen mit Sichtlinie, Köder,
Scan, Haken, Ausdauer, Punkte, Snapshot-Culling), Bots (Wegfindung, Verstecken,
Fangen, Stresstest über mehrere Runden) und ein Integrationstest mit echtem HTTP- und
WebSocket-Server.

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

Die Figuren sind prozedural aus Grundkörpern gebaut (`public/js/models.js`). Wer
eigene Blender-Modelle nutzen möchte, exportiert sie als `.glb`, lädt sie mit
`GLTFLoader` aus `three/addons` und ersetzt die jeweilige `make*`-Funktion. Wichtig:
`userData.mats` (einfärbbare Materialien) und `userData.legs`/`tail`/`head`
(Animation) setzen, dann funktionieren Tarnung und Animation weiter.

## Leistungsmodus

Im Menü lässt sich ein Leistungsmodus einschalten (keine Schatten, Pixelratio 1),
alternativ per URL `?lowfx=1`. Empfohlen für Laptops ohne dedizierte Grafik.

## Lizenz

MIT
