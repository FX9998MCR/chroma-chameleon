// Ein Raum = eine Lobby + eine laufende Simulation.
// Verwaltet Beitritt, Austritt, Nachrichten und den Versand der Snapshots.

import * as C from '../shared/constants.js';
import { generateMap, serializeMap } from '../shared/map.js';
import { Game } from './game.js';
import { BotBrain, BOT_NAMES } from './bots.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I/O/0/1, gut ablesbar

export function randomRoomCode(rng = Math.random) {
  let s = '';
  for (let i = 0; i < C.ROOM_CODE_LEN; i++) s += ROOM_ALPHABET[(rng() * ROOM_ALPHABET.length) | 0];
  return s;
}

/** Zeichenbereiche als Codepunkte, damit keine Escape-Sequenzen im Quelltext stehen. */
function rangeClass(ranges) {
  return new RegExp('[' + ranges.map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
}
// Steuerzeichen (0-31, 127-159), Nullbreiten-Zeichen (8203-8207), Zeilentrenner (8232-8233)
const INVISIBLE_NAME = rangeClass([[0, 31], [127, 159], [8203, 8207], [8232, 8233]]);
const CONTROL_CHARS = rangeClass([[0, 31], [127, 159]]);

/** Spielername bereinigen: sichtbare Zeichen, begrenzte Laenge, nie leer. */
export function sanitizeName(raw) {
  let s = String(raw ?? '')
    .replace(INVISIBLE_NAME, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, C.NAME_MAX);
  if (!s) s = 'Chamäleon';
  return s;
}

export function sanitizeChat(raw) {
  return String(raw ?? '')
    .replace(CONTROL_CHARS, '')
    .trim()
    .slice(0, C.CHAT_MAX);
}

/**
 * Prueft eine Bemalung aus dem Netz. Erlaubt: null (weiss), {fill:[r,g,b]},
 * {png:'data:image/png;base64,...'} in begrenzter Groesse. Sonst undefined.
 */
export function validatePaint(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  if (Array.isArray(raw.fill) && raw.fill.length === 3 && raw.fill.every((v) => Number.isFinite(v))) {
    return { fill: raw.fill.map((v) => Math.max(0, Math.min(255, Math.round(v)))) };
  }
  if (typeof raw.png === 'string' && raw.png.startsWith('data:image/png;base64,') && raw.png.length <= C.PAINT_MAX_BYTES) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(raw.png)) return undefined;
    return { png: raw.png };
  }
  return undefined;
}

let nextClientId = 1;

export class Room {
  constructor(code, opts = {}) {
    this.code = code;
    this.isPublic = !!opts.isPublic;
    this.seed = opts.seed ?? ((Math.random() * 2 ** 31) | 0);
    this.map = generateMap(this.seed);
    this.mapPayload = serializeMap(this.map);
    this.game = new Game(this.map, { rng: opts.rng });
    this.clients = new Map();   // id -> {ws, name, lastSeen, msgBudget}
    this.bots = new Map();      // id -> BotBrain
    this.botSerial = 0;
    this.hostId = null;
    this.createdAt = Date.now();
    this.lastLobbyAt = 0;
    this.accumulator = 0;
    this.lastTick = null;
  }

  get size() { return this.clients.size; }
  get total() { return this.clients.size + this.bots.size; }
  isFull() { return this.total >= C.MAX_PLAYERS; }
  isEmpty() { return this.clients.size === 0; }

  /** Nimmt eine Verbindung auf und schickt Begruessung + Karte. */
  join(ws, rawName) {
    if (this.isFull()) return null;
    const id = 'p' + (nextClientId++);
    let name = sanitizeName(rawName);
    // Doppelte Namen eindeutig machen, damit die Anzeigetafel lesbar bleibt.
    const taken = new Set([...this.clients.values()].map((c) => c.name));
    if (taken.has(name)) {
      let n = 2;
      while (taken.has(`${name.slice(0, C.NAME_MAX - 3)} ${n}`)) n++;
      name = `${name.slice(0, C.NAME_MAX - 3)} ${n}`;
    }
    this.clients.set(id, { ws, name, lastSeen: Date.now(), paintBudget: C.PAINT_MSG_PER_SEC, paintRefill: Date.now() });
    if (!this.hostId) this.hostId = id;
    this.game.addPlayer(id, name);
    this.send(ws, {
      t: 'welcome',
      id,
      name,
      room: this.code,
      isPublic: this.isPublic,
      hostId: this.hostId,
      protocol: C.PROTOCOL_VERSION,
      map: this.mapPayload,
      tick: C.TICK_RATE,
    }, true);
    // Bemalungen der Anwesenden nachliefern, sonst waeren alle weiss.
    const items = this.game.paintSnapshot();
    if (items.length) this.send(ws, { t: 'paintall', items }, true);
    this.broadcastLobby();
    return id;
  }

