import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/constants.js';
import { generateMap, idx, serializeMap, deserializeMap, tileColorAt, isSolidAt } from '../shared/map.js';

test('Karte ist deterministisch je Seed', () => {
  const a = generateMap(42), b = generateMap(42), c = generateMap(43);
  assert.deepEqual(Array.from(a.tiles), Array.from(b.tiles));
  assert.deepEqual(Array.from(a.colors), Array.from(b.colors));
  assert.notDeepEqual(Array.from(a.tiles), Array.from(c.tiles));
});

test('Rand ist vollstaendig Wand', () => {
  const m = generateMap(5);
  for (let tx = 0; tx < C.MAP_W; tx++) {
    assert.equal(m.tiles[idx(tx, 0)], C.T_WALL);
    assert.equal(m.tiles[idx(tx, C.MAP_H - 1)], C.T_WALL);
  }
  for (let ty = 0; ty < C.MAP_H; ty++) {
    assert.equal(m.tiles[idx(0, ty)], C.T_WALL);
    assert.equal(m.tiles[idx(C.MAP_W - 1, ty)], C.T_WALL);
  }
});

test('alle begehbaren Kacheln haengen zusammen', () => {
  for (const seed of [1, 2, 3, 99, 2024]) {
    const m = generateMap(seed);
    const open = [];
    for (let i = 0; i < m.tiles.length; i++) if (!C.SOLID_TILES.has(m.tiles[i])) open.push(i);
    const seen = new Uint8Array(m.tiles.length);
    const stack = [open[0]]; seen[open[0]] = 1; let count = 0;
    while (stack.length) {
      const i = stack.pop(); count++;
      const tx = i % C.MAP_W, ty = (i / C.MAP_W) | 0;
      for (const [nx, ny] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]]) {
        const ni = idx(nx, ny);
        if (seen[ni] || C.SOLID_TILES.has(m.tiles[ni])) continue;
        seen[ni] = 1; stack.push(ni);
      }
    }
    assert.equal(count, open.length, `Seed ${seed}: abgeschnittene Bereiche`);
    assert.ok(open.length > 0.55 * C.MAP_W * C.MAP_H, `Seed ${seed}: zu wenig Spielflaeche`);
  }
});

test('Anker sind Saeulen mit freier Nachbarkachel', () => {
  const m = generateMap(7);
  assert.ok(m.anchors.length >= 20);
  for (const a of m.anchors) {
    assert.ok(isSolidAt(m, a.x, a.y));
    const tx = Math.floor(a.x / C.TILE), ty = Math.floor(a.y / C.TILE);
    assert.equal(m.tiles[idx(tx, ty)], C.T_PILLAR);
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !C.SOLID_TILES.has(m.tiles[idx(tx + dx, ty + dy)]));
    assert.ok(nb, 'Saeule ohne freien Nachbarn');
  }
});

test('Startplaetze sind frei und halten Abstand', () => {
  const m = generateMap(13);
  assert.ok(m.spawns.length >= 12);
  for (const s of m.spawns) assert.ok(!isSolidAt(m, s.x, s.y));
  for (let i = 0; i < m.spawns.length; i++) for (let j = i + 1; j < m.spawns.length; j++) {
    const d = Math.hypot(m.spawns[i].x - m.spawns[j].x, m.spawns[i].y - m.spawns[j].y);
    assert.ok(d > C.TILE * 2, 'Startplaetze zu nah');
  }
});

test('Serialisierung ist verlustfrei', () => {
  const m = generateMap(21);
  const back = deserializeMap(JSON.parse(JSON.stringify(serializeMap(m))));
  assert.deepEqual(Array.from(back.tiles), Array.from(m.tiles));
  assert.deepEqual(Array.from(back.colors), Array.from(m.colors));
  assert.deepEqual(back.anchors, m.anchors);
});

test('Kachelfarbe ausserhalb der Karte ist Wandfarbe', () => {
  const m = generateMap(1);
  assert.deepEqual(tileColorAt(m, -100, -100), C.WALL_COLOR);
  assert.ok(isSolidAt(m, -5, 10));
});
