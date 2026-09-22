// Ein Raum = eine Lobby + eine laufende Simulation.
// Verwaltet Beitritt, Austritt, Nachrichten und den Versand der Snapshots.

import * as C from '../shared/constants.js';
import { generateMap, serializeMap } from '../shared/map.js';
import { Game } from './game.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I/O/0/1, gut ablesbar

export function randomRoomCode(rng = Math.random) {
  let s = '';
  for (let i = 0; i < C.ROOM_CODE_LEN; i++) s += ROOM_ALPHABET[(rng() * ROOM_ALPHABET.length) | 0];
  return s;
}

/** Spielername bereinigen: sichtbare Zeichen, begrenzte Laenge, nie leer. */
export function sanitizeName(raw) {
  let s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, C.NAME_MAX);
  if (!s) s = 'Chamäleon';
  return s;
}

export function sanitizeChat(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, C.CHAT_MAX);
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
    this.hostId = null;
    this.createdAt = Date.now();
    this.lastLobbyAt = 0;
    this.accumulator = 0;
    this.lastTick = null;
  }

  get size() { return this.clients.size; }
  isFull() { return this.clients.size >= C.MAX_PLAYERS; }
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
    this.clients.set(id, { ws, name, lastSeen: Date.now(), msgBudget: 60 });
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
    });
    this.broadcastLobby();
    return id;
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
        this.game.setInput(id, msg.k ?? {}, msg.a ?? null, Number(msg.aim), Number(msg.seq));
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
      this.game.update(stepDt);
      this.accumulator -= stepDt;
      steps++;
    }
    if (steps === 0) return;

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
      if (snap) this.send(c.ws, snap);
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

  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const c of this.clients.values()) this.sendRaw(c.ws, data);
  }

  send(ws, obj) { this.sendRaw(ws, JSON.stringify(obj)); }

  sendRaw(ws, data) {
    if (ws.readyState !== 1) return;     // 1 = OPEN
    // Bei ueberlaufendem Sendepuffer Snapshots ueberspringen statt Speicher zu fressen.
    if (ws.bufferedAmount > 256 * 1024) return;
    try { ws.send(data); } catch { /* Verbindung wird gleich abgebaut */ }
  }
}
