// Arena-Erzeugung und Kachel-Hilfen.
// Deterministisch ueber einen Seed: derselbe Seed ergibt exakt dieselbe Karte.

import {
  MAP_W, MAP_H, TILE, PALETTE, BUSH_COLOR, WATER_COLOR, WALL_COLOR,
  T_FLOOR, T_WALL, T_BUSH, T_WATER, T_PILLAR, SOLID_TILES,
} from './constants.js';

/** Kleiner, schneller Zufallsgenerator mit festem Zustand (Mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const idx = (tx, ty) => ty * MAP_W + tx;
export const inBounds = (tx, ty) => tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;
export const worldToTileX = (x) => Math.floor(x / TILE);
export const worldToTileY = (y) => Math.floor(y / TILE);

/** Kacheltyp an Weltkoordinaten; ausserhalb der Karte gilt als Wand. */
export function tileAt(map, x, y) {
  const tx = worldToTileX(x), ty = worldToTileY(y);
  if (!inBounds(tx, ty)) return T_WALL;
  return map.tiles[idx(tx, ty)];
}

export function isSolidAt(map, x, y) {
  return SOLID_TILES.has(tileAt(map, x, y));
}

/** Sichtbare Farbe einer Kachel als [r,g,b] - das ist die Referenz fuer die Tarnung. */
export function tileColorAt(map, x, y) {
  const tx = worldToTileX(x), ty = worldToTileY(y);
  if (!inBounds(tx, ty)) return WALL_COLOR;
  const i = idx(tx, ty);
  switch (map.tiles[i]) {
    case T_BUSH:  return BUSH_COLOR;
    case T_WATER: return WATER_COLOR;
    case T_WALL:
    case T_PILLAR: return WALL_COLOR;
    default: return PALETTE[map.colors[i]] ?? PALETTE[0];
  }
}

/** Setzt ein gefuelltes Rechteck, ohne den Kartenrand zu ueberschreiben. */
function fillRect(tiles, x0, y0, w, h, type) {
  for (let ty = y0; ty < y0 + h; ty++) {
    for (let tx = x0; tx < x0 + w; tx++) {
      if (tx < 2 || ty < 2 || tx >= MAP_W - 2 || ty >= MAP_H - 2) continue;
      tiles[idx(tx, ty)] = type;
    }
  }
}

/** Organisch wirkender Fleck per Zufallsspaziergang. */
function blob(tiles, rng, cx, cy, size, type) {
  let x = cx, y = cy;
  for (let i = 0; i < size; i++) {
    if (x >= 2 && y >= 2 && x < MAP_W - 2 && y < MAP_H - 2) {
      tiles[idx(x, y)] = type;
    }
    const d = (rng() * 4) | 0;
    if (d === 0) x++; else if (d === 1) x--; else if (d === 2) y++; else y--;
    x = Math.max(2, Math.min(MAP_W - 3, x));
    y = Math.max(2, Math.min(MAP_H - 3, y));
  }
}

/**
 * Markiert alle vom Startpunkt erreichbaren begehbaren Kacheln.
 * Liefert das Besuchs-Array und die Anzahl erreichbarer Kacheln.
 */
function floodFill(tiles, startIdx) {
  const seen = new Uint8Array(MAP_W * MAP_H);
  if (SOLID_TILES.has(tiles[startIdx])) return { seen, count: 0 };
  const stack = [startIdx];
  seen[startIdx] = 1;
  let count = 0;
  while (stack.length) {
    const i = stack.pop();
    count++;
    const tx = i % MAP_W, ty = (i / MAP_W) | 0;
    const nb = [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]];
    for (const [nx, ny] of nb) {
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (seen[ni] || SOLID_TILES.has(tiles[ni])) continue;
      seen[ni] = 1;
      stack.push(ni);
    }
  }
  return { seen, count };
}

/** Sucht die erste begehbare Kachel als Start fuer die Erreichbarkeitspruefung. */
function firstOpenIndex(tiles) {
  const cx = MAP_W >> 1, cy = MAP_H >> 1;
  for (let r = 0; r < Math.max(MAP_W, MAP_H); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = cx + dx, ty = cy + dy;
        if (!inBounds(tx, ty)) continue;
        const i = idx(tx, ty);
        if (!SOLID_TILES.has(tiles[i])) return i;
      }
    }
  }
  return -1;
}

/**
 * Erzeugt eine komplette Arena.
 * @param {number} seed
 * @returns {{seed:number, w:number, h:number, tiles:Uint8Array, colors:Uint8Array,
 *            anchors:Array<{x:number,y:number}>, spawns:Array<{x:number,y:number}>}}
 */
