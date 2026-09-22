// Bewegung, Kollision und 3D-Strahlen.
// Wird identisch auf Server (Autoritaet) und Client (Vorhersage, Kamera) ausgefuehrt.
// Koordinaten: x/y sind die Bodenebene in Pixeln (TILE px = 1 Meter),
// Hoehen (h) sind in Kacheln/Metern. Der Client rendert x -> X, y -> Z, h -> Y.

import {
  TILE, MAP_W, MAP_H, PLAYER_RADIUS, HIDER_SPEED, HIDER_SPRINT, SEEKER_SPEED, ACCEL, FRICTION,
  BUSH_SLOW, WATER_SLOW, T_BUSH, T_WATER, T_WALL, T_PILLAR, SOLID_TILES,
  WALL_H_INNER, WALL_H_EDGE, PILLAR_H, ROLE_HIDER, WORLD_W, WORLD_H,
} from './constants.js';
import { tileAt, idx, inBounds } from './map.js';

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Kuerzester Winkelabstand in [-PI, PI]. */
export function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Aehnlichkeit zweier RGB-Farben, 1 = identisch, 0 = maximal verschieden. */
export function colorMatch(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  // Gewichtete Distanz, das Auge sieht Gruen am schaerfsten.
  const d = Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db);
  return clamp(1 - d / 165, 0, 1);
}

/** Hoehe einer festen Kachel in Metern; 0 fuer begehbare. */
export function tileHeight(map, tx, ty) {
  if (!inBounds(tx, ty)) return WALL_H_EDGE;
  const t = map.tiles[idx(tx, ty)];
  if (t === T_PILLAR) return PILLAR_H;
  if (t === T_WALL) {
    const edge = tx < 2 || ty < 2 || tx >= MAP_W - 2 || ty >= MAP_H - 2;
    return edge ? WALL_H_EDGE : WALL_H_INNER;
  }
  return 0;
}

/** Tempofaktor des Untergrunds. */
export function terrainFactor(map, x, y) {
  const t = tileAt(map, x, y);
  if (t === T_BUSH) return BUSH_SLOW;
  if (t === T_WATER) return WATER_SLOW;
  return 1;
}

/** Hoechsttempo je Rolle und Zustand. */
export function maxSpeedFor(role, sprinting) {
  if (role === ROLE_HIDER) return sprinting ? HIDER_SPRINT : HIDER_SPEED;
  return SEEKER_SPEED;
}

/**
 * Prueft, ob ein Kreis mit Radius r an (x,y) eine feste Kachel schneidet.
 */
export function circleHitsSolid(map, x, y, r = PLAYER_RADIUS) {
  const x0 = Math.floor((x - r) / TILE), x1 = Math.floor((x + r) / TILE);
  const y0 = Math.floor((y - r) / TILE), y1 = Math.floor((y + r) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const t = tileAt(map, tx * TILE + 1, ty * TILE + 1);
      if (!SOLID_TILES.has(t)) continue;
      const cx = clamp(x, tx * TILE, (tx + 1) * TILE);
      const cy = clamp(y, ty * TILE, (ty + 1) * TILE);
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < r * r) return true;
    }
  }
  return false;
}

/**
 * Bewegt einen Kreis um (dx,dy) und schiebt ihn an Waenden entlang.
 */
export function slideMove(map, x, y, dx, dy, r = PLAYER_RADIUS) {
  let nx = x + dx;
  if (circleHitsSolid(map, nx, y, r)) {
    const steps = 6;
    let ok = x;
    for (let i = 1; i <= steps; i++) {
      const tx = x + dx * (i / steps);
      if (circleHitsSolid(map, tx, y, r)) break;
      ok = tx;
    }
    nx = ok;
  }
  let ny = y + dy;
  if (circleHitsSolid(map, nx, ny, r)) {
    const steps = 6;
    let ok = y;
    for (let i = 1; i <= steps; i++) {
      const ty = y + dy * (i / steps);
      if (circleHitsSolid(map, nx, ty, r)) break;
      ok = ty;
    }
    ny = ok;
  }
  nx = clamp(nx, r, WORLD_W - r);
  ny = clamp(ny, r, WORLD_H - r);
  return { x: nx, y: ny };
}

