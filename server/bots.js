// KI-Mitspieler. Bots sind normale Spieler in der Simulation - sie erzeugen
// dieselben Eingaben wie ein Mensch (Tasten, Blickrichtung, Aktionen) und
// unterliegen denselben Regeln.
//
// Chamaeleon-Bots: passendes Versteck suchen (einheitliche Farbflaeche, Mauer
// oder Gebuesch), Koerper in Boden- oder Wandfarbe malen, Pose einnehmen,
// stillhalten und nur fliehen, wenn ein Jaeger sie erkennbar ins Visier nimmt.
// Jaeger-Bots: sich umschauen, sinnvoll patrouillieren (unbesuchte Gegenden,
// frische Farbspuren), Chamaeleons nur im Sichtfeld und mit einer
// Wahrscheinlichkeit aus Farbabweichung, Abstand und Bewegung "sehen", dann
// mit Reaktionszeit und abklingender Ungenauigkeit zielen.
//
// Bewegung: Die Blickrichtung dreht mit begrenzter Geschwindigkeit, die Tasten
// werden relativ zum aktuellen Blick gewaehlt. Ein kleiner Regler bremst vor
// dem Ziel und hebt seitliche Geschwindigkeit auf - so kann kein Bot mehr um
// einen Wegpunkt kreisen.

import * as C from '../shared/constants.js';
import { idx, inBounds, TILE_PX, tileColorAt, wallColorAt, surfaceColor } from '../shared/map.js';
import {
  colorMatch, raycast3D, raycastSolid, angleDiff, circleHitsSolid, terrainFactor, maxSpeedFor,
} from '../shared/physics.js';

export const BOT_NAMES = [
  'Bot Kiwi', 'Bot Mango', 'Bot Pixel', 'Bot Nova', 'Bot Ziggy', 'Bot Momo',
  'Bot Luna', 'Bot Taro', 'Bot Fibi', 'Bot Ollie', 'Bot Suki', 'Bot Remy',
];

const tileOf = (v) => Math.floor(v / C.TILE);
const centerOf = (t) => t * C.TILE + C.TILE / 2;
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- Feinabstimmung
export const TURN_WALK = 4.5;    // rad/s Drehtempo beim Laufen
export const TURN_SCAN = 2.6;    // rad/s beim Umschauen
export const TURN_AIM = 7.0;     // rad/s beim Zielen (schnell, aber nicht sofort)
const TURN_PITCH = 3.0;          // rad/s fuer den Nickwinkel
const TURN_EASE = 15;            // 1/s: weiches Auslaufen kurz vor dem Zielwinkel
const WAYPOINT_R = 14;           // px: Zwischenpunkt gilt als erreicht (mit freier Sicht zum naechsten)
const ARRIVE_R = 6;              // px: Endpunkt erreicht ...
const ARRIVE_V = 40;             // px/s ... und dabei langsam genug
const LOOKAHEAD = 6;             // so viele Wegpunkte voraus wird abgekuerzt
const CLEARANCE = C.PLAYER_RADIUS + 1.5;
const STUCK_TIME = 1.6;          // s ohne Fortschritt auf dem Weg = festgefahren
const FOV_HALF = 1.15;           // halber Sichtwinkel der Jaeger (rad)
const VIEW_TILES = 14;           // Sichtweite fuer das Erkennen
const PERCEIVE_EVERY = 0.2;      // s zwischen zwei Wahrnehmungen
const NOTICE_STARE = 1.4;        // s, die ein Jaeger nach einem Verdacht hinstarrt
const CELL = 6;                  // Kacheln je Zelle der Besuchskarte
const CELLS_X = Math.ceil(C.MAP_W / CELL), CELLS_Y = Math.ceil(C.MAP_H / CELL);

const NO_KEYS = Object.freeze({ up: false, down: false, left: false, right: false, sprint: false, paint: false });
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Winkel auf (-PI, PI] bringen, damit yaw nicht ueber viele Umdrehungen waechst. */
export function normAngle(a) {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Breitensuche ueber begehbare Kacheln ab einer Startkachel. */
export function bfs(map, startTx, startTy) {
  const n = C.MAP_W * C.MAP_H;
  const dist = new Int16Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  if (!inBounds(startTx, startTy)) return { dist, parent };
  const start = idx(startTx, startTy);
  if (C.SOLID_TILES.has(map.tiles[start])) return { dist, parent };
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  queue[tail++] = start;
  dist[start] = 0;
  while (head < tail) {
    const i = queue[head++];
    const tx = i % C.MAP_W, ty = (i / C.MAP_W) | 0;
    for (const [dx, dy] of DIRS4) {
      const nx = tx + dx, ny = ty + dy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (dist[ni] >= 0 || C.SOLID_TILES.has(map.tiles[ni])) continue;
      dist[ni] = dist[i] + 1;
      parent[ni] = i;
      queue[tail++] = ni;
    }
  }
  return { dist, parent };
}

/** Weg (Liste von Kachelmittelpunkten) vom BFS-Start zur Zielkachel. */
export function pathTo(search, targetIdx) {
  if (targetIdx < 0 || search.dist[targetIdx] < 0) return null;
  const out = [];
  let i = targetIdx;
  while (i >= 0) {
    out.push({ x: centerOf(i % C.MAP_W), y: centerOf((i / C.MAP_W) | 0) });
    i = search.parent[i];
  }
  out.reverse();
  return out;
}

/**
 * Kann eine Spielerfigur geradlinig von (x0,y0) nach (x1,y1) laufen, ohne
 * eine Mauer zu streifen? Grundlage fuer das Abkuerzen von Wegen.
 */
export function clearLine(map, x0, y0, x1, y1, r = CLEARANCE) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return true;
  const n = Math.ceil(len / 4);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (circleHitsSolid(map, x0 + dx * t, y0 + dy * t, r)) return false;
  }
  return true;
}

/** Nachbar-Mauer einer Kachel (fuer die Wandpresse): Richtung und Farbe. */
function adjacentWall(map, tx, ty) {
  let best = null, bestMatch = -1;
  const floor = tileColorAt(map, centerOf(tx), centerOf(ty));
  for (const [dx, dy] of DIRS4) {
    const nx = tx + dx, ny = ty + dy;
    if (!inBounds(nx, ny) || map.tiles[idx(nx, ny)] !== C.T_WALL) continue;
    const color = wallColorAt(map, nx, ny);
    // Lieber die Mauer, deren Farbe auch zum Boden passt: tarnt aus mehr Blickwinkeln.
    const m = colorMatch(color, floor);
    if (m > bestMatch) { bestMatch = m; best = { dx, dy, color, match: m }; }
  }
  return best;
}

/**
 * Vorberechnete Karteneigenschaften fuer die Versteckwahl (je Karte einmal):
 * Mauer nebenan und wie einheitlich die Farbe der Umgebung ist.
 */