export function generateMap(seed = 1) {
  const rng = makeRng(seed);
  const n = MAP_W * MAP_H;
  const tiles = new Uint8Array(n);   // alles Boden
  const colors = new Uint8Array(n);

  // 1. Farbzonen: Voronoi ueber zufaellige Saatpunkte, damit grosse
  //    zusammenhaengende Flaechen entstehen, in denen Tarnung funktioniert.
  const zoneCount = 10 + ((rng() * 5) | 0);
  const zones = [];
  for (let i = 0; i < zoneCount; i++) {
    zones.push({
      x: rng() * MAP_W,
      y: rng() * MAP_H,
      c: (rng() * PALETTE.length) | 0,
    });
  }
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      let best = 0, bestD = Infinity;
      for (let z = 0; z < zones.length; z++) {
        const dx = zones[z].x - tx - 0.5, dy = zones[z].y - ty - 0.5;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = zones[z].c; }
      }
      colors[idx(tx, ty)] = best;
    }
  }

  // 2. Aussenmauer, zwei Kacheln dick fuer eine saubere Silhouette.
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (tx < 2 || ty < 2 || tx >= MAP_W - 2 || ty >= MAP_H - 2) {
        tiles[idx(tx, ty)] = T_WALL;
      }
    }
  }

  // 3. Mauerblöcke als Sichtbarrieren.
  const wallClusters = 22 + ((rng() * 8) | 0);
  for (let i = 0; i < wallClusters; i++) {
    const w = 2 + ((rng() * 5) | 0);
    const h = 2 + ((rng() * 5) | 0);
    const x0 = 4 + ((rng() * (MAP_W - 8 - w)) | 0);
    const y0 = 4 + ((rng() * (MAP_H - 8 - h)) | 0);
    fillRect(tiles, x0, y0, w, h, T_WALL);
  }

  // 4. Gebuesch: Deckung, die zusaetzlich zur Farbe wirkt.
  const bushes = 16 + ((rng() * 8) | 0);
  for (let i = 0; i < bushes; i++) {
    const cx = 4 + ((rng() * (MAP_W - 8)) | 0);
    const cy = 4 + ((rng() * (MAP_H - 8)) | 0);
    blob(tiles, rng, cx, cy, 14 + ((rng() * 26) | 0), T_BUSH);
  }

  // 5. Wasser: bremst und verraet durch Wellen - riskante Abkuerzung.
  const ponds = 4 + ((rng() * 4) | 0);
  for (let i = 0; i < ponds; i++) {
    const cx = 5 + ((rng() * (MAP_W - 10)) | 0);
    const cy = 5 + ((rng() * (MAP_H - 10)) | 0);
    blob(tiles, rng, cx, cy, 18 + ((rng() * 22) | 0), T_WATER);
  }

  // 6. Saeulen: Ankerpunkte fuer den Zungenhaken, moeglichst frei stehend.
  const anchors = [];
  let tries = 0;
  while (anchors.length < 34 && tries < 3000) {
    tries++;
    const tx = 4 + ((rng() * (MAP_W - 8)) | 0);
    const ty = 4 + ((rng() * (MAP_H - 8)) | 0);
    const i = idx(tx, ty);
    if (SOLID_TILES.has(tiles[i])) continue;
    // Nachbarschaft muss frei sein, sonst verschmilzt die Saeule mit einer Mauer.
    let clear = true;
    for (let dy = -1; dy <= 1 && clear; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (SOLID_TILES.has(tiles[idx(tx + dx, ty + dy)])) { clear = false; break; }
      }
    }
    if (!clear) continue;
    let tooClose = false;
    for (const a of anchors) {
      if (Math.abs(a.tx - tx) < 4 && Math.abs(a.ty - ty) < 4) { tooClose = true; break; }
    }
    if (tooClose) continue;
    tiles[i] = T_PILLAR;
    anchors.push({ tx, ty, x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
  }

  // 7. Erreichbarkeit sicherstellen: alles, was nicht zum Hauptbereich gehoert,
  //    wird zugemauert. So kann niemand in einer Tasche festsitzen.
  const start = firstOpenIndex(tiles);
  if (start >= 0) {
    const { seen } = floodFill(tiles, start);
    for (let i = 0; i < n; i++) {
      if (!SOLID_TILES.has(tiles[i]) && !seen[i]) tiles[i] = T_WALL;
    }
  }
  // Saeulen, die dabei abgeschnitten wurden, aus der Ankerliste nehmen.
  const reach = start >= 0 ? floodFill(tiles, start).seen : new Uint8Array(n);
  const liveAnchors = anchors.filter((a) => {
    const nb = [[a.tx + 1, a.ty], [a.tx - 1, a.ty], [a.tx, a.ty + 1], [a.tx, a.ty - 1]];
    return nb.some(([nx, ny]) => inBounds(nx, ny) && reach[idx(nx, ny)]);
  }).map(({ x, y }) => ({ x, y }));

  // 8. Startplaetze: erreichbare, trockene Kacheln mit Mindestabstand zueinander.
  const spawns = [];
  const candidates = [];
  for (let ty = 3; ty < MAP_H - 3; ty++) {
    for (let tx = 3; tx < MAP_W - 3; tx++) {
      const i = idx(tx, ty);
      if (tiles[i] !== T_FLOOR && tiles[i] !== T_BUSH) continue;
      if (!reach[i]) continue;
      candidates.push({ tx, ty });
    }
  }
  // Zufaellig mischen, damit Startplaetze ueber die Karte streuen.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  for (const c of candidates) {
    if (spawns.length >= 40) break;
    if (spawns.every((s) => Math.hypot(s.tx - c.tx, s.ty - c.ty) > 6)) spawns.push(c);
  }
  // Notfall: lieber enge Startplaetze als gar keine.
  if (spawns.length < 8) {
    for (const c of candidates) {
      if (spawns.length >= 12) break;
      if (!spawns.includes(c)) spawns.push(c);
    }
  }

  return {
    seed,
    w: MAP_W,
    h: MAP_H,
    tiles,
    colors,
    anchors: liveAnchors,
    spawns: spawns.map((s) => ({ x: s.tx * TILE + TILE / 2, y: s.ty * TILE + TILE / 2 })),
  };
}

/** Kompakte Form fuer den Versand an den Browser. */
export function serializeMap(map) {
  return {
    seed: map.seed,
    w: map.w,
    h: map.h,
    tiles: Array.from(map.tiles),
    colors: Array.from(map.colors),
    anchors: map.anchors,
  };
}

/** Gegenstueck zu serializeMap im Browser. */
export function deserializeMap(raw) {
  return {
    seed: raw.seed,
    w: raw.w,
    h: raw.h,
    tiles: Uint8Array.from(raw.tiles),
    colors: Uint8Array.from(raw.colors),
    anchors: raw.anchors,
    spawns: [],
  };
}
