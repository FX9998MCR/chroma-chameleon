import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/constants.js';
import { idx } from '../shared/map.js';
import { makeGame, ticks, seconds, openSpot, openRun, wallWithFloorSides, place, input, startHunt, aimAt, DT } from './helpers.js';

test('Rollenverteilung: ein Jaeger je angefangene vier Spieler', () => {
  for (const [n, want] of [[2, 1], [4, 1], [5, 2], [8, 2], [9, 3], [24, 6]]) {
    const names = Array.from({ length: n }, (_, i) => 'S' + i);
    const { g } = makeGame(1, names);
    g.startRound();
    assert.equal(g.seekers.length, want, `${n} Spieler`);
    assert.equal(g.hiders.length, n - want);
    assert.equal(g.phase, C.PHASE_PREP);
  }
});

test('Rollen rotieren fair ueber Runden', () => {
  const { g } = makeGame(2, ['A', 'B', 'C', 'D']);
  const seekerHistory = [];
  for (let r = 0; r < 4; r++) {
    g.startRound();
    seekerHistory.push(g.seekers[0].name);
    g.endRound(C.ROLE_HIDER);
  }
  assert.equal(new Set(seekerHistory).size, 4, 'jeder war genau einmal Jaeger: ' + seekerHistory);
});

test('Runde startet nicht mit zu wenig Spielern, aber automatisch wenn alle bereit', () => {
  const { g } = makeGame(3, ['Solo']);
  assert.equal(g.startRound(), false);
  g.addPlayer('p2', 'Zwei');
  g.setReady('p1', true);
  g.update(DT);
  assert.equal(g.phase, C.PHASE_LOBBY);
  g.setReady('p2', true);
  g.update(DT);
  assert.equal(g.phase, C.PHASE_PREP);
});

test('Vorbereitung geht in Jagd ueber, Jaeger stehen solange still', () => {
  const { g } = makeGame(4);
  g.startRound();
  const s = g.seekers[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  input(g, s.id, { up: true });
  ticks(g, 10);
  assert.equal(s.x, spot.x);
  const h = g.hiders[0];
  place(h, spot.x, spot.y);
  input(g, h.id, { up: true });
  ticks(g, 10);
  assert.ok(h.x > spot.x, 'Chamaeleon laeuft in Blickrichtung (yaw 0 = +x)');
  seconds(g, C.PREP_SECONDS);
  assert.equal(g.phase, C.PHASE_HUNT);
  ticks(g, 10);
  assert.ok(s.x > spot.x, 'Jaeger laeuft in der Jagd');
});

test('Bewegung folgt der Blickrichtung des Spielers', () => {
  const { g } = makeGame(4);
  startHunt(g);
  const h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x, spot.y);
  input(g, h.id, { up: true }, null, Math.PI / 2);
  ticks(g, 10);
  assert.ok(h.y > spot.y + 20 && Math.abs(h.x - spot.x) < 1);
});

test('Schuss: trifft Chamaeleon in Blickrichtung, Punkte, Wiedereinstieg als Jaeger', () => {
  const { g } = makeGame(5);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  place(h, spot.x + 64, spot.y);
  const look = aimAt(s, h);
  input(g, s.id, {}, { primary: true }, look.yaw, look.pitch);
  g.update(DT);
  assert.equal(h.alive, false, 'getroffen');
  assert.equal(s.catches, 1);
  assert.equal(s.roundScore, C.PTS_CATCH);
  const ev = g.events.find((e) => e.k === 'shot');
  assert.ok(ev && ev.hit && ev.from && ev.to);
  assert.ok(g.events.some((e) => e.k === 'catch' && e.who === h.id));
  seconds(g, C.RESPAWN_SECONDS + 0.2);
  assert.equal(h.role, C.ROLE_SEEKER);
  assert.equal(h.alive, true);
});

