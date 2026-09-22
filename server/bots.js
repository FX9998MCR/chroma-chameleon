// KI-Mitspieler. Bots sind normale Spieler in der Simulation - sie erzeugen
// dieselben Eingaben wie ein Mensch (Tasten, Zielwinkel, Aktionen) und
// unterliegen denselben Regeln. Sie "sehen" nur, was ein Mensch in ihrer
// Rolle auch saehe: Chamaeleon-Bots kennen Jaegerpositionen in Sichtweite,
// Jaeger-Bots nutzen exakt die Sichtbarkeitsrechnung der Snapshots.

import * as C from '../shared/constants.js';
import { idx, inBounds } from '../shared/map.js';
import { baseVisibility, visibilityForSeeker, angleDiff } from '../shared/physics.js';

export const BOT_NAMES = [
  'Bot Kiwi', 'Bot Mango', 'Bot Pixel', 'Bot Nova', 'Bot Ziggy', 'Bot Momo',
  'Bot Luna', 'Bot Taro', 'Bot Fibi', 'Bot Ollie', 'Bot Suki', 'Bot Remy',
];

const tileOf = (v) => Math.floor(v / C.TILE);
const centerOf = (t) => t * C.TILE + C.TILE / 2;

/**
 * Breitensuche ueber begehbare Kacheln ab einer Startkachel.
 * Liefert Distanz (in Kacheln, -1 = unerreichbar) und Vorgaenger je Kachel.
 */
