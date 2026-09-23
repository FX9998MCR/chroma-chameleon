// HTTP-Server fuer die Spieldateien + WebSocket-Server fuer das Spiel.
// Start: `npm start` (Port ueber PORT, Standard 3000).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as C from '../shared/constants.js';
import { Room, randomRoomCode, sanitizeName } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Welche Verzeichnisse der Browser sehen darf. Alles andere: 404.
const STATIC_ROUTES = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/vendor/three/', dir: path.join(ROOT, 'node_modules', 'three', 'build') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); res.end('Bad Request'); return; }
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(health())); return; }

  for (const route of STATIC_ROUTES) {
    if (!urlPath.startsWith(route.prefix)) continue;
    const rel = urlPath.slice(route.prefix.length);
    const file = path.resolve(route.dir, rel);
    // Pfad-Ausbruch verhindern: das Ziel muss im freigegebenen Ordner liegen.
    if (!file.startsWith(route.dir + path.sep) && file !== route.dir) break;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': st.size,
      // Eigene Dateien nie cachen: nach einem Update darf der Browser keine alten
      // Skripte mit neuem HTML mischen. Nur die three.js-Bibliothek darf im Cache bleiben.
      'Cache-Control': route.prefix === '/vendor/three/' ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Nicht gefunden');
}

// ---------------------------------------------------------------- Raeume
const rooms = new Map();   // code -> Room

function getOrCreateRoom(code, isPublic) {
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code, { isPublic });
    rooms.set(code, room);
  }
  return room;
}

function createRoom(isPublic) {
  let code;
  do { code = randomRoomCode(); } while (rooms.has(code));
  return getOrCreateRoom(code, isPublic);
}

/** Schnellspiel: offener oeffentlicher Raum mit Platz, sonst neuer. */
function findPublicRoom() {
  let best = null;
  for (const r of rooms.values()) {
    if (!r.isPublic || r.isFull()) continue;
    if (!best || r.size > best.size) best = r;
  }
  return best ?? createRoom(true);
}

function health() {
  let players = 0;
  for (const r of rooms.values()) players += r.size;
  return { ok: true, rooms: rooms.size, players, uptime: Math.round(process.uptime()) };
}

// ---------------------------------------------------------------- Server
export function createServer() {
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, maxPayload: C.PAINT_MAX_BYTES + 8192, clientTracking: true });

  wss.on('connection', (ws) => {
    let room = null;
    let id = null;
    let budget = 90;                       // Nachrichten-Guthaben (Ratenbegrenzung)
    const refill = setInterval(() => { budget = Math.min(90, budget + 45); }, 500);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const joinTimeout = setTimeout(() => {
      if (!room) { try { ws.close(4001, 'kein Beitritt'); } catch { /* egal */ } }
    }, 10_000);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (--budget < 0) return;             // Flut: Nachricht verwerfen
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (!room) {
        if (msg.t !== 'join') return;
        if (msg.protocol !== C.PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ t: 'error', code: 'version', msg: 'Bitte Seite neu laden – Spielversion veraltet.' }));
          ws.close(4002, 'version');
          return;
        }
        const mode = ['join', 'quick', 'solo'].includes(msg.mode) ? msg.mode : 'create';
        let target;
        if (mode === 'quick') target = findPublicRoom();
        else if (mode === 'solo') {
          // Training allein: privater Raum, sofort mit KI-Mitspielern gefuellt.
          target = createRoom(false);
          const n = Math.min(8, Math.max(1, Number(msg.bots) || 3));
          for (let i = 0; i < n; i++) target.addBot();
        }
        else if (mode === 'join') {
          const code = String(msg.room ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, C.ROOM_CODE_LEN);
          target = rooms.get(code);
          if (!target) {
            ws.send(JSON.stringify({ t: 'error', code: 'noroom', msg: `Raum ${code || '?'} gibt es nicht.` }));
            return;
          }
        } else target = createRoom(!!msg.public);

        if (target.isFull()) {
          ws.send(JSON.stringify({ t: 'error', code: 'full', msg: 'Der Raum ist voll.' }));
          return;
        }
        room = target;
        id = room.join(ws, sanitizeName(msg.name));
        clearTimeout(joinTimeout);
        return;
      }
      room.handleMessage(id, msg);
    });

    ws.on('close', () => {
      clearInterval(refill);
      clearTimeout(joinTimeout);
      if (room && id) {
        room.leave(id);
        if (room.isEmpty()) rooms.delete(room.code);
      }
    });
    ws.on('error', () => { /* close folgt */ });
  });

  // Gemeinsamer Takt fuer alle Raeume.
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      try { room.step(now); }
      catch (err) { console.error(`[raum ${room.code}]`, err); }
      if (room.isEmpty()) rooms.delete(room.code);
    }
  }, C.TICK_MS);

  // Tote Verbindungen erkennen (Ping alle 15 s).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* egal */ }
    }
  }, 15_000);

  server.on('close', () => { clearInterval(ticker); clearInterval(heartbeat); });
  return { server, wss, rooms };
}

// Nur starten, wenn direkt aufgerufen (Tests importieren createServer).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  // Startpruefung: ohne three.js im node_modules-Ordner bleibt der Browser stumm haengen.
  const threeFile = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  if (!fs.existsSync(threeFile)) {
    console.error('FEHLER: three.js fehlt (' + threeFile + ').');
    console.error('Bitte im Spielordner einmal  npm install  ausführen und dann  npm start  erneut starten.');
    process.exit(1);
  }
  const { server } = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Chroma Chameleon läuft auf http://localhost:${PORT}  (Takt ${C.TICK_RATE} Hz, Protokoll v${C.PROTOCOL_VERSION})`);
    console.log('Im Browser öffnen: http://localhost:' + PORT + '  – bei Problemen: Seite mit Strg+F5 neu laden.');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`FEHLER: Port ${PORT} ist schon belegt – läuft der Server noch in einem anderen Fenster? Dort mit Strg+C beenden.`);
    } else {
      console.error('FEHLER beim Start:', err.message);
    }
    process.exit(1);
  });
  const shutdown = () => { console.log('\nServer wird beendet …'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