test('Schuss geht vorbei: hinter dem Ruecken, zu hoch, hinter einer Saeule, ausser Reichweite', () => {
  const { g } = makeGame(5);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  place(h, spot.x + 64, spot.y);
  input(g, s.id, {}, { primary: true }, Math.PI, 0);
  g.update(DT);
  assert.equal(h.alive, true, 'Rueckwaerts');
  assert.ok(g.events.some((e) => e.k === 'shot' && !e.hit));

  s.shotCd = 0;
  input(g, s.id, {}, { primary: true }, 0, 0.9);
  g.update(DT);
  assert.equal(h.alive, true, 'ueber den Kopf hinweg');

  const { tx, ty } = wallWithFloorSides(g.map);
  const y = ty * C.TILE + 16;
  place(h, tx * C.TILE - 18, y);
  place(s, (tx + 1) * C.TILE + 18, y);
  s.shotCd = 0;
  const look = aimAt(s, h);
  input(g, s.id, {}, { primary: true }, look.yaw, look.pitch);
  g.update(DT);
  assert.equal(h.alive, true, 'Saeule blockiert');
  const ev = g.events.filter((e) => e.k === 'shot').pop();
  assert.ok(ev.wall, 'Einschlag an der Wand gemeldet');

  place(s, spot.x, spot.y);
  place(h, spot.x + (C.SHOT_RANGE + 2) * C.TILE, spot.y);
  s.shotCd = 0;
  const far = aimAt(s, h);
  input(g, s.id, {}, { primary: true }, far.yaw, far.pitch);
  g.update(DT);
  // Entweder ausser Reichweite oder eine Mauer dazwischen - jedenfalls kein Treffer.
  assert.equal(h.alive, true, 'ausser Reichweite');
});

test('Schuss trifft liegende Figur nur bei passendem Nickwinkel', () => {
  const { g } = makeGame(6);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  place(h, spot.x + 96, spot.y);
  h.pose = 3;   // Liegen, 0.35 hoch
  input(g, s.id, {}, { primary: true }, 0, 0);   // waagerecht auf Augenhoehe
  g.update(DT);
  assert.equal(h.alive, true, 'waagerecht geht ueber die liegende Figur');
  s.shotCd = 0;
  const look = aimAt(s, h, 0.15);
  input(g, s.id, {}, { primary: true }, look.yaw, look.pitch);
  g.update(DT);
  assert.equal(h.alive, false, 'nach unten gezielt trifft');
});

test('Schuss hat Abklingzeit', () => {
  const { g } = makeGame(5, ['A', 'B', 'C', 'D', 'E', 'F']);
  startHunt(g);
  const s = g.seekers[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  const [h1, h2] = g.hiders;
  place(h1, spot.x + 48, spot.y);
  place(h2, spot.x + 96, spot.y);
  const look = aimAt(s, h1);
  input(g, s.id, {}, { primary: true }, look.yaw, look.pitch);
  g.update(DT);
  assert.equal(g.hiders.filter((h) => !h.alive).length, 1);
  const look2 = aimAt(s, h2);
  input(g, s.id, {}, { primary: true }, look2.yaw, look2.pitch);
  g.update(DT);
  assert.equal(g.hiders.filter((h) => !h.alive).length, 1, 'zweiter Schuss noch gesperrt');
});

test('Posen: R wechselt durch, Bewegung loest die Pose', () => {
  const { g } = makeGame(7);
  startHunt(g);
  const h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x, spot.y);
  input(g, h.id, {}, { pose: true });
  g.update(DT);
  assert.equal(h.pose, 1);
  assert.ok(g.events.some((e) => e.k === 'pose' && e.pose === 1));
  for (let i = 0; i < C.POSES.length - 1; i++) { input(g, h.id, {}, { pose: true }); g.update(DT); }
  assert.equal(h.pose, 0, 'zyklisch');
  input(g, h.id, {}, { pose: true }); g.update(DT);
  input(g, h.id, {}, { pose: true }); g.update(DT);
  assert.equal(h.pose, 2);
  input(g, h.id, { up: true });
  g.update(DT);
  assert.equal(h.pose, 0, 'Bewegung loest die Pose');
  // Jaeger koennen nicht posieren
  const s = g.seekers[0];
  input(g, s.id, {}, { pose: true }); g.update(DT);
  assert.equal(s.pose, 0);
});

test('Malmodus friert das Chamaeleon ein', () => {
  const { g } = makeGame(7);
  startHunt(g);
  const h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x, spot.y);
  input(g, h.id, { up: true, paint: true });
  ticks(g, 10);
  assert.equal(h.x, spot.x);
  assert.equal(h.painting, true);
  assert.equal(g.snapshotFor(h.id).you.painting, true);
  input(g, h.id, { up: true });
  ticks(g, 10);
  assert.ok(h.x > spot.x);
});