/**
 * Eingabe (Tasten) in eine Bewegungsrichtung umrechnen, relativ zur
 * Blickrichtung yaw: "vor" ist immer dorthin, wo die Kamera hinschaut.
 */
export function inputDirection(inp, yaw = 0) {
  let fx = (inp.up ? 1 : 0) - (inp.down ? 1 : 0);     // vor/zurueck
  let sx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);  // seitlich
  const len = Math.hypot(fx, sx);
  if (len === 0) return { x: 0, y: 0 };
  fx /= len; sx /= len;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Blickrichtung (c, s); rechts davon ist (-s, c) in unserer Bodenebene.
  return { x: fx * c - sx * s, y: fx * s + sx * c };
}

/**
 * Ein Simulationsschritt der Bewegung.
 * @param {object} p  Spielerzustand {x,y,vx,vy,role}
 * @param {object} inp Eingabe {up,down,left,right,sprint}
 * @param {number} dt Sekunden
 * @param {object} map
 * @param {object} opt {sprintAllowed:boolean, speedOverride:number|null, yaw:number}
 */
export function stepMovement(p, inp, dt, map, opt = {}) {
  const dir = inputDirection(inp, opt.yaw ?? 0);
  const moving = dir.x !== 0 || dir.y !== 0;
  const sprinting = !!(inp.sprint && opt.sprintAllowed && moving);
  const terrain = terrainFactor(map, p.x, p.y);
  const maxV = (opt.speedOverride ?? maxSpeedFor(p.role, sprinting)) * terrain;

  if (moving) {
    p.vx += dir.x * ACCEL * dt;
    p.vy += dir.y * ACCEL * dt;
  } else {
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 0) {
      const dec = Math.min(sp, FRICTION * dt);
      p.vx -= (p.vx / sp) * dec;
      p.vy -= (p.vy / sp) * dec;
    }
  }
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > maxV) { p.vx = (p.vx / sp) * maxV; p.vy = (p.vy / sp) * maxV; }

  const moved = slideMove(map, p.x, p.y, p.vx * dt, p.vy * dt);
  if (Math.abs(moved.x - (p.x + p.vx * dt)) > 1e-6) p.vx = 0;
  if (Math.abs(moved.y - (p.y + p.vy * dt)) > 1e-6) p.vy = 0;
  p.x = moved.x;
  p.y = moved.y;
  return sprinting;
}

/**
 * 3D-Strahl gegen die Welt: Mauern sind Quader ueber festen Kacheln,
 * der Boden ist die Ebene h = 0. Einheiten: Kacheln (Meter).
 * @param {object} o  Ursprung {x, y, h}  (x,y in Kacheln!)
 * @param {object} d  Richtung (normiert) {x, y, h}
 * @param {number} maxDist  Kacheln
 * @returns {null | {x,y,h, dist, kind:'floor'|'wall', tx, ty, nx, ny, nh}}
 */
