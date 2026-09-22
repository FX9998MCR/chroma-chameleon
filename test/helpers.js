// Gemeinsame Hilfen fuer die Tests.
import * as C from '../shared/constants.js';
import { generateMap, idx, makeRng } from '../shared/map.js';
import { Game } from '../server/game.js';

export const DT = C.TICK_MS / 1000;

/** Deterministischer Zufall, damit Tests reproduzierbar sind. */
export function seededRng(seed = 7) { return makeRng(seed); }

export function makeGame(seed = 11, names = ['Anna', 'Ben', 'Cem']) {
  const map = generateMap(seed);
  const g = new Game(map, { rng: seededRng(seed) });
  const ids = names.map((n, i) => { g.addPlayer('p' + (i + 1), n); return 'p' + (i + 1); });
  return { g, map, ids };
}

export function ticks(g, n) { for (let i = 0; i < n; i++) g.update(DT); }
export function seconds(g, s) { ticks(g, Math.ceil(s / DT)); }

/**
 * Findet eine waagerechte Strecke aus n freien Bodenkacheln (mit freier Zeile
 * darueber und darunter). Liefert die linke Kachel.
 */
export function openRun(map, n) {
  for (let ty = 3; ty < C.MAP_H - 3; ty++) {
    for (let tx = 3; tx < C.MAP_W - 3 - n; tx++) {
      let ok = true;
      for (let k = 0; k < n && ok; k++) for (let dy = -1; dy <= 1; dy++) {
        if (map.tiles[idx(tx + k, ty + dy)] !== C.T_FLOOR) { ok = false; break; }
      }
      if (ok) return { tx, ty, x: tx * C.TILE + C.TILE / 2, y: ty * C.TILE + C.TILE / 2 };
    }
  }
  throw new Error('keine freie Strecke');
}

/** Findet eine Bodenkachel, deren 3x3-Umgebung komplett Boden ist. */
export function openSpot(map, minTx = 3, minTy = 3) {
  for (let ty = minTy; ty < C.MAP_H - 3; ty++) {
    for (let tx = minTx; tx < C.MAP_W - 3; tx++) {
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (map.tiles[idx(tx + dx, ty + dy)] !== C.T_FLOOR) { ok = false; break; }
      }
      if (ok) return { x: tx * C.TILE + C.TILE / 2, y: ty * C.TILE + C.TILE / 2, tx, ty };
    }
  }
  throw new Error('kein freier Platz');
}

/**
 * Eine feste Einzelkachel (Saeule) mit freien Nachbarn ringsum -
 * fuer Kollisions- und Sichtlinien-Tests. Mauern sind im Generator immer
 * mindestens zwei Kacheln dick, Saeulen dagegen genau eine.
 */
export function wallWithFloorSides(map) {
  for (const a of map.anchors) {
    const tx = Math.floor(a.x / C.TILE), ty = Math.floor(a.y / C.TILE);
    if (map.tiles[idx(tx, ty)] !== C.T_PILLAR) continue;
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (C.SOLID_TILES.has(map.tiles[idx(tx + dx, ty + dy)])) { ok = false; break; }
    }
    if (ok) return { tx, ty };
  }
  throw new Error('keine freistehende Saeule');
}

export function place(p, x, y) { p.x = x; p.y = y; p.vx = 0; p.vy = 0; }

export function input(g, id, keys = {}, actions = null, yaw = 0, pitch = 0) {
  g.setInput(id, { up: false, down: false, left: false, right: false, sprint: false, paint: false, ...keys }, actions, { yaw, pitch }, 0);
}

/** Blickwinkel von a auf Koerpermitte von b (fuer Schuss-Tests). */
export function aimAt(a, b, targetH = 0.9) {
  const dx = (b.x - a.x) / C.TILE, dy = (b.y - a.y) / C.TILE;
  const dist = Math.hypot(dx, dy);
  return { yaw: Math.atan2(dy, dx), pitch: Math.atan2(targetH - C.EYE_H, dist) };
}

/** Runde starten und die Vorbereitung ueberspringen. */
export function startHunt(g) {
  g.startRound();
  g.phaseTime = 0.01;
  g.update(DT);
  if (g.phase !== C.PHASE_HUNT) throw new Error('Jagd nicht gestartet: ' + g.phase);
}
