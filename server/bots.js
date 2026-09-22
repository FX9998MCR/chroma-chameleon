// KI-Mitspieler. Bots sind normale Spieler in der Simulation - sie erzeugen
// dieselben Eingaben wie ein Mensch (Tasten, Blickrichtung, Aktionen) und
// unterliegen denselben Regeln.
//
// Chamaeleon-Bots: Versteck suchen, Koerper in Boden- oder Wandfarbe malen,
// Pose einnehmen, stillhalten, bei Gefahr fliehen.
// Jaeger-Bots: patrouillieren, "sehen" Chamaeleons nur mit Sichtlinie und
// mit einer Wahrscheinlichkeit, die von Farbabweichung, Abstand und Bewegung
// abhaengt - eine ehrliche Naeherung an das menschliche Hinschauen.

import * as C from '../shared/constants.js';
import { idx, inBounds, TILE_PX, tileColorAt, wallColorAt, surfaceColor } from '../shared/map.js';
import { colorMatch, raycast3D, dirFromAngles } from '../shared/physics.js';

export const BOT_NAMES = [
  'Bot Kiwi', 'Bot Mango', 'Bot Pixel', 'Bot Nova', 'Bot Ziggy', 'Bot Momo',
  'Bot Luna', 'Bot Taro', 'Bot Fibi', 'Bot Ollie', 'Bot Suki', 'Bot Remy',
];

const tileOf = (v) => Math.floor(v / C.TILE);
const centerOf = (t) => t * C.TILE + C.TILE / 2;

/** Breitensuche ueber begehbare Kacheln ab einer Startkachel. */
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

const NO_KEYS = { up: false, down: false, left: false, right: false, sprint: false, paint: false };

/** Nachbar-Mauer einer Kachel (fuer "Wandpresse"): Richtung und Farbe. */
function adjacentWall(map, tx, ty) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = tx + dx, ny = ty + dy;
    if (!inBounds(nx, ny)) continue;
    if (map.tiles[idx(nx, ny)] === C.T_WALL) return { dx, dy, color: wallColorAt(map, nx, ny) };
  }
  return null;
}

export class BotBrain {
  constructor(game, playerId, rng = Math.random) {
    this.game = game;
    this.id = playerId;
    this.rng = rng;
    this.state = 'idle';
    this.path = null;
    this.pathTarget = null;
    this.replanT = 0;
    this.paintT = 0;
    this.lastRole = null;
    this.lastPhase = null;
    this.lostT = 0;
    this.lastKnown = null;
    this.reaction = 0.3 + rng() * 0.4;
    this.seenT = 0;
    this.chaseTarget = null;
    this.stuckT = 0;
    this.lastPos = { x: 0, y: 0 };
    this.wanderT = 0;
    this.lookT = 0;          // Zeit bis zum naechsten "Hinschauen"
    this.hideWall = null;
    this.yaw = 0;
    this.pitch = 0;
  }

  get p() { return this.game.players.get(this.id); }

  think(dt) {
    const p = this.p;
    if (!p) return;
    const phase = this.game.phase;

    if (p.role !== this.lastRole || phase !== this.lastPhase) {
      this.lastRole = p.role; this.lastPhase = phase;
      this.path = null; this.pathTarget = null; this.state = 'idle';
      this.chaseTarget = null; this.lastKnown = null; this.paintT = 0;
    }

    if (!p.alive || phase === C.PHASE_OVER || phase === C.PHASE_LOBBY) {
      this.send(NO_KEYS, null);
      return;
    }

    const moved = Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y);
    this.lastPos = { x: p.x, y: p.y };
    if (this.path && moved < 0.5 && this.paintT <= 0) {
      this.stuckT += dt;
      if (this.stuckT > 0.8) { this.path = null; this.pathTarget = null; this.stuckT = 0; }
    } else this.stuckT = 0;