  /** Fuegt einen KI-Mitspieler hinzu. Liefert false, wenn der Raum voll ist. */
  addBot() {
    if (this.isFull()) return false;
    const id = 'bot' + (++this.botSerial);
    const used = new Set([...this.game.players.values()].map((p) => p.name));
    let name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${this.botSerial}`;
    const p = this.game.addPlayer(id, name);
    p.bot = true;
    this.bots.set(id, new BotBrain(this.game, id));
    this.broadcastLobby();
    return true;
  }

  removeBot() {
    const last = [...this.bots.keys()].pop();
    if (!last) return false;
    this.bots.delete(last);
    this.game.removePlayer(last);
    this.broadcastLobby();
    return true;
  }

  leave(id) {
    if (!this.clients.has(id)) return;
    this.clients.delete(id);
    this.game.removePlayer(id);
    if (this.hostId === id) {
      this.hostId = this.clients.keys().next().value ?? null;
    }
    this.broadcastLobby();
  }

  /** Eine Nachricht eines Clients. Alles Unerwartete wird still verworfen. */
  handleMessage(id, msg) {
    const c = this.clients.get(id);
    if (!c || !msg || typeof msg !== 'object') return;
    c.lastSeen = Date.now();
    switch (msg.t) {
      case 'input':
        this.game.setInput(id, msg.k ?? {}, msg.a ?? null, msg.look ?? null, Number(msg.seq), msg.aim ?? null);
        break;
      case 'paint':
        // Neueste Fassung merken; versendet wird im Rahmen der Ratenbegrenzung,
        // notfalls einen Takt spaeter - aber nie verworfen.
        c.pendingPaint = { raw: msg.paint, avg: msg.avg };
        this.flushPaint(id, c);
        break;
      case 'ready':
        this.game.setReady(id, !!msg.ready);
        this.broadcastLobby();
        break;
      case 'start':
        if (id === this.hostId && this.game.canStart()) {
          this.game.startRound();
          this.broadcastLobby();
        }
        break;
      case 'addbot':
        if (id === this.hostId) this.addBot();
        break;
      case 'removebot':
        if (id === this.hostId) this.removeBot();
        break;
      case 'chat': {
        const text = sanitizeChat(msg.text);
        if (!text) return;
        this.broadcast({ t: 'chat', from: c.name, id, text, at: Date.now() });
        break;
      }
      case 'ping':
        this.send(c.ws, { t: 'pong', ts: Number(msg.ts) || 0, st: Date.now() });
        break;
      default:
        break;
    }
  }

  flushPaint(id, c, now = Date.now()) {
    if (!c.pendingPaint) return;
    c.paintBudget = Math.min(C.PAINT_MSG_PER_SEC, c.paintBudget + ((now - c.paintRefill) / 1000) * C.PAINT_MSG_PER_SEC);
    c.paintRefill = now;
    if (c.paintBudget < 1) return;
    c.paintBudget -= 1;
    const { raw, avg } = c.pendingPaint;
    c.pendingPaint = null;
    const paint = validatePaint(raw);
    if (paint === undefined) return;
    if (this.game.setPaint(id, paint, avg)) this.broadcast({ t: 'paint', id, paint }, id, true);
  }

  /** Ein Simulationsschritt plus Versand. Wird vom Server im festen Takt aufgerufen. */
  step(now = Date.now()) {
    if (this.lastTick === null) this.lastTick = now;
    // Bei Aussetzern (z. B. Lastspitze) hoechstens 5 Takte nachholen, sonst
    // wuerde die Simulation springen.
    let dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    dt = Math.min(dt, C.TICK_MS / 1000 * 5);
    this.accumulator += dt;
    const stepDt = C.TICK_MS / 1000;
    let steps = 0;
    while (this.accumulator >= stepDt && steps < 5) {
      for (const b of this.bots.values()) b.think(stepDt);
      this.game.update(stepDt);
      this.accumulator -= stepDt;
      steps++;
    }
    if (steps === 0) return;
    for (const [id, c] of this.clients) this.flushPaint(id, c, now);

    // AFK-Spieler entfernen, sonst blockieren sie die Rundenlogik.
    for (const [id, c] of this.clients) {
      if (now - c.lastSeen > C.AFK_TIMEOUT_MS) {
        this.send(c.ws, { t: 'kick', reason: 'Zu lange keine Eingabe.' });
        try { c.ws.close(4000, 'afk'); } catch { /* bereits zu */ }
        this.leave(id);
      }
    }

    for (const [id, c] of this.clients) {
      const snap = this.game.snapshotFor(id);
      if (!snap) continue;
      // Ereignisse eines uebersprungenen Snapshots nachreichen statt sie zu verlieren.
      if (c.missed) snap.events = c.missed.concat(snap.events);
      c.missed = this.send(c.ws, snap) ? null : snap.events.slice(-300);
    }
    this.game.flushEvents();

    if (now - this.lastLobbyAt > 1000) this.broadcastLobby(now);
  }

  broadcastLobby(now = Date.now()) {
    this.lastLobbyAt = now;
    this.broadcast({
      t: 'lobby',
      room: this.code,
      hostId: this.hostId,
      phase: this.game.phase,
      round: this.game.round,
      players: this.game.scoreboard(),
      canStart: this.game.canStart(),
      min: C.MIN_PLAYERS,
      max: C.MAX_PLAYERS,
    });
  }

  broadcast(obj, exceptId = null, critical = false) {
    const data = JSON.stringify(obj);
    for (const [cid, c] of this.clients) if (cid !== exceptId) this.sendRaw(c.ws, data, critical);
  }

  send(ws, obj, critical = false) { return this.sendRaw(ws, JSON.stringify(obj), critical); }

  sendRaw(ws, data, critical = false) {
    if (ws.readyState !== 1) return false;     // 1 = OPEN
    // Bei ueberlaufendem Sendepuffer Snapshots ueberspringen statt Speicher zu fressen -
    // aber nie Nachrichten, die nur einmal kommen (Bemalung, Begruessung).
    if (!critical && ws.bufferedAmount > 256 * 1024) return false;
    try { ws.send(data); return true; } catch { return false; }
  }
}