test('Bemalung: setzen, Durchschnittsfarbe, Rundenstart setzt auf weiss zurueck', () => {
  const { g } = makeGame(8);
  startHunt(g);
  const h = g.hiders[0], s = g.seekers[0];
  assert.equal(g.setPaint(h.id, { fill: [10, 20, 30] }, [10, 20, 30]), true);
  assert.deepEqual(h.paint, { fill: [10, 20, 30] });
  assert.deepEqual(h.avgColor, [10, 20, 30]);
  assert.equal(g.setPaint(s.id, { fill: [1, 2, 3] }, null), false, 'Jaeger malen nicht');
  assert.deepEqual(g.paintSnapshot(), [{ id: h.id, paint: { fill: [10, 20, 30] } }]);
  g.setPaint(h.id, { fill: [1, 2, 3] }, [999, -5, 'x']);
  assert.deepEqual(h.avgColor, [255, 0, 0], 'Durchschnitt wird begrenzt');
  g.endRound(C.ROLE_HIDER);
  g.flushEvents();
  g.startRound();
  for (const p of g.players.values()) assert.equal(p.paint, null);
  assert.ok(g.events.filter((e) => e.k === 'paint' && e.paint === null).length >= 3);
});

test('Koeder: traegt Bemalung und Pose des Besitzers, Treffer betaeubt den Jaeger', () => {
  const { g } = makeGame(8);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x + 80, spot.y);
  g.setPaint(h.id, { fill: [5, 6, 7] }, [5, 6, 7]);
  input(g, h.id, {}, { pose: true }); g.update(DT);
  input(g, h.id, {}, { decoy: true }); g.update(DT);
  assert.equal(g.decoys.length, 1);
  assert.deepEqual(g.decoys[0].paint, { fill: [5, 6, 7] });
  assert.equal(g.decoys[0].pose, 1);
  assert.ok(g.events.some((e) => e.k === 'paint' && e.id === g.decoys[0].id));
  input(g, h.id, {}, { decoy: true }); g.update(DT);
  assert.equal(g.decoys.length, 1, 'nur ein Koeder gleichzeitig');

  place(h, spot.x - 400, spot.y);
  place(s, spot.x, spot.y);
  const look = aimAt(s, g.decoys[0], C.POSES[1].h * 0.5);
  input(g, s.id, {}, { primary: true }, look.yaw, look.pitch);
  g.update(DT);
  assert.equal(g.decoys.length, 0, 'Koeder zerplatzt');
  assert.ok(s.stunT > 0);
  assert.ok(h.roundScore >= C.PTS_DECOY_HIT);
  assert.equal(h.alive, true);
  const sx = s.x;
  input(g, s.id, { up: true });
  ticks(g, 3);
  assert.equal(s.x, sx, 'betaeubt');
});

test('Koeder verschwinden nach Ablauf', () => {
  const { g } = makeGame(8);
  startHunt(g);
  const h = g.hiders[0];
  input(g, h.id, {}, { decoy: true });
  g.update(DT);
  seconds(g, C.DECOY_LIFETIME + 0.5);
  assert.equal(g.decoys.length, 0);
});

test('alle gefangen -> Jaeger gewinnen; Zeit abgelaufen -> Chamaeleons gewinnen', () => {
  {
    const { g } = makeGame(6, ['A', 'B']);
    startHunt(g);
    const h = g.hiders[0];
    h.alive = false; h.respawnT = 5;
    g.update(DT);
    assert.equal(g.phase, C.PHASE_OVER);
    assert.equal(g.lastWinner, C.ROLE_SEEKER);
  }
  {
    const { g } = makeGame(6, ['A', 'B', 'C']);
    startHunt(g);
    const survivors = g.aliveHiders.map((p) => p.id);
    g.phaseTime = 0.01;
    g.update(DT);
    assert.equal(g.phase, C.PHASE_OVER);
    assert.equal(g.lastWinner, C.ROLE_HIDER);
    for (const id of survivors) assert.ok(g.players.get(id).score >= C.PTS_SURVIVE_ROUND);
  }
});

test('nach der Endphase startet automatisch die naechste Runde', () => {
  const { g } = makeGame(6, ['A', 'B', 'C']);
  startHunt(g);
  g.phaseTime = 0.01;
  g.update(DT);
  seconds(g, C.OVER_SECONDS + 0.2);
  assert.equal(g.phase, C.PHASE_PREP);
  assert.equal(g.round, 2);
});