export function bfs(map, startTx, startTy) {
  const n = C.MAP_W * C.MAP_H;
  const dist = new Int16Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const start = idx(startTx, startTy);
  if (!inBounds(startTx, startTy) || C.SOLID_TILES.has(map.tiles[start])) return { dist, parent };
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  queue[tail++] = start;
  dist[start] = 0;
  while (head < tail) {
    const i = queue[head++];
    const tx = i % C.MAP_W, ty = (i / C.MAP_W) | 0;
    const nb = [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]];
    for (const [nx, ny] of nb) {
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
  if (search.dist[targetIdx] < 0) return null;
  const out = [];
  let i = targetIdx;
  while (i >= 0) {
    out.push({ x: centerOf(i % C.MAP_W), y: centerOf((i / C.MAP_W) | 0) });
    i = search.parent[i];
  }
  out.reverse();
  return out;
}

const NO_KEYS = { up: false, down: false, left: false, right: false, sprint: false, absorb: false };

export class BotBrain {
  constructor(game, playerId, rng = Math.random) {
    this.game = game;
    this.id = playerId;
    this.rng = rng;
    this.state = 'idle';
    this.path = null;
    this.pathTarget = null;
    this.replanT = 0;
    this.thinkT = 0;
    this.absorbT = 0;
    this.lastRole = null;
    this.lastPhase = null;
    this.lostT = 0;
    this.lastKnown = null;
    this.reaction = 0.25 + rng() * 0.3;   // Sekunden bis eine Sichtung zaehlt
    this.seenT = 0;
    this.chaseTarget = null;
    this.stuckT = 0;
    this.lastPos = { x: 0, y: 0 };
    this.wanderT = 0;
  }

  get p() { return this.game.players.get(this.id); }

  /** Ein Denkschritt; wird vor jedem Simulationstakt aufgerufen. */
  think(dt) {
    const p = this.p;
    if (!p) return;
    const phase = this.game.phase;

    // Rollen- oder Phasenwechsel: Plan verwerfen.
    if (p.role !== this.lastRole || phase !== this.lastPhase) {
      this.lastRole = p.role; this.lastPhase = phase;
      this.path = null; this.pathTarget = null; this.state = 'idle';
      this.chaseTarget = null; this.lastKnown = null; this.absorbT = 0;
    }

    if (!p.alive || phase === C.PHASE_OVER || phase === C.PHASE_LOBBY) {
      this.game.setInput(this.id, NO_KEYS, null, p.aim, 0);
      return;
    }

    // Steckt der Bot fest? Dann neu planen.
    const moved = Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y);
    this.lastPos = { x: p.x, y: p.y };
    if (this.path && moved < 0.5 && !p.grapple && this.absorbT <= 0) {
      this.stuckT += dt;
      if (this.stuckT > 0.8) { this.path = null; this.pathTarget = null; this.stuckT = 0; }
    } else this.stuckT = 0;

    if (p.role === C.ROLE_HIDER) this.thinkHider(p, dt, phase);
    else this.thinkSeeker(p, dt, phase);
  }

  // ---------------------------------------------------------------- Wege
  /** BFS ab eigener Position; wird nur bei Bedarf gerechnet. */
  search(p) {
    return bfs(this.game.map, tileOf(p.x), tileOf(p.y));
  }

  /** Waehlt aus erreichbaren Kacheln die mit dem besten Score. */
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
      const sc = score(x, y, t, d) + this.rng() * 30;
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (best < 0) return false;
    this.path = pathTo(s, best);
    this.pathTarget = { x: centerOf(best % C.MAP_W), y: centerOf((best / C.MAP_W) | 0) };
    return true;
  }

  /** Weg zu einer Weltposition (naechste begehbare Kachel). */
  pathToPoint(p, x, y) {
    const s = this.search(p);
    const ti = idx(tileOf(x), tileOf(y));
    let target = ti;
    if (s.dist[ti] < 0) {
      // Zielkachel selbst nicht erreichbar (z. B. Mauer): naechste erreichbare suchen.
      let bd = Infinity;
      for (let i = 0; i < s.dist.length; i++) {
        if (s.dist[i] < 0) continue;
        const dx = centerOf(i % C.MAP_W) - x, dy = centerOf((i / C.MAP_W) | 0) - y;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; target = i; }
      }
    }
    this.path = pathTo(s, target);
    this.pathTarget = { x, y };
    return !!this.path;
  }

  /** Tasten, die den Bot entlang seines Weges fuehren. */
  followPath(p, sprint) {
    if (!this.path || this.path.length === 0) return { ...NO_KEYS };
    // Erreichte Wegpunkte abhaken.
    while (this.path.length && Math.hypot(this.path[0].x - p.x, this.path[0].y - p.y) < 7) this.path.shift();
    if (!this.path.length) return { ...NO_KEYS };
    const wp = this.path[0];
    const dx = wp.x - p.x, dy = wp.y - p.y;
    const keys = { ...NO_KEYS, sprint: !!sprint };
    if (dx > 2) keys.right = true; else if (dx < -2) keys.left = true;
    if (dy > 2) keys.down = true; else if (dy < -2) keys.up = true;
    return keys;
  }

  arrived(p) {
    return this.pathTarget && Math.hypot(this.pathTarget.x - p.x, this.pathTarget.y - p.y) < 10;
  }

  // ---------------------------------------------------------------- Chamaeleon
  thinkHider(p, dt, phase) {
    const seekers = this.game.seekers.filter((s) => s.alive && Math.hypot(s.x - p.x, s.y - p.y) < C.VIEW_RADIUS);
    let nearest = null, nd = Infinity;
    for (const s of seekers) { const d = Math.hypot(s.x - p.x, s.y - p.y); if (d < nd) { nd = d; nearest = s; } }
    const threatOrigin = nearest ?? this.game.seekerSpawn;
    const vis = baseVisibility(this.game.map, p);

    // Fluchtentscheidung: nah und schlecht getarnt, oder sehr nah.
    const inHunt = phase === C.PHASE_HUNT;
    const danger = inHunt && nearest && (nd < 105 || (nd < 210 && vis > 0.35) || (nd < 150 && p.markT > 0));
    const actions = {};

    if (danger && this.state !== 'flee') {
      this.state = 'flee';
      this.path = null;
      if (p.decoyCd <= 0 && this.rng() < 0.8) actions.decoy = true;
    }

    if (this.state === 'flee') {
      if (!nearest || nd > 420) { this.state = 'idle'; this.path = null; }
      else {
        if (!this.path || this.replanT <= 0) {
          this.replanT = 1.2;
          this.pickTile(p, (x, y, t, d) => {
            const away = Math.hypot(x - threatOrigin.x, y - threatOrigin.y);
            return away * 1.0 - d * 6 + (t === C.T_BUSH ? 40 : 0);
          }, 5, 16);
        }
        this.replanT -= dt;
        // Haken als Fluchtmittel: Anker grob in Fluchtrichtung.
        if (p.grappleCd <= 0 && this.pathTarget) {
          const want = Math.atan2(this.pathTarget.y - p.y, this.pathTarget.x - p.x);
          for (const a of this.game.map.anchors) {
            const d = Math.hypot(a.x - p.x, a.y - p.y);
            if (d < 120 || d > C.GRAPPLE_RANGE) continue;
            const ang = Math.atan2(a.y - p.y, a.x - p.x);
            if (Math.abs(angleDiff(want, ang)) < 0.28) { p.aim = ang; actions.grapple = true; this.path = null; break; }
          }
        }
        const keys = this.followPath(p, p.stamina > 15);
        this.game.setInput(this.id, keys, actions, actions.grapple ? p.aim : this.aimAlong(p, keys), 0);
        return;
      }
    }

    // Versteck suchen
    if (this.state === 'idle') {
      const ok = this.pickTile(p, (x, y, t, d) => {
        const away = Math.hypot(x - threatOrigin.x, y - threatOrigin.y);
        return Math.min(away, 900) * 0.6 + (t === C.T_BUSH ? 90 : 0) - d * 4;
      }, 3, inHunt ? 14 : 40);
      this.state = ok ? 'travel' : 'hide';
    }

    if (this.state === 'travel') {
      if (this.arrived(p) || !this.path?.length) { this.state = 'absorb'; this.absorbT = C.ABSORB_TIME + 0.3; this.path = null; }
      else {
        const keys = this.followPath(p, phase === C.PHASE_PREP && p.stamina > 30);
        this.game.setInput(this.id, keys, actions, this.aimAlong(p, keys), 0);
        return;
      }
    }

    if (this.state === 'absorb') {
      this.absorbT -= dt;
      this.game.setInput(this.id, { ...NO_KEYS, absorb: true }, actions, p.aim, 0);
      if (this.absorbT <= 0) { this.state = 'hide'; this.wanderT = 12 + this.rng() * 25; }
      return;
    }

    // Stillhalten. Gelegentlich das Versteck wechseln, wenn kein Jaeger nah ist.
    this.wanderT -= dt;
    if (this.wanderT <= 0 && (!nearest || nd > 350)) { this.state = 'idle'; }
    // Farbe passt nicht mehr (z. B. nach Flucht)? Nachfaerben, wenn sicher.
    if (vis > 0.5 && (!nearest || nd > 260)) { this.state = 'absorb'; this.absorbT = C.ABSORB_TIME + 0.3; }
    this.game.setInput(this.id, NO_KEYS, actions, p.aim, 0);
  }

  aimAlong(p, keys) {
    const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    return (dx || dy) ? Math.atan2(dy, dx) : p.aim;
  }

  // ---------------------------------------------------------------- Jaeger
  thinkSeeker(p, dt, phase) {
    if (phase !== C.PHASE_HUNT || p.stunT > 0) {
      this.game.setInput(this.id, NO_KEYS, null, p.aim, 0);
      return;
    }
    const actions = {};

    // Sichtbare Ziele mit exakt der Snapshot-Logik bewerten - auch Koeder.
    let target = null, td = Infinity, tAlpha = 0;
    const consider = (x, y, obj, alpha) => {
      const d = Math.hypot(x - p.x, y - p.y);
      if (alpha < 0.3 || d > 520) return;
      if (d < td) { td = d; target = obj; tAlpha = alpha; }
    };
    for (const h of this.game.players.values()) {
      if (h.role !== C.ROLE_HIDER || !h.alive) continue;
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d > C.VIEW_RADIUS) continue;
      consider(h.x, h.y, h, visibilityForSeeker(baseVisibility(this.game.map, h), d, h.markT));
    }
    for (const dc of this.game.decoys) {
      const d = Math.hypot(dc.x - p.x, dc.y - p.y);
      const fake = { x: dc.x, y: dc.y, color: dc.color, stillTime: 99, shimmer: 0 };
      consider(dc.x, dc.y, dc, visibilityForSeeker(baseVisibility(this.game.map, fake), d, 0));
    }

    // Reaktionszeit: erst nach kurzer Sichtung wird verfolgt.
    if (target) { this.seenT += dt; } else { this.seenT = 0; }
    if (target && this.seenT >= this.reaction) {
      this.chaseTarget = target;
      this.lastKnown = { x: target.x, y: target.y };
      this.lostT = 0;
      this.state = 'chase';
    } else if (this.state === 'chase') {
      this.lostT += dt;
      if (this.lostT > 2.5) { this.state = 'idle'; this.chaseTarget = null; this.path = null; }
    }

    // Scan regelmaessig, bevorzugt wenn kein Ziel in Sicht.
    if (p.scanCd <= 0 && (!target || this.rng() < 0.02)) actions.scan = true;

    if (this.state === 'chase' && this.lastKnown) {
      const goal = this.chaseTarget && target === this.chaseTarget ? { x: target.x, y: target.y } : this.lastKnown;
      const d = Math.hypot(goal.x - p.x, goal.y - p.y);
      const aim = Math.atan2(goal.y - p.y, goal.x - p.x);
      if (target && d < C.CATCH_RANGE + 4 && p.catchCd <= 0) actions.primary = true;
      if (target && d > 110 && d < 260 && p.dashCd <= 0 && this.rng() < 0.5) actions.dash = true;
      if (!this.path || this.replanT <= 0) { this.replanT = 0.4; this.pathToPoint(p, goal.x, goal.y); }
      this.replanT -= dt;
      // Auf den letzten Metern direkt zulaufen statt Kachel-genau.
      let keys;
      if (d < 40) {
        keys = { ...NO_KEYS };
        if (goal.x - p.x > 3) keys.right = true; else if (goal.x - p.x < -3) keys.left = true;
        if (goal.y - p.y > 3) keys.down = true; else if (goal.y - p.y < -3) keys.up = true;
      } else keys = this.followPath(p, false);
      this.game.setInput(this.id, keys, actions, aim, 0);
      return;
    }

    // Patrouille: zufaellige, eher weit entfernte Ziele; Bueschen einen Blick goennen.
    if (this.state === 'idle' || this.arrived(p) || !this.path?.length) {
      this.state = 'patrol';
      this.pickTile(p, (x, y, t, d) => d * 3 + (t === C.T_BUSH ? 25 : 0), 8, 30);
    }
    const keys = this.followPath(p, false);
    this.game.setInput(this.id, keys, actions, this.aimAlong(p, keys), 0);
  }
}
