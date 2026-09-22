import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/constants.js';
import { generateMap, idx } from '../shared/map.js';
import {
  colorMatch, circleHitsSolid, slideMove, stepMovement, baseVisibility,
  visibilityForSeeker, raycastSolid, angleDiff,
} from '../shared/physics.js';
import { openSpot, wallWithFloorSides, DT } from './helpers.js';

test('colorMatch: identisch 1, stark verschieden nahe 0', () => {
  assert.equal(colorMatch([10, 20, 30], [10, 20, 30]), 1);
  assert.ok(colorMatch([0, 0, 0], [255, 255, 255]) < 0.05);
  assert.ok(colorMatch(C.PALETTE[0], C.PALETTE[1]) < colorMatch(C.PALETTE[0], C.PALETTE[0]));
});

test('angleDiff liefert kuerzesten Weg', () => {
  assert.ok(Math.abs(angleDiff(0, Math.PI / 2) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(angleDiff(Math.PI - 0.1, -Math.PI + 0.1) - 0.2) < 1e-9);
});

test('Kreis erkennt Waende, freie Kacheln nicht', () => {
  const m = generateMap(3);
  const s = openSpot(m);
  assert.equal(circleHitsSolid(m, s.x, s.y), false);
  assert.equal(circleHitsSolid(m, C.TILE * 0.5, C.TILE * 0.5), true);   // Rand
});

test('slideMove dringt nie in eine Wand ein', () => {
  const m = generateMap(3);
  const { tx, ty } = wallWithFloorSides(m);
  const wallX = tx * C.TILE;
  let x = wallX - C.TILE + 16, y = ty * C.TILE + 16;
  for (let i = 0; i < 40; i++) {
    const r = slideMove(m, x, y, 12, 0);
    x = r.x; y = r.y;
    assert.equal(circleHitsSolid(m, x, y), false, 'im Wandinneren');
  }
  assert.ok(x <= wallX - C.PLAYER_RADIUS + 0.01, 'stoppt an der Wand');
});

test('slideMove gleitet an einer Wand entlang', () => {
  const m = generateMap(3);
  const { tx, ty } = wallWithFloorSides(m);
  const x = tx * C.TILE - C.PLAYER_RADIUS - 0.5, y = ty * C.TILE + 16;
  const r = slideMove(m, x, y, 10, 6);
  assert.ok(r.x <= x + 0.01, 'X blockiert');
  assert.ok(r.y > y + 5, 'Y frei');
});

test('stepMovement beschleunigt bis Hoechsttempo und bremst ohne Eingabe', () => {
  const m = generateMap(3);
  const s = openSpot(m);
  const p = { x: s.x, y: s.y, vx: 0, vy: 0, role: C.ROLE_HIDER };
  const right = { up: false, down: false, left: false, right: true, sprint: false };
  for (let i = 0; i < 20; i++) stepMovement(p, right, DT, m, {});
  assert.ok(Math.hypot(p.vx, p.vy) <= C.HIDER_SPEED + 1e-6);
  assert.ok(Math.hypot(p.vx, p.vy) > C.HIDER_SPEED * 0.95);
  const none = { up: false, down: false, left: false, right: false, sprint: false };
  for (let i = 0; i < 20; i++) stepMovement(p, none, DT, m, {});
  assert.equal(Math.hypot(p.vx, p.vy), 0);
});

test('Sprint nur mit Erlaubnis', () => {
  const m = generateMap(3);
  const s = openSpot(m);
  const p = { x: s.x, y: s.y, vx: 0, vy: 0, role: C.ROLE_HIDER };
  const inp = { up: false, down: false, left: false, right: true, sprint: true };
  for (let i = 0; i < 30; i++) stepMovement(p, inp, DT, m, { sprintAllowed: false });
  assert.ok(Math.hypot(p.vx, p.vy) <= C.HIDER_SPEED + 1e-6);
  const q = { x: s.x, y: s.y, vx: 0, vy: 0, role: C.ROLE_HIDER };
  for (let i = 0; i < 30; i++) stepMovement(q, inp, DT, m, { sprintAllowed: true });
  assert.ok(Math.hypot(q.vx, q.vy) > C.HIDER_SPEED + 10);
});

test('Tarnung: passende Farbe + Stillstand macht fast unsichtbar', () => {
  const m = generateMap(3);
  const s = openSpot(m);
  const ground = C.PALETTE[m.colors[idx(s.tx, s.ty)]];
  const hidden = { x: s.x, y: s.y, color: ground.slice(), stillTime: 5, shimmer: 0 };
  const vis = baseVisibility(m, hidden);
  assert.ok(vis <= 1 - C.CAMO_MAX_CONCEAL + 1e-6, `zu sichtbar: ${vis}`);
  assert.ok(vis >= 0, 'nie negativ');

  const moving = { x: s.x, y: s.y, color: ground.slice(), stillTime: 0, shimmer: 0 };
  assert.ok(baseVisibility(m, moving) >= 0.28, 'Bewegung muss verraten');

  const wrong = { x: s.x, y: s.y, color: [255, 255, 255], stillTime: 5, shimmer: 0 };
  assert.ok(baseVisibility(m, wrong) > 0.4, 'falsche Farbe muss verraten');

  const shimmer = { x: s.x, y: s.y, color: ground.slice(), stillTime: 5, shimmer: C.CAMO_SHIMMER_TIME };
  assert.ok(baseVisibility(m, shimmer) >= C.CAMO_SHIMMER_FLOOR - 1e-6);
});

test('Naehe und Markierung decken auf', () => {
  assert.equal(visibilityForSeeker(0.02, C.REVEAL_HARD_RADIUS - 1), 1);
  assert.ok(visibilityForSeeker(0.02, C.REVEAL_RADIUS - 10) > 0.3);
  assert.equal(visibilityForSeeker(0.02, 500), 0.02);
  assert.equal(visibilityForSeeker(0.02, 500, 1), 1);
});

test('raycastSolid trifft Wand und ignoriert freie Strecke', () => {
  const m = generateMap(3);
  const { tx, ty } = wallWithFloorSides(m);
  const y = ty * C.TILE + 16;
  assert.ok(raycastSolid(m, (tx - 1) * C.TILE + 16, y, (tx + 1) * C.TILE + 16, y));
  const s = openSpot(m);
  assert.equal(raycastSolid(m, s.x - 10, s.y, s.x + 10, s.y), null);
});