test('Dash des Jaegers folgt der Blickrichtung', () => {
  const { g } = makeGame(12);
  startHunt(g);
  const s = g.seekers[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  input(g, s.id, { up: true }, { dash: true }, Math.PI / 2);
  g.update(DT);
  assert.ok(s.dashT > 0);
  ticks(g, 2);
  assert.ok(s.y - spot.y > C.DASH_SPEED * DT * 2 * 0.9);
  assert.ok(s.dashCd > 0);
});

test('Ausdauer und Farbspuren beim Sprint', () => {
  const { g } = makeGame(13);
  startHunt(g);
  const h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x, spot.y);
  g.setPaint(h.id, { fill: [1, 2, 3] }, [1, 2, 3]);
  input(g, h.id, { up: true, sprint: true });
  seconds(g, 1);
  assert.ok(h.stamina < C.STAMINA_MAX - 20);
  assert.ok(g.splats.length >= 2);
  assert.deepEqual(g.splats[0].color, [1, 2, 3], 'Spur in der eigenen Farbe');
  input(g, h.id, {});
  seconds(g, C.STAMINA_REGEN_DELAY + 1);
  assert.ok(h.stamina > 30);
});

test('Snapshot: jeder sieht jede Figur in Sichtweite; Jaeger ohne Namen; Koeder unkenntlich', () => {
  const { g } = makeGame(14, ['A', 'B', 'C', 'D']);
  startHunt(g);
  const s = g.seekers[0];
  const [h1, h2] = g.hiders;
  const run = openRun(g.map, 5);
  place(s, run.x + 2 * C.TILE, run.y);
  place(h1, run.x + 4 * C.TILE, run.y);
  place(h2, run.x, run.y);
  input(g, h2.id, {}, { decoy: true }); g.update(DT);
  assert.equal(g.decoys.length, 1, 'Testaufbau: Koeder gesetzt');

  const snapS = g.snapshotFor(s.id);
  const ids = snapS.players.map((p) => p.id);
  assert.ok(ids.includes(h1.id) && ids.includes(h2.id), 'Jaeger sieht beide Figuren');
  for (const p of snapS.players) {
    assert.equal(p.name, null, 'keine Namen fuer Jaeger');
    assert.equal(p.decoy, false, 'Koeder nicht als solcher markiert');
    assert.equal('alpha' in p, false, 'keine Sichtbarkeitswerte mehr');
  }
  const snapH = g.snapshotFor(h1.id);
  assert.ok(snapH.players.some((p) => p.id === h2.id && p.name === h2.name));
  assert.ok(snapH.players.some((p) => p.decoy === true && p.name === 'Köder'));
  assert.ok(snapH.players.some((p) => p.id === s.id && p.name === s.name));
});

test('Snapshot: weit entfernte Spieler werden nicht gesendet', () => {
  const { g } = makeGame(14, ['A', 'B', 'C']);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  place(s, 100, 100);
  place(h, 100 + C.VIEW_RADIUS + 50, 100);
  assert.ok(!g.snapshotFor(s.id).players.some((p) => p.id === h.id));
});

test('letzter Jaeger geht -> ein Chamaeleon wird Jaeger; zu wenige Spieler -> Lobby', () => {
  const { g } = makeGame(17, ['A', 'B', 'C', 'D']);
  startHunt(g);
  g.removePlayer(g.seekers[0].id);
  assert.equal(g.seekers.length, 1);
  assert.ok(g.events.some((e) => e.k === 'converted'));
  g.removePlayer(g.hiders[0].id);
  g.removePlayer(g.hiders[0].id);
  g.update(DT);
  assert.equal(g.phase, C.PHASE_LOBBY);
});

test('Wer mitten in der Runde kommt, jagt mit', () => {
  const { g } = makeGame(18);
  startHunt(g);
  const p = g.addPlayer('neu', 'Neu');
  assert.equal(p.role, C.ROLE_SEEKER);
});

test('Eingaben werden bereinigt', () => {
  const { g } = makeGame(19);
  g.setInput('p1', { up: 'ja', left: 0 }, { primary: 1, unbekannt: true }, { yaw: 'x', pitch: 9 }, 5);
  const p = g.players.get('p1');
  assert.equal(p.input.up, true);
  assert.equal(p.input.left, false);
  assert.equal(p.actions.primary, true);
  assert.equal('unbekannt' in p.actions, false);
  assert.equal(p.yaw, 0);
  assert.equal(p.pitch, 1.5, 'Nickwinkel begrenzt');
  assert.equal(p.seq, 5);
});