const mapCache = new WeakMap();
function mapInfo(map) {
  let info = mapCache.get(map);
  if (info) return info;
  const n = C.MAP_W * C.MAP_H;
  const wall = new Uint8Array(n);
  const wallMatch = new Float32Array(n);
  const uniform = new Float32Array(n);
  for (let ty = 0; ty < C.MAP_H; ty++) {
    for (let tx = 0; tx < C.MAP_W; tx++) {
      const i = idx(tx, ty);
      if (C.SOLID_TILES.has(map.tiles[i])) continue;
      const w = adjacentWall(map, tx, ty);
      if (w) { wall[i] = 1; wallMatch[i] = w.match; }
      const own = tileColorAt(map, centerOf(tx), centerOf(ty));
      let sum = 0, cnt = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const nx = tx + dx, ny = ty + dy;
          if (!inBounds(nx, ny)) continue;
          const ni = idx(nx, ny);
          const c = C.SOLID_TILES.has(map.tiles[ni]) ? wallColorAt(map, nx, ny) : tileColorAt(map, centerOf(nx), centerOf(ny));
          sum += colorMatch(own, c);
          cnt++;
        }
      }
      uniform[i] = cnt ? sum / cnt : 0;
    }
  }
  info = { wall, wallMatch, uniform };
  mapCache.set(map, info);
  return info;
}

export class BotBrain {
  constructor(game, playerId, rng = Math.random) {
    this.game = game;
    this.id = playerId;
    this.rng = rng;
    this.yaw = 0;
    this.pitch = 0;
    // Persoenlichkeit: jeder Bot reagiert, zielt und erschrickt etwas anders.
    this.reaction = 0.2 + rng() * 0.25;      // s vom Erkennen bis zum Hinzielen
    this.skill = 0.8 + rng() * 0.4;          // Zielgenauigkeit (1 = normal)
    this.nerve = 0.7 + rng() * 0.9;          // s, die ein Chamaeleon einen Blick aushaelt
    this.swayPhase = rng() * TAU;
    this.lastRole = null;
    this.lastPhase = null;
    this.lastAlive = null;
    this.visited = null;
    this.reset();
  }

  get p() { return this.game.players.get(this.id); }

  /** Kompletter Neustart des Verhaltens (Rollen-, Phasen- oder Lebenswechsel). */
  reset() {
    this.state = 'idle';
    this.path = null;
    this.pathTarget = null;
    this.replanT = 0;
    this.smoothT = 0;
    this.prog = { best: Infinity, t: 0 };
    this.stuckCount = 0;
    this.unstickT = 0;
    this.unstickDir = 0;
    this.moveYaw = null;
    // Chamaeleon
    this.spot = null;
    this.faceYaw = null;
    this.paintT = 0;
    this.wantPose = 0;
    this.poseTries = 0;
    this.suspicion = 0;
    this.threatId = null;
    this.fleeT = 0;
    this.fleeDelay = 0;
    this.wanderT = 0;
    this.nearOnly = false;
    // Jaeger
    this.lookT = 0;
    this.noticeId = null;
    this.noticeT = 0;
    this.noticePos = null;
    this.noticeAge = 99;
    this.target = null;
    this.lastKnown = null;
    this.lostT = 0;
    this.reactT = 0;
    this.aimErrYaw = 0;
    this.aimErrPitch = 0;
    this.onTargetT = 0;
    this.triggerDelay = 0;
    this.scanDirs = null;
    this.scanHoldFor = null;
    this.scanIdx = 0;
    this.scanHold = 0;
    this.searchPoint = null;
    this.searchT = 0;
    this.openingScan = true;
    this.prepLookT = 0;
    this.prepYaw = null;
    this.checkedSplats = new Set();
  }

  think(dt) {
    const p = this.p;
    if (!p) return;
    const phase = this.game.phase;

    // Jeder Wechsel von Rolle, Phase oder Leben (gefangen, wieder da als Jaeger)
    // setzt das Verhalten vollstaendig zurueck - alte Wege, Ziele und Zustaende
    // der vorigen Rolle wuerden sonst weiterwirken.
    // Ausnahme: Beginnt die Jagd, bleibt ein Chamaeleon in seinem Versteck.
    const phaseReset = phase !== this.lastPhase && !(phase === C.PHASE_HUNT && p.role === C.ROLE_HIDER);
    if (p.role !== this.lastRole || p.alive !== this.lastAlive || phaseReset) {
      if (phase !== this.lastPhase && (phase === C.PHASE_PREP || phase === C.PHASE_LOBBY)) this.visited = null;
      this.lastRole = p.role;
      this.lastPhase = phase;
      this.lastAlive = p.alive;
      this.reset();
      this.yaw = normAngle(Number.isFinite(p.yaw) ? p.yaw : 0);
      this.pitch = Number.isFinite(p.pitch) ? p.pitch : 0;
    }
    this.lastPhase = phase;

    if (!p.alive || phase === C.PHASE_OVER || phase === C.PHASE_LOBBY) {
      this.send(NO_KEYS, null);
      return;
    }

    if (p.role === C.ROLE_HIDER) this.thinkHider(p, dt, phase);
    else this.thinkSeeker(p, dt, phase);
  }

  send(keys, actions) {
    this.yaw = normAngle(this.yaw);
    this.game.setInput(this.id, keys, actions, { yaw: this.yaw, pitch: this.pitch }, 0);
  }

  // ---------------------------------------------------------------- Blick
  /** Blick mit begrenzter Drehgeschwindigkeit und weichem Auslaufen drehen. Liefert den Restwinkel. */
  turnTo(goal, rate, dt) {
    const d = angleDiff(this.yaw, goal);
    const max = rate * dt;
    this.yaw = normAngle(this.yaw + clamp(d * Math.min(1, dt * TURN_EASE), -max, max));
    return Math.abs(angleDiff(this.yaw, goal));
  }

  turnPitch(goal, rate, dt) {
    const d = clamp(goal, -1.2, 1.2) - this.pitch;
    const max = rate * dt;
    this.pitch += clamp(d * Math.min(1, dt * TURN_EASE), -max, max);
  }