    if (p.role === C.ROLE_HIDER) this.thinkHider(p, dt, phase);
    else this.thinkSeeker(p, dt, phase);
  }

  send(keys, actions) {
    this.game.setInput(this.id, keys, actions, { yaw: this.yaw, pitch: this.pitch }, 0);
  }

  // ---------------------------------------------------------------- Wege
  search(p) { return bfs(this.game.map, tileOf(p.x), tileOf(p.y)); }

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
    if (best < 0) return false;
    this.path = pathTo(s, best);
    this.pathTarget = { x: centerOf(best % C.MAP_W), y: centerOf((best / C.MAP_W) | 0) };
    return true;
  }

  pathToPoint(p, x, y) {
    const s = this.search(p);
    const ti = idx(tileOf(x), tileOf(y));
    let target = ti;
    if (s.dist[ti] < 0) {
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

  /**
   * Tasten, die den Bot entlang seines Weges fuehren. Der Bot schaut in
   * Laufrichtung, deshalb reicht "vor"; bei festem Blick (Jagd) wird die
   * Richtung relativ zum Blick in vor/seitlich zerlegt.
   */
  followPath(p, sprint, lookAt = null) {
    if (!this.path || this.path.length === 0) return { ...NO_KEYS };
    while (this.path.length && Math.hypot(this.path[0].x - p.x, this.path[0].y - p.y) < 7) this.path.shift();
    if (!this.path.length) return { ...NO_KEYS };
    const wp = this.path[0];
    const dx = wp.x - p.x, dy = wp.y - p.y;
    return this.keysToward(dx, dy, sprint, lookAt);
  }

  keysToward(dx, dy, sprint, lookAt = null) {
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { ...NO_KEYS };
    if (lookAt) {
      this.yaw = Math.atan2(lookAt.y - this.p.y, lookAt.x - this.p.x);
    } else {
      this.yaw = Math.atan2(dy, dx);
    }
    // Wunschrichtung in Blick-Koordinaten zerlegen.
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const f = (dx * c + dy * s) / len;
    const r = (-dx * s + dy * c) / len;
    const keys = { ...NO_KEYS, sprint: !!sprint };
    if (f > 0.3) keys.up = true; else if (f < -0.3) keys.down = true;
    if (r > 0.3) keys.right = true; else if (r < -0.3) keys.left = true;
    return keys;
  }

  arrived(p) {
    return this.pathTarget && Math.hypot(this.pathTarget.x - p.x, this.pathTarget.y - p.y) < 10;
  }

  // ---------------------------------------------------------------- Chamaeleon
  thinkHider(p, dt, phase) {
    const map = this.game.map;
    const seekers = this.game.seekers.filter((s) => s.alive);
    let nearest = null, nd = Infinity;
    for (const s of seekers) { const d = Math.hypot(s.x - p.x, s.y - p.y); if (d < nd) { nd = d; nearest = s; } }
    const threatOrigin = nearest ?? this.game.seekerSpawn;
    const inHunt = phase === C.PHASE_HUNT;
    const actions = {};

    // Gefahr: Jaeger nah UND er schaut grob in unsere Richtung.
    let danger = false;
    if (inHunt && nearest && nd < 7 * C.TILE) {
      const toMe = Math.atan2(p.y - nearest.y, p.x - nearest.x);
      let diff = Math.abs(((toMe - nearest.yaw) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      danger = nd < 2.2 * C.TILE || (diff < 0.5 && nd < 5 * C.TILE) || (p.paint === null && nd < 6 * C.TILE);
    }

    if (danger && this.state !== 'flee') {
      this.state = 'flee';
      this.path = null;
      if (p.decoyCd <= 0 && this.rng() < 0.7) actions.decoy = true;
    }

    if (this.state === 'flee') {
      if (!nearest || nd > 12 * C.TILE) { this.state = 'idle'; this.path = null; }
      else {
        if (!this.path || this.replanT <= 0) {
          this.replanT = 1.2;
          this.pickTile(p, (x, y, t, d) => {
            const away = Math.hypot(x - threatOrigin.x, y - threatOrigin.y);
            return away * 1.0 - d * 6 + (t === C.T_BUSH ? 40 : 0);
          }, 5, 16);
        }
        this.replanT -= dt;
        this.send(this.followPath(p, p.stamina > 15), actions);
        return;
      }
    }

    // Versteck suchen: weit weg vom Jaegerstart, gern an einer Mauer oder im Gebuesch.
    if (this.state === 'idle') {
      const ok = this.pickTile(p, (x, y, t, d, i) => {
        const away = Math.hypot(x - threatOrigin.x, y - threatOrigin.y);
        const tx = i % C.MAP_W, ty = (i / C.MAP_W) | 0;
        const wall = adjacentWall(map, tx, ty) ? 70 : 0;
        return Math.min(away, 900) * 0.6 + (t === C.T_BUSH ? 60 : 0) + wall - d * 4;
      }, 3, inHunt ? 14 : 40);
      this.state = ok ? 'travel' : 'paint';
      this.paintT = 0;
    }

    if (this.state === 'travel') {
      if (this.arrived(p) || !this.path?.length) { this.state = 'paint'; this.paintT = 2.5 + this.rng() * 2; this.path = null; }
      else {
        this.send(this.followPath(p, phase === C.PHASE_PREP && p.stamina > 30), actions);
        return;
      }
    }

    if (this.state === 'paint') {
      // Malmodus: eingefroren; nach der Malzeit wird die Bemalung gesetzt.
      this.paintT -= dt;
      if (this.paintT <= 0) {
        const tx = tileOf(p.x), ty = tileOf(p.y);
        const wall = adjacentWall(map, tx, ty);
        let color, pose;
        if (wall) {
          color = wall.color;
          pose = 4;                                    // Wandpresse
          this.yaw = Math.atan2(-wall.dy, -wall.dx);   // Ruecken zur Wand
        } else {
          color = tileColorAt(map, p.x, p.y);
          pose = this.rng() < 0.5 ? 3 : 5;             // Liegen oder Kugel
        }
        this.game.setPaint(this.id, { fill: color.slice() }, color.slice());
        this.game.pushEvent({ k: 'paint', id: this.id, paint: { fill: color.slice() } });
        this.wantPose = pose;
        this.state = 'pose';
        this.send(NO_KEYS, null);
        return;
      }
      this.send({ ...NO_KEYS, paint: true }, actions);
      return;
    }

    if (this.state === 'pose') {
      if (p.pose !== this.wantPose) { this.send(NO_KEYS, { pose: true }); return; }
      this.state = 'hide';
      this.wanderT = 20 + this.rng() * 40;
    }

    // Stillhalten. Gelegentlich das Versteck wechseln, wenn kein Jaeger nah ist.
    this.wanderT -= dt;
    if (this.wanderT <= 0 && (!nearest || nd > 12 * C.TILE)) { this.state = 'idle'; }
    this.send(NO_KEYS, actions);
  }

  // ---------------------------------------------------------------- Jaeger
  /**
   * "Sieht" der Bot dieses Chamaeleon? Sichtlinie aus Augenhoehe, dann eine
   * Wahrscheinlichkeit aus Farbabweichung zum Hintergrund, Abstand, Bewegung.
   */
  perceive(p, h, dt) {
    const dx = h.x - p.x, dy = h.y - p.y;
    const dist = Math.hypot(dx, dy) / C.TILE;
    if (dist > 14) return false;
    const o = { x: p.x / TILE_PX, y: p.y / TILE_PX, h: C.EYE_H };
    const bodyH = C.POSES[h.pose]?.h ?? C.BODY_H;
    const target = { x: h.x / TILE_PX, y: h.y / TILE_PX, h: bodyH * 0.5 };
    const len = Math.hypot(target.x - o.x, target.y - o.y, target.h - o.h);
    const d = { x: (target.x - o.x) / len, y: (target.y - o.y) / len, h: (target.h - o.h) / len };
    const block = raycast3D(this.game.map, o, d, len - 0.2);
    if (block) return false;                      // Mauer dazwischen
    // Hintergrund hinter der Figur bestimmen
    const behind = raycast3D(this.game.map, target, d, 12);
    const bg = surfaceColor(this.game.map, behind);
    const match = colorMatch(h.avgColor, bg);
    const moving = h.stillTime < 0.5;
    const poseBonus = h.pose === 0 ? 0 : 0.25;
    let perSec = moving ? 1.2 : (1 - match) * 0.9 + 0.05 - poseBonus * (1 - match);
    perSec *= Math.max(0.15, 1 - dist / 14);
    if (h.paint === null) perSec = Math.max(perSec, 0.8 * Math.max(0.15, 1 - dist / 14));  // unbemalt = weiss = auffaellig
    const prob = 1 - Math.exp(-Math.max(0, perSec) * dt);
    return this.rng() < prob;
  }

  thinkSeeker(p, dt, phase) {
    if (phase !== C.PHASE_HUNT || p.stunT > 0) { this.send(NO_KEYS, null); return; }
    const actions = {};

    // Wahrnehmung nur ein paar Mal pro Sekunde, das reicht und spart Rechenzeit.
    this.lookT -= dt;
    let spotted = null;
    if (this.lookT <= 0) {
      this.lookT = 0.25;
      const cands = [];
      for (const h of this.game.players.values()) if (h.role === C.ROLE_HIDER && h.alive) cands.push(h);
      for (const dc of this.game.decoys) cands.push({ ...dc, stillTime: 99, paint: dc.paint, avgColor: dc.avgColor, isDecoy: true });
      let bestD = Infinity;
      for (const h of cands) {
        if (!this.perceive(p, h, 0.25)) continue;
        const d = Math.hypot(h.x - p.x, h.y - p.y);
        if (d < bestD) { bestD = d; spotted = h; }
      }
    }
    if (spotted) {
      this.seenT += 0.25;
      if (this.seenT >= this.reaction) {
        this.chaseTarget = spotted;
        this.lastKnown = { x: spotted.x, y: spotted.y, pose: spotted.pose };
        this.lostT = 0;
        this.state = 'chase';
      }
    } else if (this.lookT === 0.25) {
      this.seenT = Math.max(0, this.seenT - 0.1);
    }
    if (this.state === 'chase') {
      this.lostT += dt;
      if (this.lostT > 4) { this.state = 'idle'; this.chaseTarget = null; this.path = null; }
    }

    if (this.state === 'chase' && this.lastKnown) {
      const goal = this.lastKnown;
      const dx = goal.x - p.x, dy = goal.y - p.y;
      const dist = Math.hypot(dx, dy) / C.TILE;
      // Auf Koerpermitte zielen
      const bodyH = C.POSES[goal.pose]?.h ?? C.BODY_H;
      this.yaw = Math.atan2(dy, dx);
      this.pitch = Math.atan2(bodyH * 0.5 - C.EYE_H, Math.max(0.3, dist));
      if (dist < 11 && p.shotCd <= 0 && this.lostT < 0.6) actions.primary = true;
      if (dist > 4 && dist < 9 && p.dashCd <= 0 && this.rng() < 0.4) actions.dash = true;
      if (!this.path || this.replanT <= 0) { this.replanT = 0.5; this.pathToPoint(p, goal.x, goal.y); }
      this.replanT -= dt;
      const keys = dist > 2.5 ? this.followPath(p, false, goal) : { ...NO_KEYS };
      this.send(keys, actions);
      return;
    }

    if (this.state === 'idle' || this.arrived(p) || !this.path?.length) {
      this.state = 'patrol';
      this.pickTile(p, (x, y, t, d) => d * 3 + (t === C.T_BUSH ? 25 : 0), 8, 30);
    }
    // Beim Patrouillieren den Blick leicht schweifen lassen.
    this.pitch = -0.15 + Math.sin(this.game.time * 0.7) * 0.1;
    this.send(this.followPath(p, false), actions);
  }
}
