// Bewegung, Kollision und Tarnungs-Mathematik.
// Wird identisch auf Server (Autoritaet) und Client (Vorhersage) ausgefuehrt.

import {
  TILE, PLAYER_RADIUS, HIDER_SPEED, HIDER_SPRINT, SEEKER_SPEED, ACCEL, FRICTION,
  BUSH_SLOW, WATER_SLOW, T_BUSH, T_WATER, SOLID_TILES,
  CAMO_COLOR_WEIGHT, CAMO_STILL_WEIGHT, CAMO_STILL_RAMP, CAMO_BUSH_BONUS,
  CAMO_WATER_MALUS, CAMO_MAX_CONCEAL, CAMO_SHIMMER_TIME, CAMO_SHIMMER_FLOOR,
  REVEAL_RADIUS, REVEAL_HARD_RADIUS, ROLE_HIDER, WORLD_W, WORLD_H,
} from './constants.js';
import { tileAt, isSolidAt, tileColorAt } from './map.js';

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
 * Testet die vier Kachel-Ecken des umschliessenden Rechtecks.
 */
export function circleHitsSolid(map, x, y, r = PLAYER_RADIUS) {
  const x0 = Math.floor((x - r) / TILE), x1 = Math.floor((x + r) / TILE);
  const y0 = Math.floor((y - r) / TILE), y1 = Math.floor((y + r) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const t = tileAt(map, tx * TILE + 1, ty * TILE + 1);
      if (!SOLID_TILES.has(t)) continue;
      // Naechster Punkt des Kachel-Rechtecks zum Kreismittelpunkt.
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
 * Achsengetrennt, damit man an Kanten nicht haengen bleibt.
 */
export function slideMove(map, x, y, dx, dy, r = PLAYER_RADIUS) {
  let nx = x + dx;
  if (circleHitsSolid(map, nx, y, r)) {
    // Schrittweise zurueck bis frei - robust bei hohem Tempo.
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
 * Ein Simulationsschritt der Bewegung.
 * @param {object} p  Spielerzustand {x,y,vx,vy,role}
 * @param {object} inp Eingabe {up,down,left,right,sprint}
 * @param {number} dt Sekunden
 * @param {object} map
 * @param {object} opt {sprintAllowed:boolean, speedOverride:number|null}
 */
export function stepMovement(p, inp, dt, map, opt = {}) {
  let ix = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  let iy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
  const len = Math.hypot(ix, iy);
  if (len > 0) { ix /= len; iy /= len; }

  const sprinting = !!(inp.sprint && opt.sprintAllowed);
  const terrain = terrainFactor(map, p.x, p.y);
  const maxV = (opt.speedOverride ?? maxSpeedFor(p.role, sprinting)) * terrain;

  if (len > 0) {
    p.vx += ix * ACCEL * dt;
    p.vy += iy * ACCEL * dt;
  } else {
    // Reibung: Geschwindigkeit Richtung Null, ohne ueberzuschiessen.
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
  // Wenn eine Achse blockiert war, Geschwindigkeit dort loeschen.
  if (Math.abs(moved.x - (p.x + p.vx * dt)) > 1e-6) p.vx = 0;
  if (Math.abs(moved.y - (p.y + p.vy * dt)) > 1e-6) p.vy = 0;
  p.x = moved.x;
  p.y = moved.y;
  return sprinting;
}

/**
 * Sichtbarkeit eines Chamaeleons aus Sicht der Welt (ohne Jaeger-Naehe).
 * 0 = unsichtbar, 1 = voll sichtbar.
 * @param {object} h  {x,y,color:[r,g,b],stillTime,shimmer}
 */
export function baseVisibility(map, h) {
  const ground = tileColorAt(map, h.x, h.y);
  const match = colorMatch(h.color, ground);
  const still = clamp(h.stillTime / CAMO_STILL_RAMP, 0, 1);
  let conceal = CAMO_COLOR_WEIGHT * match + CAMO_STILL_WEIGHT * still;
  const t = tileAt(map, h.x, h.y);
  if (t === T_BUSH) conceal += CAMO_BUSH_BONUS;
  if (t === T_WATER) conceal -= CAMO_WATER_MALUS;
  // Ohne Stillstand darf Farbe allein nie fast unsichtbar machen.
  conceal = Math.min(conceal, still < 0.5 ? 0.72 : CAMO_MAX_CONCEAL);
  let vis = clamp(1 - conceal, 0, 1);
  if (h.shimmer > 0) {
    const s = clamp(h.shimmer / CAMO_SHIMMER_TIME, 0, 1);
    vis = Math.max(vis, lerp(vis, CAMO_SHIMMER_FLOOR, s));
  }
  return vis;
}

/**
 * Sichtbarkeit fuer einen konkreten Jaeger: Naehe deckt auf.
 * @param {number} base   baseVisibility
 * @param {number} dist   Abstand Jaeger-Chamaeleon
 * @param {number} mark   verbleibende Scan-Markierung in Sekunden
 */
export function visibilityForSeeker(base, dist, mark = 0) {
  let vis = base;
  if (dist < REVEAL_HARD_RADIUS) vis = 1;
  else if (dist < REVEAL_RADIUS) {
    const t = (REVEAL_RADIUS - dist) / (REVEAL_RADIUS - REVEAL_HARD_RADIUS);
    vis = Math.max(vis, 0.35 + 0.65 * t);
  }
  if (mark > 0) vis = 1;
  return clamp(vis, 0, 1);
}

/** Erste feste Kachel entlang einer Strecke (fuer Zungenhaken und Sichtlinie). */
export function raycastSolid(map, x0, y0, x1, y1, step = 6) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const n = Math.ceil(len / step);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = x0 + dx * t, y = y0 + dy * t;
    if (isSolidAt(map, x, y)) return { x, y, t };
  }
  return null;
}