export function raycast3D(map, o, d, maxDist = 20) {
  // Boden
  let floorT = Infinity;
  if (d.h < -1e-9) floorT = -o.h / d.h;

  // DDA ueber die Kacheln in der Bodenebene
  let tx = Math.floor(o.x), ty = Math.floor(o.y);
  const stepX = d.x > 0 ? 1 : -1, stepY = d.y > 0 ? 1 : -1;
  const tDeltaX = d.x !== 0 ? Math.abs(1 / d.x) : Infinity;
  const tDeltaY = d.y !== 0 ? Math.abs(1 / d.y) : Infinity;
  let tMaxX = d.x !== 0 ? ((d.x > 0 ? tx + 1 - o.x : o.x - tx) * tDeltaX) : Infinity;
  let tMaxY = d.y !== 0 ? ((d.y > 0 ? ty + 1 - o.y : o.y - ty) * tDeltaY) : Infinity;
  let t = 0;
  let nx = 0, ny = 0;

  for (let i = 0; i < 4 * (MAP_W + MAP_H); i++) {
    // Kachel [tx,ty] wird im Intervall [t, tNext] durchlaufen.
    const tNext = Math.min(tMaxX, tMaxY, maxDist, floorT);
    const hgt = tileHeight(map, tx, ty);
    if (hgt > 0) {
      // Strahl trifft den Quader, wenn die Hoehe im Intervall unter hgt liegt.
      const hIn = o.h + d.h * t;
      if (i > 0 && hIn <= hgt && hIn >= 0) {
        return { x: o.x + d.x * t, y: o.y + d.y * t, h: hIn, dist: t, kind: 'wall', tx, ty, nx, ny, nh: 0 };
      }
      // Oder er kommt von oben herab auf die Oberseite.
      if (d.h < 0 && hIn > hgt) {
        const tTop = (hgt - o.h) / d.h;
        if (tTop >= t && tTop <= tNext) {
          return { x: o.x + d.x * tTop, y: o.y + d.y * tTop, h: hgt, dist: tTop, kind: 'wall', tx, ty, nx: 0, ny: 0, nh: 1 };
        }
      }
      if (i === 0 && hIn <= hgt && hIn >= 0) {
        // Start im Inneren einer Mauer: sofortiger Treffer.
        return { x: o.x, y: o.y, h: o.h, dist: 0, kind: 'wall', tx, ty, nx: 0, ny: 0, nh: 0 };
      }
    }
    if (tNext >= floorT && floorT <= maxDist) {
      return { x: o.x + d.x * floorT, y: o.y + d.y * floorT, h: 0, dist: floorT, kind: 'floor', tx: Math.floor(o.x + d.x * floorT), ty: Math.floor(o.y + d.y * floorT), nx: 0, ny: 0, nh: 1 };
    }
    if (tNext >= maxDist) return null;
    if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; tx += stepX; nx = -stepX; ny = 0; }
    else { t = tMaxY; tMaxY += tDeltaY; ty += stepY; nx = 0; ny = -stepY; }
    if (!inBounds(tx, ty)) return null;
  }
  return null;
}

/**
 * Strahl gegen einen stehenden Zylinder (Spielerfigur).
 * @returns {number|null} Distanz entlang des Strahls oder null
 */
export function rayHitsCylinder(o, d, cx, cy, radius, height) {
  // Loesung in der Bodenebene
  const ox = o.x - cx, oy = o.y - cy;
  const a = d.x * d.x + d.y * d.y;
  const b = 2 * (ox * d.x + oy * d.y);
  const c = ox * ox + oy * oy - radius * radius;
  if (a < 1e-9) {
    // Senkrecht: nur Treffer, wenn wir innerhalb des Kreises sind.
    if (c > 0) return null;
    const hTop = (height - o.h) / d.h, hBot = -o.h / d.h;
    const tt = Math.min(hTop, hBot);
    return tt >= 0 ? tt : null;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t0 = (-b - sq) / (2 * a), t1 = (-b + sq) / (2 * a);
  if (t1 < 0) return null;
  if (t0 < 0) t0 = 0;
  // Hoehe im Trefferintervall pruefen
  for (const tt of [t0, t1]) {
    const h = o.h + d.h * tt;
    if (h >= 0 && h <= height) return tt;
  }
  // Strahl schneidet den Kreis, aber die Hoehe passt an den Randpunkten nicht:
  // vielleicht trifft er oben/unten auf die Deckelflaeche.
  if (Math.abs(d.h) > 1e-9) {
    for (const hh of [height, 0]) {
      const tt = (hh - o.h) / d.h;
      if (tt >= t0 && tt <= t1 && tt >= 0) return tt;
    }
  }
  return null;
}

/** Erste feste Kachel entlang einer Bodenstrecke (2D, fuer Bots und Sichtlinien). */
export function raycastSolid(map, x0, y0, x1, y1, step = 6) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const n = Math.ceil(len / step);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = x0 + dx * t, y = y0 + dy * t;
    if (SOLID_TILES.has(tileAt(map, x, y))) return { x, y, t };
  }
  return null;
}

/** Richtungsvektor aus Gier- und Nickwinkel (Radiant). */
export function dirFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: Math.cos(yaw) * cp, y: Math.sin(yaw) * cp, h: Math.sin(pitch) };
}