  // ---------------------------------------------------------------- Wege
  /** Startkachel fuer die Wegsuche; liegt die Mitte in einer festen Kachel, die naechste freie. */
  startTile(p) {
    const map = this.game.map;
    const tx = tileOf(p.x), ty = tileOf(p.y);
    if (inBounds(tx, ty) && !C.SOLID_TILES.has(map.tiles[idx(tx, ty)])) return { tx, ty };
    let best = { tx, ty }, bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = tx + dx, ny = ty + dy;
        if (!inBounds(nx, ny) || C.SOLID_TILES.has(map.tiles[idx(nx, ny)])) continue;
        const d = Math.hypot(centerOf(nx) - p.x, centerOf(ny) - p.y);
        if (d < bd) { bd = d; best = { tx: nx, ty: ny }; }
      }
    }
    return best;
  }

  search(p) {
    const s = this.startTile(p);
    return bfs(this.game.map, s.tx, s.ty);
  }

  setPath(path, target) {
    this.path = path && path.length ? path : null;
    this.pathTarget = this.path ? target : null;
    this.prog = { best: Infinity, t: 0 };
    this.smoothT = 0;
  }

  /**
   * Waehlt die bestbewertete erreichbare Kachel (Boden oder Gebuesch) im
   * Abstand [minDist, maxDist] und legt den Weg dorthin. Liefert den Index oder -1.
   */
  pickTile(p, score, minDist = 4, maxDist = 40) {
    const s = this.search(p);
    let best = -1, bestScore = -Infinity;
    const map = this.game.map;
    for (let i = 0; i < s.dist.length; i++) {
      const d = s.dist[i];
      if (d < minDist || d > maxDist) continue;
      const t = map.tiles[i];
      if (t !== C.T_FLOOR && t !== C.T_BUSH) continue;
      const x = centerOf(i % C.MAP_W), y = centerOf((i / C.MAP_W) | 0);
      const sc = score(x, y, t, d, i) + this.rng() * 30;
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (best < 0) return -1;
    this.setPath(pathTo(s, best), { x: centerOf(best % C.MAP_W), y: centerOf((best / C.MAP_W) | 0) });
    return this.path ? best : -1;
  }

  /** Weg zu einem beliebigen Punkt; ist er unerreichbar, zur naechsten erreichbaren Kachel. */
  pathToPoint(p, x, y) {
    const s = this.search(p);
    const map = this.game.map;
    const tx = clamp(tileOf(x), 0, C.MAP_W - 1), ty = clamp(tileOf(y), 0, C.MAP_H - 1);
    let target = idx(tx, ty);
    let exact = true;
    if (s.dist[target] < 0) {
      exact = false;
      let bd = Infinity;
      for (let i = 0; i < s.dist.length; i++) {
        if (s.dist[i] < 0) continue;
        const dx = centerOf(i % C.MAP_W) - x, dy = centerOf((i / C.MAP_W) | 0) - y;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; target = i; }
      }
    }
    const path = pathTo(s, target);
    if (!path) { this.setPath(null, null); return false; }
    // Endpunkt genau auf den gewuenschten Punkt legen, wenn die Figur dort Platz hat.
    if (exact && !circleHitsSolid(map, x, y, C.PLAYER_RADIUS + 0.5)) {
      const last = path[path.length - 1];
      if (clearLine(map, last.x, last.y, x, y, C.PLAYER_RADIUS + 0.5)) path[path.length - 1] = { x, y };
    }
    const end = path[path.length - 1];
    this.setPath(path, { x: end.x, y: end.y });
    return true;
  }

  /** Tasten (8 Richtungen relativ zum aktuellen Blick), die am besten in Weltrichtung (wx,wy) fuehren. */
  keysForDir(wx, wy, sprint = false) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const f = wx * c + wy * s;          // Anteil nach vorn
    const r = -wx * s + wy * c;         // Anteil nach rechts
    const sector = Math.round(Math.atan2(r, f) / (Math.PI / 4)) * (Math.PI / 4);
    const kf = Math.cos(sector), kr = Math.sin(sector);
    const keys = { ...NO_KEYS, sprint: !!sprint };
    if (kf > 0.3) keys.up = true; else if (kf < -0.3) keys.down = true;
    if (kr > 0.3) keys.right = true; else if (kr < -0.3) keys.left = true;
    return keys;
  }

  /**
   * Regler Richtung (tx,ty): Wunschgeschwindigkeit minus Ist-Geschwindigkeit.
   * Hebt seitliche Drift auf und bremst vor einem Endpunkt rechtzeitig.
   * Liefert null, wenn der Endpunkt erreicht ist.
   */
  steer(p, tx, ty, final, sprint) {
    const dx = tx - p.x, dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    const speed = Math.hypot(p.vx, p.vy);
    if (final && d < ARRIVE_R && speed < ARRIVE_V) return null;
    const canSprint = !!sprint && p.role === C.ROLE_HIDER &&
      p.stamina > (p.sprinting ? 1 : C.STAMINA_SPRINT_MIN);
    const vmax = maxSpeedFor(p.role, canSprint) * terrainFactor(this.game.map, p.x, p.y);
    let want = vmax;
    if (final) want = Math.min(vmax, Math.sqrt(2 * C.FRICTION * 0.55 * Math.max(0, d - 2)));
    const ux = d > 1e-6 ? dx / d : 0, uy = d > 1e-6 ? dy / d : 0;
    if (d > 3) this.moveYaw = Math.atan2(uy, ux);
    const ex = ux * want - p.vx, ey = uy * want - p.vy;
    const e = Math.hypot(ex, ey);
    if (e < 22) {
      if (want < 25) return { ...NO_KEYS };     // ausrollen lassen
      return this.keysForDir(ux, uy, canSprint);
    }
    return this.keysForDir(ex / e, ey / e, canSprint);
  }

  /**
   * Einen Schritt entlang des Weges. Liefert {keys, status} mit status
   * 'moving' | 'arrived' | 'stuck' | 'none'.
   */
  moveAlong(p, dt, { sprint = false, brake = true } = {}) {
    const map = this.game.map;
    if (this.unstickT > 0) {
      this.unstickT -= dt;
      this.moveYaw = this.unstickDir;
      return { keys: this.keysForDir(Math.cos(this.unstickDir), Math.sin(this.unstickDir)), status: 'moving' };
    }
    const path = this.path;
    if (!path || !path.length) return { keys: { ...NO_KEYS }, status: 'none' };

    // Abkuerzen: den weitesten direkt erreichbaren Wegpunkt ansteuern.
    this.smoothT -= dt;
    if (this.smoothT <= 0 && path.length > 1) {
      this.smoothT = 0.15;
      for (let k = Math.min(path.length - 1, LOOKAHEAD); k >= 1; k--) {
        if (clearLine(map, p.x, p.y, path[k].x, path[k].y)) { path.splice(0, k); break; }
      }
    }
    // Erreichte oder schon passierte Zwischenpunkte abhaken.
    while (path.length > 1) {
      const a = path[0], b = path[1];
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      const passed = (b.x - a.x) * (p.x - a.x) + (b.y - a.y) * (p.y - a.y) > 0;
      if (d < 5 || (d < 20 && passed) || (d < WAYPOINT_R && clearLine(map, p.x, p.y, b.x, b.y))) path.shift();
      else break;
    }
    const wp = path[0];
    const last = path.length === 1;

    // Fortschritt messen: Der Restweg muss schrumpfen, sonst haengt der Bot
    // (an einer Kante, im Kreis, an einer Wand) - dann frei machen und neu planen.
    const remaining = Math.hypot(wp.x - p.x, wp.y - p.y) + (path.length - 1) * C.TILE;
    if (remaining < this.prog.best - 4) { this.prog.best = remaining; this.prog.t = 0; }
    else this.prog.t += dt;
    if (this.prog.t > STUCK_TIME) {
      this.stuckCount++;
      const keep = this.pathTarget;
      this.setPath(null, null);
      this.pathTarget = keep;                // Ziel bleibt gemerkt, der Weg wird neu geplant
      this.unstickT = 0.3;
      this.unstickDir = this.freeDirection(p);
      return { keys: { ...NO_KEYS }, status: 'stuck' };
    }

    const keys = this.steer(p, wp.x, wp.y, last && brake, sprint);
    if (!keys || (last && !brake && Math.hypot(wp.x - p.x, wp.y - p.y) < ARRIVE_R * 2)) {
      this.stuckCount = 0;
      this.setPath(null, null);
      return { keys: { ...NO_KEYS }, status: 'arrived' };
    }
    return { keys, status: 'moving' };
  }

  /** Richtung mit dem meisten freien Platz (zum Freikommen nach dem Festhaengen). */
  freeDirection(p) {
    const map = this.game.map;
    let best = this.rng() * TAU, bestFree = -1;
    const off = this.rng() * TAU;
    for (let k = 0; k < 8; k++) {
      const a = off + (k * TAU) / 8;
      let free = 0;
      for (let s = 8; s <= 48; s += 8) {
        if (circleHitsSolid(map, p.x + Math.cos(a) * s, p.y + Math.sin(a) * s, C.PLAYER_RADIUS)) break;
        free = s;
      }
      if (free > bestFree) { bestFree = free; best = a; }
    }
    return normAngle(best);
  }

  /** Freie Sicht (2D) von a nach b innerhalb der Sichtweite? */
  lineOfSight(ax, ay, bx, by, maxTiles = VIEW_TILES) {
    if (Math.hypot(bx - ax, by - ay) > maxTiles * C.TILE) return false;
    return !raycastSolid(this.game.map, ax, ay, bx, by, 8);
  }

  // ---------------------------------------------------------------- Chamaeleon
  thinkHider(p, dt, phase) {
    const inHunt = phase === C.PHASE_HUNT;
    const actions = {};

    if (inHunt && this.state !== 'flee') {
      const threat = this.assessThreat(p, dt);
      if (threat) this.startFlee(p, threat, actions);
    }

    if (this.state === 'flee') { this.hiderFlee(p, dt, actions); return; }

    if (this.state === 'idle') {
      if (this.chooseHideSpot(p, phase)) this.state = 'travel';
      else this.settleHere(p);
    }

    // Vorbereitung laeuft ab und das Ziel ist noch weit: lieber hier verstecken
    // als weiss in die Jagd zu gehen.
    if (this.state === 'travel' && phase === C.PHASE_PREP && this.pathTarget) {
      const rest = Math.hypot(this.pathTarget.x - p.x, this.pathTarget.y - p.y);
      if (rest > Math.max(0, this.game.phaseTime - 4) * 180) { this.setPath(null, null); this.settleHere(p); }
    }

    if (this.state === 'travel') {
      // Erst drehen, dann Tasten waehlen: Die Tasten gelten relativ zum Blick, der gesendet wird.
      if (this.moveYaw !== null) this.turnTo(this.moveYaw, TURN_WALK, dt);
      this.turnPitch(-0.1, TURN_PITCH, dt);
      const res = this.moveAlong(p, dt, { sprint: phase === C.PHASE_PREP && p.stamina > 30 });
      if (res.status === 'arrived') {
        this.state = 'settle';
      } else if ((res.status === 'stuck' || res.status === 'none') && this.unstickT <= 0) {
        if (this.stuckCount >= 3 || !this.spot || !this.pathToPoint(p, this.spot.x, this.spot.y)) {
          this.stuckCount = 0;
          this.state = 'idle';
        }
      }
      this.send(res.keys, actions);
      return;
    }

    if (this.state === 'settle') {
      // Anhalten, ausrichten (Ruecken zur Wand oder Blick zur Gefahr), dann malen.
      const speed = Math.hypot(p.vx, p.vy);
      if (this.spot && Math.hypot(this.spot.x - p.x, this.spot.y - p.y) > 14 && speed < 5) {
        this.pathToPoint(p, this.spot.x, this.spot.y);
        this.state = 'travel';
        this.send(NO_KEYS, actions);
        return;
      }
      if (this.faceYaw === null) this.faceYaw = this.chooseFacing(p);
      const off = this.turnTo(this.faceYaw, TURN_WALK, dt);
      if (speed < 3 && off < 0.06) {
        const color = this.spotColor(p);
        const already = p.paint?.fill && p.paint.fill.join() === color.join();
        this.state = 'paint';
        this.paintT = already ? 0.2 : 2.2 + this.rng() * 1.8;
      }
      this.send(NO_KEYS, actions);
      return;
    }

    if (this.state === 'paint') {
      // Malmodus: eingefroren; nach der Malzeit wird die Bemalung gesetzt.
      this.paintT -= dt;
      if (this.paintT <= 0) {
        const color = this.spotColor(p);
        this.game.setPaint(this.id, { fill: color.slice() }, color.slice());
        this.game.pushEvent({ k: 'paint', id: this.id, paint: { fill: color.slice() } });
        this.wantPose = this.choosePose(p);
        this.poseTries = 0;
        this.state = 'pose';
        this.send(NO_KEYS, actions);
        return;
      }
      this.send({ ...NO_KEYS, paint: true }, actions);
      return;
    }

    if (this.state === 'pose') {
      // Posen werden per Taste durchgeschaltet: je Takt eine Stufe weiter.
      if (p.pose !== this.wantPose && this.poseTries++ < C.POSES.length * 2) {
        this.send(NO_KEYS, { ...actions, pose: true });
        return;
      }
      this.state = 'hide';
      this.wanderT = 60 + this.rng() * 60;
    }

    // Stillhalten: keine Tasten, kein Drehen. Nur selten umziehen, und nur,
    // wenn weit und breit kein Jaeger ist.
    if (p.pose !== this.wantPose && this.poseTries < C.POSES.length * 2) { this.state = 'pose'; this.send(NO_KEYS, actions); return; }
    this.wanderT -= dt;
    if (this.wanderT <= 0) {
      if (this.safeToMove(p)) { this.state = 'idle'; this.nearOnly = false; }
      else this.wanderT = 10;
    }
    this.send(NO_KEYS, actions);
  }

  /** Farbe fuer die aktuelle Stelle: Wandfarbe bei Wandpresse, sonst Bodenfarbe. */
  spotColor(p) {
    const wall = this.spot ? this.spot.wall : adjacentWall(this.game.map, tileOf(p.x), tileOf(p.y));
    if (wall) return wall.color;
    return tileColorAt(this.game.map, p.x, p.y);
  }

  choosePose(p) {
    const map = this.game.map;
    const wall = this.spot ? this.spot.wall : adjacentWall(map, tileOf(p.x), tileOf(p.y));
    if (wall) return 4;                                                  // Wandpresse
    if (map.tiles[idx(tileOf(p.x), tileOf(p.y))] === C.T_BUSH) return 5; // Kugel verschwindet im Gebuesch
    return this.rng() < 0.65 ? 3 : 5;                                    // Liegen oder Kugel
  }

  chooseFacing(p) {
    const wall = this.spot?.wall;
    if (wall) return Math.atan2(-wall.dy, -wall.dx);                  // Ruecken zur Wand
    const t = this.nearestSeeker(p)?.s ?? this.game.seekerSpawn;
    if (!t || Math.hypot(t.x - p.x, t.y - p.y) < 1) return this.yaw;
    return Math.atan2(t.y - p.y, t.x - p.x);                          // Gefahr im Blick behalten
  }

  settleHere(p) {
    // Wandpresse nur, wenn die Figur wirklich an der Mauer steht.
    let wall = adjacentWall(this.game.map, tileOf(p.x), tileOf(p.y));
    if (wall) {
      const face = wall.dx ? (tileOf(p.x) + (wall.dx > 0 ? 1 : 0)) * C.TILE : (tileOf(p.y) + (wall.dy > 0 ? 1 : 0)) * C.TILE;
      const gap = Math.abs(face - (wall.dx ? p.x : p.y));
      if (gap > C.PLAYER_RADIUS + 6) wall = null;
    }
    this.spot = { x: p.x, y: p.y, wall };
    this.faceYaw = null;
    this.state = 'settle';
  }

  nearestSeeker(p) {
    let s = null, d = Infinity;
    for (const o of this.game.players.values()) {
      if (o.role !== C.ROLE_SEEKER || !o.alive || o.id === this.id) continue;
      const od = Math.hypot(o.x - p.x, o.y - p.y);
      if (od < d) { d = od; s = o; }
    }
    return s ? { s, d } : null;
  }

  safeToMove(p) {
    for (const o of this.game.players.values()) {
      if (o.role !== C.ROLE_SEEKER || !o.alive) continue;
      if (Math.hypot(o.x - p.x, o.y - p.y) < 15 * C.TILE) return false;
    }
    return true;
  }

  /**
   * Versteckwahl: weit weg von der Gefahr, einheitliche Farbflaeche ringsum,
   * gern an einer Mauer (Wandpresse) oder im Gebuesch, nicht im Blickfeld eines
   * Jaegers und nicht direkt neben anderen Chamaeleons.
   */
  chooseHideSpot(p, phase) {
    const map = this.game.map;
    const info = mapInfo(map);
    const inHunt = phase === C.PHASE_HUNT;
    const seekers = [];
    const others = [];
    for (const o of this.game.players.values()) {
      if (o.id === this.id || !o.alive) continue;
      if (o.role === C.ROLE_SEEKER) seekers.push(o); else others.push(o);
    }
    const threats = seekers.length ? seekers : [this.game.seekerSpawn];
    const maxDist = !inHunt ? clamp(Math.floor((this.game.phaseTime - 6) * 5), 6, 36) : (this.nearOnly ? 8 : 14);
    const minDist = inHunt ? 1 : 3;
    const cost = inHunt ? 5 : 2;
    const best = this.pickTile(p, (x, y, t, d, i) => {
      let away = Infinity;
      for (const s of threats) away = Math.min(away, Math.hypot(x - s.x, y - s.y));
      let sc = Math.min(away, 900) * 0.45 - d * cost;
      if (info.wall[i]) sc += 45 + info.wallMatch[i] * 25;
      if (t === C.T_BUSH) sc += 45;
      sc += info.uniform[i] * 80;
      for (const o of others) {
        const od = Math.hypot(o.x - x, o.y - y);
        if (od < 4 * C.TILE) sc -= (4 * C.TILE - od) * 0.8;
      }
      if (inHunt) {
        for (const s of seekers) if (this.lineOfSight(s.x, s.y, x, y)) sc -= 120;
      }
      return sc;
    }, minDist, maxDist);
    this.nearOnly = false;
    if (best < 0) return false;
    const tx = best % C.MAP_W, ty = (best / C.MAP_W) | 0;
    const wall = adjacentWall(map, tx, ty);
    let x = centerOf(tx), y = centerOf(ty);
    // Fuer die Wandpresse dicht an die Mauer heran.
    if (wall) { x += wall.dx * 3.5; y += wall.dy * 3.5; }
    this.spot = { x, y, wall };
    this.faceYaw = null;
    return this.pathToPoint(p, x, y);
  }

  /**
   * Gefahr einschaetzen. Flucht nur, wenn noetig: Ein Jaeger starrt uns eine
   * Weile an, hat gerade knapp an uns vorbeigeschossen, oder wir sind noch
   * weiss und stehen in seinem Blickfeld. Wer gut getarnt ist, bleibt ruhig.
   */
  assessThreat(p, dt) {
    let rate = 0, danger = null;
    for (const s of this.game.players.values()) {
      if (s.role !== C.ROLE_SEEKER || !s.alive || s.id === this.id) continue;
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d > 10 * C.TILE) continue;
      if (!this.lineOfSight(s.x, s.y, p.x, p.y, 10)) continue;
      const off = Math.abs(angleDiff(s.yaw, Math.atan2(p.y - s.y, p.x - s.x)));
      const dT = d / C.TILE;
      const aimTol = Math.max(0.1, Math.atan2(C.BODY_R * 3, dT));
      if (s.shotCd > C.SHOT_COOLDOWN - 0.35 && s.shotCd <= C.SHOT_COOLDOWN && off < aimTol) danger = s;  // Schuss knapp daneben
      if (p.paint === null && off < FOV_HALF && dT < 9) danger = s;                // weiss und im Blickfeld
      if (off < 0.35 && dT < 8) rate += (dT < 3 ? 2 : 1) * (p.stillTime < 0.5 ? 1.5 : 1);
      if (danger) break;
    }
    if (rate > 0) this.suspicion += rate * dt;
    else this.suspicion = Math.max(0, this.suspicion - 0.6 * dt);
    if (!danger && this.suspicion > this.nerve) danger = this.nearestSeeker(p)?.s ?? null;
    return danger;
  }

  startFlee(p, seeker, actions) {
    this.state = 'flee';
    this.threatId = seeker.id;
    this.suspicion = 0;
    this.fleeT = 0;
    this.stuckCount = 0;
    // Koeder in der aktuellen Pose zuruecklassen, dann erst loslaufen.
    this.fleeDelay = 0;
    if (p.decoyCd <= 0 && this.rng() < 0.7) { actions.decoy = true; this.fleeDelay = 0.1; }
    this.planFlee(p, seeker);
  }

  planFlee(p, s) {
    const myD = Math.hypot(p.x - s.x, p.y - s.y);
    return this.pickTile(p, (x, y, t, d) => {
      const away = Math.hypot(x - s.x, y - s.y);
      let sc = away - d * 5 + (t === C.T_BUSH ? 40 : 0);
      if (!this.lineOfSight(s.x, s.y, x, y, 20)) sc += 160;   // Sichtlinie brechen
      if (away < myD) sc -= 200;                              // nicht auf den Jaeger zu
      return sc;
    }, 4, 16);
  }

  hiderFlee(p, dt, actions) {
    this.fleeT += dt;
    const s = this.game.players.get(this.threatId);
    const threat = s && s.alive && s.role === C.ROLE_SEEKER ? s : null;
    if (this.fleeDelay > 0) {
      this.fleeDelay -= dt;
      this.send(NO_KEYS, actions);
      return;
    }
    if (this.moveYaw !== null) this.turnTo(this.moveYaw, TURN_WALK * 1.2, dt);
    const res = this.moveAlong(p, dt, { sprint: p.stamina > 15 });
    if (res.status !== 'moving' && this.unstickT <= 0) {
      const safe = !threat || (Math.hypot(threat.x - p.x, threat.y - p.y) > 5 * C.TILE &&
        !this.lineOfSight(threat.x, threat.y, p.x, p.y, 12));
      if (safe || this.fleeT > 7) {
        // In der Naehe neu verstecken und wieder anmalen.
        this.state = 'idle';
        this.nearOnly = true;
        this.setPath(null, null);
      } else if (this.planFlee(p, threat) < 0) {
        this.settleHere(p);            // in die Enge getrieben: hier tarnen
      }
    }
    this.send(res.keys, actions);
  }

  // ---------------------------------------------------------------- Jaeger
  /**
   * "Sieht" der Bot dieses Chamaeleon? Sichtlinie aus Augenhoehe, dann eine
   * Wahrscheinlichkeit aus Farbabweichung zum Hintergrund, Abstand, Bewegung.
   * (Ob es im Sichtfeld liegt, prueft der Aufrufer.)
   */
  perceive(p, h, dt) {
    const dx = h.x - p.x, dy = h.y - p.y;
    const dist = Math.hypot(dx, dy) / C.TILE;
    if (dist > VIEW_TILES) return false;
    const o = { x: p.x / TILE_PX, y: p.y / TILE_PX, h: C.EYE_H };
    const bodyH = C.POSES[h.pose]?.h ?? C.BODY_H;
    const target = { x: h.x / TILE_PX, y: h.y / TILE_PX, h: bodyH * 0.5 };
    const len = Math.hypot(target.x - o.x, target.y - o.y, target.h - o.h);
    if (len < 1e-6) return true;
    const d = { x: (target.x - o.x) / len, y: (target.y - o.y) / len, h: (target.h - o.h) / len };
    const block = raycast3D(this.game.map, o, d, len - 0.2);
    if (block) return false;                      // Mauer dazwischen
    // Hintergrund hinter der Figur bestimmen
    const behind = raycast3D(this.game.map, target, d, 12);
    const bg = surfaceColor(this.game.map, behind);
    const match = colorMatch(h.avgColor, bg);
    const moving = h.stillTime < 0.5;
    const poseBonus = h.pose === 0 ? 0 : 0.25;
    const near = Math.max(0.15, 1 - dist / VIEW_TILES);
    let perSec = moving ? 1.6 : (1 - match) * 0.9 + 0.05 - poseBonus * (1 - match);
    perSec *= near;
    if (h.paint === null) perSec = Math.max(perSec, 3.0 * Math.max(0.35, near));  // unbemalt = weiss = springt ins Auge
    // Aus naechster Naehe verraet auch die Silhouette eine gut bemalte Figur.
    perSec += 0.35 * Math.max(0, 1 - dist / 4);
    // Kleine Figur im Gebuesch ist zum Teil verdeckt.
    if (bodyH <= C.BUSH_H + 0.1 && this.game.map.tiles[idx(tileOf(h.x), tileOf(h.y))] === C.T_BUSH) perSec *= 0.4;
    const prob = 1 - Math.exp(-Math.max(0, perSec) * dt);
    return this.rng() < prob;
  }

  /** Freie Sicht aus Augenhoehe auf die Koerpermitte (fuer das Nachverfolgen und Schiessen). */
  canSeeBody(p, h) {
    const o = { x: p.x / TILE_PX, y: p.y / TILE_PX, h: C.EYE_H };
    const bodyH = C.POSES[h.pose]?.h ?? C.BODY_H;
    const t = { x: h.x / TILE_PX, y: h.y / TILE_PX, h: bodyH * 0.5 };
    const len = Math.hypot(t.x - o.x, t.y - o.y, t.h - o.h);
    if (len < 1e-6) return true;
    const d = { x: (t.x - o.x) / len, y: (t.y - o.y) / len, h: (t.h - o.h) / len };
    return !raycast3D(this.game.map, o, d, len - 0.2);
  }

  /** Annaehernd normalverteilte Zufallszahl (Mittel 0, Streuung 1). */
  gauss() { return (this.rng() + this.rng() + this.rng() - 1.5) * 2; }

  getTarget() {
    if (!this.target) return null;
    if (this.target.decoy) return this.game.decoys.find((d) => d.id === this.target.id) ?? null;
    const h = this.game.players.get(this.target.id);
    return h && h.alive && h.role === C.ROLE_HIDER ? h : null;
  }

  thinkSeeker(p, dt, phase) {
    if (phase !== C.PHASE_HUNT) {
      // Vorbereitung: eingefroren, nur langsam umschauen.
      this.prepLookT -= dt;
      if (this.prepLookT <= 0 || this.prepYaw === null) {
        this.prepLookT = 1.5 + this.rng() * 2;
        this.prepYaw = normAngle(this.yaw + (this.rng() - 0.5) * 2.4);
      }
      this.turnTo(this.prepYaw, TURN_SCAN * 0.6, dt);
      this.turnPitch(-0.1, TURN_PITCH, dt);
      this.send(NO_KEYS, null);
      return;
    }
    if (p.stunT > 0) {
      // Betaeubt (Koeder getroffen): benommen, danach neu orientieren.
      if (this.state === 'chase') { this.target = null; this.state = 'idle'; this.openingScan = true; }
      this.send(NO_KEYS, null);
      return;
    }
    this.markVisited(p);
    const actions = {};
    this.perceiveTick(p, dt);

    if (this.state === 'chase') { this.seekerChase(p, dt, actions); return; }

    if (this.state === 'idle') {
      // Nach Rundenstart oder Wiedereinstieg erst einmal umschauen.
      if (this.openingScan) { this.openingScan = false; this.startScan(p, true); }
      else this.startPatrol(p);
    }

    let keys = { ...NO_KEYS };
    // Etwas Auffaelliges bemerkt? Kurz stehen bleiben und genau hinschauen.
    const noticing = !!this.noticePos && this.noticeAge < NOTICE_STARE;
    if (noticing && (this.state === 'scan' || this.state === 'search' || this.state === 'patrol')) {
      this.turnTo(Math.atan2(this.noticePos.y - p.y, this.noticePos.x - p.x), TURN_SCAN * 1.3, dt);
      this.turnPitch(-0.12, TURN_PITCH, dt);
    } else if (this.state === 'scan') {
      const off = this.turnTo(this.scanDirs[this.scanIdx], TURN_SCAN, dt);
      if (off < 0.08) this.scanHold += dt;
      if (this.scanHold >= this.scanHoldFor[this.scanIdx]) {
        this.scanHold = 0;
        this.scanIdx++;
        if (this.scanIdx >= this.scanDirs.length) this.startPatrol(p);
      }
      this.turnPitch(-0.12, TURN_PITCH, dt);
    } else if (this.state === 'search' || this.state === 'patrol') {
      // Blick zuerst: Die Tasten werden relativ zum gesendeten Blick gewaehlt.
      if (this.moveYaw !== null) {
        // Beim Gehen den Blick schweifen lassen.
        const t = this.game.time;
        const sway = this.state === 'search' ? 0.2 * Math.sin(t * 1.3 + this.swayPhase)
          : 0.5 * Math.sin(t * 0.8 + this.swayPhase) + 0.15 * Math.sin(t * 2.1 + this.swayPhase * 2);
        this.turnTo(this.moveYaw + sway, TURN_WALK, dt);
      }
      this.turnPitch(-0.12 + Math.sin(this.game.time * 0.6 + this.swayPhase) * 0.06, TURN_PITCH, dt);
      const res = this.moveAlong(p, dt, { brake: true });
      keys = res.keys;
      if (this.state === 'search') this.searchT += dt;
      if (res.status === 'arrived' || (this.state === 'search' && this.searchT > 9)) {
        if (this.state === 'search' || this.rng() < 0.45) this.startScan(p, false);
        else this.startPatrol(p);
      } else if ((res.status === 'stuck' || res.status === 'none') && this.unstickT <= 0) {
        let ok = false;
        if (this.stuckCount < 3) {
          if (this.state === 'search') ok = this.pathToPoint(p, this.searchPoint.x, this.searchPoint.y);
          else if (this.pathTarget) ok = this.pathToPoint(p, this.pathTarget.x, this.pathTarget.y);
        }
        if (!ok) this.startPatrol(p);
      }
    }
    this.send(keys, actions);
  }

  /** Wahrnehmung einige Male pro Sekunde - nur, was im Sichtfeld liegt. */
  perceiveTick(p, dt) {
    this.noticeAge += dt;
    this.lookT -= dt;
    if (this.lookT > 0 || this.state === 'chase') return;
    this.lookT = PERCEIVE_EVERY;
    const cands = [];
    for (const h of this.game.players.values()) if (h.role === C.ROLE_HIDER && h.alive) cands.push(h);
    for (const dc of this.game.decoys) cands.push({ ...dc, stillTime: 99, isDecoy: true });
    let spotted = null, bestD = Infinity;
    for (const h of cands) {
      const dx = h.x - p.x, dy = h.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > VIEW_TILES * C.TILE) continue;
      const off = d < 1 ? 0 : Math.abs(angleDiff(this.yaw, Math.atan2(dy, dx)));
      if (off > FOV_HALF) continue;                                             // nicht im Sichtfeld
      const focus = off < 0.4 ? 1 : 1 - 0.6 * (off - 0.4) / (FOV_HALF - 0.4);  // am Rand unschaerfer
      if (!this.perceive(p, h, PERCEIVE_EVERY * focus)) continue;
      if (d < bestD) { bestD = d; spotted = h; }
    }
    if (spotted) {
      if (this.noticeId === spotted.id && this.noticeAge < 2.5) this.noticeT += PERCEIVE_EVERY;
      else { this.noticeId = spotted.id; this.noticeT = PERCEIVE_EVERY; }
      this.noticePos = { x: spotted.x, y: spotted.y };
      this.noticeAge = 0;
      // Zweimal kurz hintereinander bemerkt = erkannt.
      if (this.noticeT >= PERCEIVE_EVERY * 1.99) this.acquire(p, spotted);
      return;
    }
    if (this.noticeAge > 2.5) { this.noticeT = 0; this.noticeId = null; }
    if (this.state === 'patrol' || this.state === 'scan') this.checkSplats(p);
  }

  /** Ziel erfasst: Reaktionszeit und anfangs ungenaues Zielen, das sich einpendelt. */
  acquire(p, h) {
    this.state = 'chase';
    this.target = { id: h.id, decoy: !!h.isDecoy };
    this.lastKnown = { x: h.x, y: h.y };
    this.lostT = 0;
    this.reactT = this.reaction * (0.8 + this.rng() * 0.5);
    const distT = Math.hypot(h.x - p.x, h.y - p.y) / C.TILE;
    const e = (0.07 + 0.012 * distT) / this.skill;
    this.aimErrYaw = (this.rng() * 2 - 1) * e;
    this.aimErrPitch = (this.rng() * 2 - 1) * e * 0.5;
    this.onTargetT = 0;
    this.triggerDelay = 0.08 + this.rng() * 0.2;
    this.noticeT = 0;
    this.noticeId = null;
    this.noticePos = null;
    this.setPath(null, null);
    this.replanT = 0;
  }

  seekerChase(p, dt, actions) {
    const t = this.getTarget();
    if (!t) {
      // Gefangen oder Koeder verschwunden: kurz umschauen, dann weiter.
      this.target = null;
      this.startScan(p, false);
      this.send(NO_KEYS, actions);
      return;
    }
    const dx = t.x - p.x, dy = t.y - p.y;
    const distT = Math.hypot(dx, dy) / C.TILE;
    const visible = distT <= C.SHOT_RANGE && this.canSeeBody(p, t);
    if (visible) { this.lastKnown = { x: t.x, y: t.y }; this.lostT = 0; }
    else this.lostT += dt;
    if (this.lostT > 0.6) {
      // Aus den Augen verloren: zur letzten bekannten Stelle und dort suchen.
      this.target = null;
      this.startSearch(p, this.lastKnown);
      this.send(NO_KEYS, actions);
      return;
    }

    // Zielen: echter Winkel plus abklingender Fehler plus leichtes Zittern.
    const bodyH = C.POSES[t.pose]?.h ?? C.BODY_H;
    const trueYaw = Math.atan2(dy, dx);
    const truePitch = Math.atan2(bodyH * 0.5 - C.EYE_H, Math.max(0.3, distT));
    const decay = Math.exp(-dt / 0.35);
    this.aimErrYaw *= decay;
    this.aimErrPitch *= decay;
    const tr = 0.004 / this.skill, tm = this.game.time;
    this.reactT -= dt;
    if (this.reactT <= 0) {
      this.turnTo(trueYaw + this.aimErrYaw + Math.sin(tm * 7.3 + this.swayPhase) * tr, TURN_AIM, dt);
      this.turnPitch(truePitch + this.aimErrPitch + Math.cos(tm * 6.1 + this.swayPhase) * tr, TURN_PITCH * 1.6, dt);
    }

    // Abdruecken erst, wenn das Fadenkreuz eine Weile auf der Figur liegt.
    const errY = Math.abs(angleDiff(this.yaw, trueYaw));
    const errP = Math.abs(this.pitch - truePitch);
    // Toleranz etwas groesser als die Figur: Menschen druecken ab, wenn es "ungefaehr passt".
    const tolY = Math.atan2(C.BODY_R, Math.max(0.3, distT)) * 1.6;
    const tolP = Math.atan2(bodyH * 0.5, Math.max(0.3, distT)) * 1.1;
    if (visible && this.reactT <= 0 && errY < tolY && errP < tolP) this.onTargetT += dt;
    else this.onTargetT = 0;
    if (visible && p.shotCd <= 0 && distT < C.SHOT_RANGE - 0.5 && this.onTargetT >= this.triggerDelay) {
      actions.primary = true;
      this.onTargetT = 0;
      this.triggerDelay = 0.05 + this.rng() * 0.2;
      // Beim Abdruecken zuckt die Hand: Dieser Fehler gilt schon fuer diesen
      // Schuss (auf Distanz geht so mancher knapp vorbei) und klingt danach ab.
      const sigma = 0.012 + 0.02 / this.skill;
      const jy = this.gauss() * sigma, jp = this.gauss() * sigma * 0.6;
      this.yaw = normAngle(this.yaw + jy);
      this.pitch += jp;
      this.aimErrYaw += jy;
      this.aimErrPitch += jp;
    }

    // Bewegung: auf mittlere Distanz herangehen, nah dran stehen bleiben.
    let keys = { ...NO_KEYS };
    if (distT > 4.5 || !visible) {
      if (!this.path || this.replanT <= 0) { this.replanT = 0.5; this.pathToPoint(p, this.lastKnown.x, this.lastKnown.y); }
      this.replanT -= dt;
      keys = this.moveAlong(p, dt, { brake: false }).keys;
    } else {
      this.setPath(null, null);
    }
    // Sprint-Dash auf ein fliehendes Ziel, wenn der Weg frei ist.
    const tSpeed = Math.hypot(t.vx ?? 0, t.vy ?? 0);
    if (visible && distT > 4 && distT < 9 && p.dashCd <= 0 && tSpeed > 60 && errY < 0.3 &&
        clearLine(this.game.map, p.x, p.y, t.x, t.y) && this.rng() < dt * 1.5) {
      actions.dash = true;
      keys = this.keysForDir(dx / (distT * C.TILE), dy / (distT * C.TILE));
    }
    this.send(keys, actions);
  }

  /**
   * Umschauen im Stand: offene Richtungen der Reihe nach in einer Drehrichtung
   * abfahren (kein Hin-und-Her), jeweils kurz verweilen.
   */
  startScan(p, full) {
    this.state = 'scan';
    this.setPath(null, null);
    const side = this.rng() < 0.5 ? 1 : -1;
    const span = full ? TAU * 0.92 : Math.PI * (0.8 + this.rng() * 0.6);
    const n = 12;
    const dirs = [];
    for (let k = 1; k <= n; k++) {
      const rel = (k / n) * TAU;
      if (rel > span) break;
      const a = normAngle(this.yaw + side * rel);
      const far = 12 * C.TILE;
      const hit = raycastSolid(this.game.map, p.x, p.y, p.x + Math.cos(a) * far, p.y + Math.sin(a) * far, 8);
      if (!hit || hit.t * 12 >= 3) dirs.push(a);
    }
    // Einige Blickpunkte, gleichmaessig ueber die offenen Richtungen verteilt.
    const want = full ? 4 : 2 + ((this.rng() * 2) | 0);
    let pick = dirs;
    if (dirs.length > want) {
      pick = [];
      for (let i = 0; i < want; i++) pick.push(dirs[Math.round(((i + 1) * dirs.length) / want) - 1]);
    }
    if (!pick.length) pick = [normAngle(this.yaw + side * 1.6), normAngle(this.yaw - side * 0.8)];
    this.scanDirs = pick;
    this.scanHoldFor = pick.map(() => 0.3 + this.rng() * 0.45);
    this.scanIdx = 0;
    this.scanHold = 0;
  }

  startSearch(p, pt) {
    this.state = 'search';
    this.searchPoint = { x: pt.x, y: pt.y };
    this.searchT = 0;
    this.stuckCount = 0;
    this.pathToPoint(p, pt.x, pt.y);
    if (!this.path) this.startScan(p, false);
  }

  /**
   * Patrouille: bevorzugt lange nicht besuchte Gegenden, Verstecke (Mauern,
   * Gebuesch) und Bereiche, in denen gerade kein anderer Jaeger ist.
   */
  startPatrol(p) {
    const info = mapInfo(this.game.map);
    const now = this.game.time;
    const mates = [];
    for (const o of this.game.players.values()) {
      if (o.id !== this.id && o.role === C.ROLE_SEEKER && o.alive) mates.push(o);
    }
    this.state = 'patrol';
    this.stuckCount = 0;
    const ok = this.pickTile(p, (x, y, t, d, i) => {
      const since = Math.min(90, now - this.visitedAt(x, y));
      let sc = since * 1.2 - Math.abs(d - 14) * 1.5;
      if (t === C.T_BUSH) sc += 12;
      if (info.wall[i]) sc += 10;
      for (const m of mates) {
        const md = Math.hypot(m.x - x, m.y - y);
        if (md < 8 * C.TILE) sc -= (8 * C.TILE - md) * 0.3;
      }
      return sc;
    }, 6, 32);
    if (ok < 0 && this.pickTile(p, () => 0, 1, 60) < 0) this.startScan(p, false);
  }

  visitedAt(x, y) {
    if (!this.visited) return -1e9;
    const cx = clamp(Math.floor(tileOf(x) / CELL), 0, CELLS_X - 1);
    const cy = clamp(Math.floor(tileOf(y) / CELL), 0, CELLS_Y - 1);
    return this.visited[cy * CELLS_X + cx];
  }

  markVisited(p) {
    if (!this.visited) this.visited = new Float64Array(CELLS_X * CELLS_Y).fill(-1e9);
    const cx = clamp(Math.floor(tileOf(p.x) / CELL), 0, CELLS_X - 1);
    const cy = clamp(Math.floor(tileOf(p.y) / CELL), 0, CELLS_Y - 1);
    this.visited[cy * CELLS_X + cx] = this.game.time;
  }

  /** Frische Farbkleckse im Blickfeld verraten sprintende Chamaeleons: hingehen. */
  checkSplats(p) {
    let best = null, bestT = 0;
    for (const s of this.game.splats) {
      if (s.t < C.SPLAT_LIFETIME - 5 || s.t <= bestT) continue;
      const key = s.seed + ':' + Math.round(s.x) + ':' + Math.round(s.y);
      if (this.checkedSplats.has(key)) continue;
      const dx = s.x - p.x, dy = s.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > 12 * C.TILE || d < 2 * C.TILE) continue;
      if (Math.abs(angleDiff(this.yaw, Math.atan2(dy, dx))) > FOV_HALF) continue;
      if (!this.lineOfSight(p.x, p.y, s.x, s.y, 12)) continue;
      best = { s, key };
      bestT = s.t;
    }
    if (!best) return;
    this.checkedSplats.add(best.key);
    if (this.checkedSplats.size > 400) this.checkedSplats.clear();
    this.startSearch(p, { x: best.s.x, y: best.s.y });
  }
}
