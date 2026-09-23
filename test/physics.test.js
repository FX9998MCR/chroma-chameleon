import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/constants.js';
import { generateMap, idx, wallColorAt, surfaceColor } from '../shared/map.js';
import {
  colorMatch, circleHitsSolid, slideMove, stepMovement, raycastSolid, angleDiff,
  inputDirection, raycast3D, rayHitsCylinder, dirFromAngles, tileHeight,
} from '../shared/physics.js';
import { openSpot, wallWithFloorSides, DT } from './helpers.js';

test('colorMatch: identisch 1, stark verschieden nahe 0', () => {
  assert.equal(colorMatch([10, 20, 30], [10, 20, 30]), 1);
  assert.ok(colorMatch([0, 0, 0], [255, 255, 255]) < 0.05);
});

test('angleDiff liefert kuerzesten Weg', () => {
  assert.ok(Math.abs(angleDiff(0, Math.PI / 2) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(angleDiff(Math.PI - 0.1, -Math.PI + 0.1) - 0.2) < 1e-9);
});

test('Kreis erkennt Waende, freie Kacheln nicht', () => {
  const m = generateMap(3);
  const s = openSpot(m);
  assert.equal(circleHitsSolid(m, s.x, s.y), false);
  assert.equal(circleHitsSolid(m, C.TILE * 0.5, C.TILE * 0.5), true);
});

test('slideMove dringt nie in eine Wand ein und gleitet daran entlang', () => {
  const m = generateMap(3);
  const { tx, ty } = wallWithFloorSides(m);
  const wallX = tx * C.TILE;
  let x = wallX - C.TILE + 16, y = ty * C.TILE + 16;
  for (let i = 0; i < 40; i++) {
    const r = slideMove(m, x, y, 12, 0);
    x = r.x; y = r.y;
    assert.equal(circleHitsSolid(m, x, y), false);
  }
  assert.ok(x <= wallX - C.PLAYER_RADIUS + 0.01);
  const r = slideMove(m, x, y, 10, 6);
  assert.ok(r.x <= x + 0.01, 'X blockiert');
  assert.ok(r.y > y + 5, 'Y frei');
});

test('inputDirection: "vor" folgt der Blickrichtung', () => {
  const f0 = inputDirection({ up: true }, 0);
  assert.ok(Math.abs(f0.x - 1) < 1e-9 && Math.abs(f0.y) < 1e-9);
  const f90 = inputDirection({ up: true }, Math.PI / 2);
  assert.ok(Math.abs(f90.x) < 1e-9 && Math.abs(f90.y - 1) < 1e-9);
  const r90 = inputDirection({ right: true }, Math.PI / 2);
  assert.ok(Math.abs(r90.x + 1) < 1e-9, 'rechts bei Blick nach +y ist -x');
  const diag = inputDirection({ up: true, right: true }, 0);
  assert.ok(Math.abs(Math.hypot(diag.x, diag.y) - 1) < 1e-9, 'normiert');
  assert.deepEqual(inputDirection({}, 1.2), { x: 0, y: 0 });
});

test('stepMovement bewegt relativ zur Blickrichtung, bremst ohne Eingabe', () => {
  const m = generateMap(3);
  const s = openSpot(m);
  const p = { x: s.x, y: s.y, vx: 0, vy: 0, role: C.ROLE_HIDER };
  for (let i = 0; i < 20; i++) stepMovement(p, { up: true }, DT, m, { yaw: Math.PI / 2 });
  assert.ok(p.y > s.y + 40 && Math.abs(p.x - s.x) < 1, 'laeuft in +y');
  assert.ok(Math.hypot(p.vx, p.vy) <= C.HIDER_SPEED + 1e-6);
  for (let i = 0; i < 20; i++) stepMovement(p, {}, DT, m, {});
  assert.equal(Math.hypot(p.vx, p.vy), 0);
});

test('Sprint nur mit Erlaubnis und nur in Bewegung', () => {
  const m = generateMap(3);
  const s = openSpot(m);
  const p = { x: s.x, y: s.y, vx: 0, vy: 0, role: C.ROLE_HIDER };
  for (let i = 0; i < 30; i++) stepMovement(p, { up: true, sprint: true }, DT, m, { sprintAllowed: false });
  assert.ok(Math.hypot(p.vx, p.vy) <= C.HIDER_SPEED + 1e-6);
  const q = { x: s.x, y: s.y, vx: 0, vy: 0, role: C.ROLE_HIDER };
  let sprinted = false;
  for (let i = 0; i < 30; i++) sprinted = stepMovement(q, { up: true, sprint: true }, DT, m, { sprintAllowed: true });
  assert.ok(sprinted && Math.hypot(q.vx, q.vy) > C.HIDER_SPEED + 10);
  assert.equal(stepMovement(q, { sprint: true }, DT, m, { sprintAllowed: true }), false, 'Sprint ohne Richtung zaehlt nicht');
});

test('tileHeight: Rand hoeher als Innenmauern, Boden 0', () => {
  const m = generateMap(3);
  assert.equal(tileHeight(m, 0, 0), C.WALL_H_EDGE);
  const s = openSpot(m);
  assert.equal(tileHeight(m, s.tx, s.ty), 0);
  const { tx, ty } = wallWithFloorSides(m);
  assert.equal(tileHeight(m, tx, ty), C.PILLAR_H);
  assert.equal(tileHeight(m, -3, 5), C.WALL_H_EDGE, 'ausserhalb = Wand');
});

test('raycast3D: Boden, Wand, Saeule und Freiraum', () => {
  const m = generateMap(3);
  const s = openSpot(m);
  const o = { x: s.x / C.TILE, y: s.y / C.TILE, h: C.EYE_H };
  // Nach unten: Boden in der eigenen Kachel
  const down = raycast3D(m, o, dirFromAngles(0, -Math.PI / 2 + 0.01), 10);
  assert.equal(down.kind, 'floor');
  assert.ok(Math.abs(down.dist - C.EYE_H) < 0.05);
  assert.equal(down.tx, s.tx); assert.equal(down.ty, s.ty);
  // Nach oben: nichts
  assert.equal(raycast3D(m, o, { x: 0, y: 0, h: 1 }, 10), null);
  // Waagerecht auf eine freistehende Saeule: Treffer an deren Seite mit korrekter Normale
  const { tx, ty } = wallWithFloorSides(m);
  const start = { x: tx - 1 + 0.5, y: ty + 0.5, h: 1.0 };
  const hit = raycast3D(m, start, { x: 1, y: 0, h: 0 }, 5);
  assert.equal(hit.kind, 'wall');
  assert.equal(hit.tx, tx); assert.equal(hit.ty, ty);
  assert.ok(Math.abs(hit.dist - 0.5) < 1e-6);
  assert.deepEqual([hit.nx, hit.ny, hit.nh], [-1, 0, 0]);
  // Ueber die Saeule hinweg schauen: kein Treffer an ihr
  const over = raycast3D(m, { x: tx - 1 + 0.5, y: ty + 0.5, h: C.PILLAR_H + 0.5 }, { x: 1, y: 0, h: 0 }, 1.2);
  assert.equal(over, null);
  // Von oben schraeg auf die Oberseite der Saeule
  const top = raycast3D(m, { x: tx - 0.5 + 0.5, y: ty + 0.5, h: C.PILLAR_H + 1 }, { x: 0.3, y: 0, h: -0.9539 }, 5);
  assert.equal(top.kind, 'wall'); assert.equal(top.nh, 1);
  assert.ok(Math.abs(top.h - C.PILLAR_H) < 1e-6);
});

test('raycast3D: Reichweite wird eingehalten', () => {
  const m = generateMap(3);
  const s = openSpot(m);
  const o = { x: s.x / C.TILE, y: s.y / C.TILE, h: 1 };
  const far = raycast3D(m, o, { x: 0.01, y: 0, h: -0.99995 }, 0.5);
  assert.equal(far, null, 'Boden ist 1 entfernt, Reichweite 0.5');
});

test('rayHitsCylinder: Treffer, Vorbeischuss, zu hoch, Deckel', () => {
  const t = rayHitsCylinder({ x: 0, y: 0, h: 1 }, { x: 1, y: 0, h: 0 }, 5, 0, 0.34, 1.75);
  assert.ok(t !== null && Math.abs(t - 4.66) < 1e-6);
  assert.equal(rayHitsCylinder({ x: 0, y: 0, h: 1 }, { x: 1, y: 0, h: 0 }, 5, 1, 0.34, 1.75), null, 'vorbei');
  assert.equal(rayHitsCylinder({ x: 0, y: 0, h: 3 }, { x: 1, y: 0, h: 0 }, 5, 0, 0.34, 1.75), null, 'zu hoch');
  assert.equal(rayHitsCylinder({ x: 0, y: 0, h: 1 }, { x: -1, y: 0, h: 0 }, 5, 0, 0.34, 1.75), null, 'hinter uns');
  const lie = rayHitsCylinder({ x: 0, y: 0, h: 1.55 }, { x: 0.94, y: 0, h: -0.34 }, 4, 0, 0.34, 0.35);
  assert.ok(lie !== null, 'liegende Figur von oben getroffen');
});

test('Wandfarben: Innenmauer traegt Zonenfarbe abgedunkelt, Rand dunkler, Saeule grau', () => {
  const m = generateMap(3);
  assert.deepEqual(wallColorAt(m, 0, 0), C.PALETTE[m.colors[idx(0, 0)]].map((v) => Math.round(v * 0.5)));
  const { tx, ty } = wallWithFloorSides(m);
  assert.deepEqual(wallColorAt(m, tx, ty), C.WALL_COLOR);
  let inner = null;
  for (let ty2 = 4; ty2 < C.MAP_H - 4 && !inner; ty2++) for (let tx2 = 4; tx2 < C.MAP_W - 4; tx2++) if (m.tiles[idx(tx2, ty2)] === C.T_WALL) { inner = [tx2, ty2]; break; }
  const c = C.PALETTE[m.colors[idx(inner[0], inner[1])]];
  assert.deepEqual(wallColorAt(m, inner[0], inner[1]), c.map((v) => Math.round(v * 0.82)));
  assert.deepEqual(surfaceColor(m, null), C.WALL_COLOR);
  const s = openSpot(m);
  assert.deepEqual(surfaceColor(m, { kind: 'floor', tx: s.tx, ty: s.ty }), C.PALETTE[m.colors[idx(s.tx, s.ty)]]);
});

test('raycastSolid (2D) trifft Saeule und ignoriert freie Strecke', () => {
  const m = generateMap(3);
  const { tx, ty } = wallWithFloorSides(m);
  const y = ty * C.TILE + 16;
  assert.ok(raycastSolid(m, (tx - 1) * C.TILE + 16, y, (tx + 1) * C.TILE + 16, y));
  const s = openSpot(m);
  assert.equal(raycastSolid(m, s.x - 10, s.y, s.x + 10, s.y), null);
});

test('Ecken: wer eine Saeulenecke nur streift, rutscht vorbei statt haengenzubleiben', () => {
  const map = generateMap(11);
  let pil = null;
  for (const a of map.anchors) {
    const tx = Math.floor(a.x / C.TILE), ty = Math.floor(a.y / C.TILE);
    let ok = map.tiles[idx(tx, ty)] === C.T_PILLAR;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -4; dx <= 2; dx++) if ((dx || dy) && C.SOLID_TILES.has(map.tiles[idx(tx + dx, ty + dy)])) ok = false;
    if (ok) { pil = { tx, ty }; break; }
  }
  assert.ok(pil, 'freistehende Saeule');
  for (const off of [2, 5, 8]) {
    const p = { x: (pil.tx - 3) * C.TILE, y: pil.ty * C.TILE - C.PLAYER_RADIUS + off, vx: 0, vy: 0, role: C.ROLE_HIDER };
    for (let t = 0; t < 60; t++) stepMovement(p, { up: true }, 0.05, map, { yaw: 0 });
    assert.ok(p.x > (pil.tx + 1) * C.TILE, `Ecke ${off} px gestreift: x=${p.x.toFixed(1)}`);
  }
});
