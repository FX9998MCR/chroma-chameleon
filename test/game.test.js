import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/constants.js';
import { idx, tileColorAt } from '../shared/map.js';
import { raycastSolid } from '../shared/physics.js';
import { makeGame, ticks, seconds, openSpot, wallWithFloorSides, place, input, startHunt, DT } from './helpers.js';

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
  input(g, s.id, { right: true });
  ticks(g, 10);
  assert.equal(s.x, spot.x, 'Jaeger darf sich in der Vorbereitung nicht bewegen');
  const h = g.hiders[0];
  place(h, spot.x, spot.y);
  input(g, h.id, { right: true });
  ticks(g, 10);
  assert.ok(h.x > spot.x, 'Chamaeleon bewegt sich');
  seconds(g, C.PREP_SECONDS);
  assert.equal(g.phase, C.PHASE_HUNT);
  ticks(g, 10);
  assert.ok(s.x > spot.x, 'Jaeger laeuft in der Jagd');
});

test('Fangen: Zungenschlag im Nahbereich, Punkte, Wiedereinstieg als Jaeger', () => {
  const { g } = makeGame(5);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  place(h, spot.x + 40, spot.y);
  input(g, s.id, {}, { primary: true }, 0);
  g.update(DT);
  assert.equal(h.alive, false);
  assert.equal(s.catches, 1);
  assert.equal(s.roundScore, C.PTS_CATCH);
  assert.ok(g.events.some((e) => e.k === 'catch' && e.who === h.id));
  seconds(g, C.RESPAWN_SECONDS + 0.2);
  assert.equal(h.role, C.ROLE_SEEKER);
  assert.equal(h.alive, true);
});

test('Fangen scheitert hinter dem Ruecken und hinter einer Wand', () => {
  const { g } = makeGame(5);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  place(h, spot.x + 40, spot.y);
  input(g, s.id, {}, { primary: true }, Math.PI);   // schaut weg
  g.update(DT);
  assert.equal(h.alive, true, 'Rueckwaerts darf nichts treffen');

  const { tx, ty } = wallWithFloorSides(g.map);
  const y = ty * C.TILE + 16;
  place(h, tx * C.TILE - 14, y);
  place(s, (tx + 1) * C.TILE + 14, y);
  assert.ok(Math.hypot(h.x - s.x, h.y - s.y) < C.CATCH_RANGE + C.PLAYER_RADIUS, 'Testaufbau: in Reichweite');
  assert.ok(raycastSolid(g.map, s.x, s.y, h.x, h.y, 5), 'Testaufbau: Wand dazwischen');
  s.catchCd = 0;
  input(g, s.id, {}, { primary: true }, Math.PI);
  g.update(DT);
  assert.equal(h.alive, true, 'Wand blockiert den Fang');
});

test('Fangen hat Abklingzeit', () => {
  const { g } = makeGame(5, ['A', 'B', 'C', 'D', 'E', 'F']);
  startHunt(g);
  const s = g.seekers[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  const [h1, h2] = g.hiders;
  place(h1, spot.x + 30, spot.y);
  place(h2, spot.x + 30, spot.y + 12);
  input(g, s.id, {}, { primary: true }, 0);
  g.update(DT);
  assert.equal(g.hiders.filter((h) => !h.alive).length, 1, 'nur ein Fang pro Schlag');
  input(g, s.id, {}, { primary: true }, 0);
  g.update(DT);
  assert.equal(g.hiders.filter((h) => !h.alive).length, 1, 'zweiter Schlag noch gesperrt');
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
    const ev = g.events.find((e) => e.k === 'roundend');
    assert.equal(ev.survivors.length, survivors.length);
  }
});

test('nach der Endphase startet automatisch die naechste Runde', () => {
  const { g } = makeGame(6, ['A', 'B', 'C']);
  startHunt(g);
  g.phaseTime = 0.01;
  g.update(DT);
  assert.equal(g.round, 1);
  seconds(g, C.OVER_SECONDS + 0.2);
  assert.equal(g.phase, C.PHASE_PREP);
  assert.equal(g.round, 2);
});

test('Ueberlebende Chamaeleons sammeln Sekundenpunkte', () => {
  const { g } = makeGame(6, ['A', 'B', 'C']);
  startHunt(g);
  const h = g.hiders[0];
  seconds(g, 5);
  assert.ok(h.roundScore >= 4 && h.roundScore <= 6, 'ca. 5 Punkte: ' + h.roundScore);
});

test('Farbaufnahme: E halten faerbt um, Bewegung bricht ab', () => {
  const { g } = makeGame(7);
  startHunt(g);
  const h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x, spot.y);
  const ground = tileColorAt(g.map, spot.x, spot.y);
  assert.notDeepEqual(h.color, ground);
  input(g, h.id, { absorb: true });
  seconds(g, C.ABSORB_TIME * 0.6);
  assert.notDeepEqual(h.color, ground, 'noch nicht fertig');
  input(g, h.id, { absorb: true, right: true });
  ticks(g, 2);
  assert.equal(h.absorbing, 0, 'Bewegung bricht die Aufnahme ab');
  // Beim Laufen bleibt die Aufnahme aus, bis man wieder steht.
  place(h, spot.x, spot.y);
  input(g, h.id, { absorb: true });
  seconds(g, C.ABSORB_TIME + 0.15);
  assert.deepEqual(h.color, ground);
  assert.ok(h.shimmer > 0, 'Flimmern nach der Aufnahme');
});

test('Koeder: Jaeger schlaegt zu, wird betaeubt, Besitzer punktet', () => {
  const { g } = makeGame(8);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x + 40, spot.y);
  input(g, h.id, {}, { decoy: true });
  g.update(DT);
  assert.equal(g.decoys.length, 1);
  assert.equal(g.decoys[0].owner, h.id);
  input(g, h.id, {}, { decoy: true });
  g.update(DT);
  assert.equal(g.decoys.length, 1, 'nur ein Koeder gleichzeitig');

  place(h, spot.x - 300, spot.y);   // Besitzer weg vom Koeder
  place(s, spot.x, spot.y);
  input(g, s.id, {}, { primary: true }, 0);
  g.update(DT);
  assert.equal(g.decoys.length, 0, 'Koeder zerplatzt');
  assert.ok(s.stunT > 0, 'Jaeger betaeubt');
  assert.equal(h.roundScore >= C.PTS_DECOY_HIT, true);
  assert.equal(h.alive, true);
  // Betaeubt kann er sich nicht bewegen.
  const sx = s.x;
  input(g, s.id, { right: true });
  ticks(g, 3);
  assert.equal(s.x, sx);
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

test('Puls-Scan markiert nur bewegte Chamaeleons', () => {
  const { g } = makeGame(9, ['A', 'B', 'C', 'D', 'E']);
  startHunt(g);
  const s = g.seekers[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  const [mover, stiller] = g.hiders;
  place(mover, spot.x + 120, spot.y);
  place(stiller, spot.x - 120, spot.y);
  stiller.lastMoveT = 99; stiller.stillTime = 99;
  input(g, mover.id, { right: true });
  ticks(g, 3);
  input(g, mover.id, {});
  input(g, s.id, {}, { scan: true });
  g.update(DT);
  assert.equal(g.scans.length, 1);
  seconds(g, 0.6);
  assert.ok(mover.markT > 0, 'bewegtes Chamaeleon markiert');
  assert.equal(stiller.markT, 0, 'stilles Chamaeleon bleibt verborgen');
  assert.ok(s.scanCd > 0);
});

test('Zungenhaken zieht zur Saeule und loest dort', () => {
  const { g } = makeGame(10);
  startHunt(g);
  const h = g.hiders[0];
  let setup = null;
  for (const a of g.map.anchors) {
    for (const d of [140, 180, 220]) {
      const x = a.x - d, y = a.y;
      if (raycastSolid(g.map, x, y, a.x - C.TILE * 0.72, y)) continue;
      const { circleHitsSolid } = { circleHitsSolid: null };
      // Position muss frei sein
      if (g.map.tiles[idx(Math.floor(x / C.TILE), Math.floor(y / C.TILE))] !== C.T_FLOOR) continue;
      setup = { a, x, y }; break;
    }
    if (setup) break;
  }
  assert.ok(setup, 'Testaufbau: Anker mit freier Bahn');
  place(h, setup.x, setup.y);
  input(g, h.id, {}, { grapple: true }, 0);
  g.update(DT);
  assert.ok(h.grapple, 'Haken sitzt');
  assert.equal(h.grapple.ax, setup.a.x);
  const startDist = Math.hypot(setup.a.x - h.x, setup.a.y - h.y);
  seconds(g, 0.2);
  assert.ok(Math.hypot(setup.a.x - h.x, setup.a.y - h.y) < startDist - 60, 'wird gezogen');
  seconds(g, C.GRAPPLE_MAX_TIME);
  assert.equal(h.grapple, null, 'loest sich');
  assert.ok(Math.hypot(setup.a.x - h.x, setup.a.y - h.y) < C.TILE * 1.6, 'nah an der Saeule');
  assert.ok(h.grappleCd > 0);
});

test('Zungenhaken ohne Ziel: Fehlschlag-Ereignis, keine Abklingzeit', () => {
  const { g } = makeGame(10);
  startHunt(g);
  const h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x, spot.y);
  // Zielrichtung, in der garantiert kein Anker in Reichweite liegt: wir drehen
  // so lange, bis keiner im Kegel ist.
  let aim = 0, found = true;
  for (let k = 0; k < 24 && found; k++) {
    aim = (k / 24) * Math.PI * 2;
    found = g.map.anchors.some((a) => {
      const d = Math.hypot(a.x - spot.x, a.y - spot.y);
      const ang = Math.atan2(a.y - spot.y, a.x - spot.x);
      return d <= C.GRAPPLE_RANGE && Math.abs(((ang - aim + Math.PI * 3) % (Math.PI * 2)) - Math.PI) <= 0.32;
    });
  }
  if (found) return;  // sehr dichte Karte: Test nicht aussagekraeftig
  input(g, h.id, {}, { grapple: true }, aim);
  g.update(DT);
  assert.equal(h.grapple, null);
  assert.equal(h.grappleCd, 0);
  assert.ok(g.events.some((e) => e.k === 'grapplemiss'));
});

test('Dash des Jaegers: kurzer Schub, dann Abklingzeit', () => {
  const { g } = makeGame(12);
  startHunt(g);
  const s = g.seekers[0];
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  input(g, s.id, { right: true }, { dash: true }, 0);
  g.update(DT);
  assert.ok(s.dashT > 0);
  ticks(g, 2);
  assert.ok(s.x - spot.x > C.DASH_SPEED * DT * 2 * 0.9, 'schneller als normal');
  assert.ok(s.dashCd > 0);
});

test('Ausdauer: Sprint verbraucht, Ruhe fuellt auf', () => {
  const { g } = makeGame(13);
  startHunt(g);
  const h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x, spot.y);
  input(g, h.id, { right: true, sprint: true });
  seconds(g, 1);
  assert.ok(h.stamina < C.STAMINA_MAX - 20, 'verbraucht: ' + h.stamina);
  const after = h.stamina;
  input(g, h.id, {});
  seconds(g, C.STAMINA_REGEN_DELAY + 1);
  assert.ok(h.stamina > after + 10, 'aufgefuellt');
});

test('Sprint hinterlaesst Farbspuren, die verblassen', () => {
  const { g } = makeGame(13);
  startHunt(g);
  const h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x, spot.y);
  input(g, h.id, { right: true, sprint: true });
  seconds(g, 1);
  assert.ok(g.splats.length >= 2, 'Kleckse: ' + g.splats.length);
  input(g, h.id, {});
  seconds(g, C.SPLAT_LIFETIME + 0.5);
  assert.equal(g.splats.length, 0);
});

test('Snapshot: Jaeger sieht getarnte Chamaeleons nicht, Chamaeleons sehen Team und Jaeger', () => {
  const { g } = makeGame(14, ['A', 'B', 'C', 'D']);
  startHunt(g);
  const s = g.seekers[0];
  const [h1, h2] = g.hiders;
  const spot = openSpot(g.map);
  place(s, spot.x, spot.y);
  // h1 perfekt getarnt in 400px Abstand
  const far = openSpot(g.map, spot.tx + 10, spot.ty);
  place(h1, far.x, far.y);
  h1.color = tileColorAt(g.map, far.x, far.y).slice();
  h1.stillTime = 99;
  place(h2, spot.x + 60, spot.y);   // h2 direkt daneben

  const snapS = g.snapshotFor(s.id);
  const idsS = snapS.players.map((p) => p.id);
  assert.ok(!idsS.includes(h1.id), 'getarntes Chamaeleon darf nicht gesendet werden');
  assert.ok(idsS.includes(h2.id), 'nahes Chamaeleon ist sichtbar');
  const h2view = snapS.players.find((p) => p.id === h2.id);
  assert.equal(h2view.name, null, 'Jaeger sehen keine Namen');
  assert.ok(h2view.alpha > 0.5, 'nah und in Bewegung: deutlich sichtbar');

  const snapH = g.snapshotFor(h2.id);
  const idsH = snapH.players.map((p) => p.id);
  assert.ok(idsH.includes(h1.id) && idsH.includes(s.id), 'Chamaeleon sieht Team und Jaeger');
  assert.equal(snapH.players.find((p) => p.id === h1.id).name, 'A' === h1.name ? 'A' : h1.name);
  assert.ok(snapH.you.vis >= 0 && snapH.you.vis <= 1);
});

test('Snapshot: weit entfernte Spieler werden nicht gesendet', () => {
  const { g } = makeGame(14, ['A', 'B', 'C']);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  place(s, 100, 100);
  place(h, 100 + C.VIEW_RADIUS + 50, 100);
  h.stillTime = 0;
  assert.ok(!g.snapshotFor(s.id).players.some((p) => p.id === h.id));
  assert.ok(!g.snapshotFor(h.id).players.some((p) => p.id === s.id));
});

test('Snapshot: Koeder ist fuer Jaeger nicht von einem Chamaeleon zu unterscheiden', () => {
  const { g } = makeGame(15);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  const spot = openSpot(g.map);
  place(h, spot.x + 50, spot.y);
  input(g, h.id, {}, { decoy: true });
  g.update(DT);
  place(s, spot.x, spot.y);
  const snap = g.snapshotFor(s.id);
  const decoyView = snap.players.find((p) => p.id.startsWith('d'));
  assert.ok(decoyView, 'Koeder in Sicht');
  assert.equal(decoyView.decoy, false);
  assert.equal(decoyView.name, null);
  assert.equal(decoyView.role, C.ROLE_HIDER);
  const ownView = g.snapshotFor(h.id).players.find((p) => p.id.startsWith('d'));
  assert.equal(ownView.decoy, true, 'Besitzer erkennt den eigenen Koeder');
});

test('Ereignisse mit Position erreichen Jaeger nur in Sichtweite', () => {
  const { g } = makeGame(16, ['A', 'B', 'C']);
  startHunt(g);
  const s = g.seekers[0], h = g.hiders[0];
  place(s, 100, 100);
  place(h, 100 + C.VIEW_RADIUS + 200, 100);
  g.pushEvent({ k: 'grapple', id: h.id, x: h.x, y: h.y, ax: h.x, ay: h.y });
  assert.equal(g.snapshotFor(s.id).events.filter((e) => e.k === 'grapple').length, 0);
  assert.equal(g.snapshotFor(h.id).events.filter((e) => e.k === 'grapple').length, 1);
});

test('letzter Jaeger geht -> ein Chamaeleon wird Jaeger; zu wenige Spieler -> Lobby', () => {
  const { g } = makeGame(17, ['A', 'B', 'C', 'D']);
  startHunt(g);
  const s = g.seekers[0];
  g.removePlayer(s.id);
  assert.equal(g.seekers.length, 1, 'Ersatzjaeger');
  assert.ok(g.events.some((e) => e.k === 'converted'));
  assert.equal(g.phase, C.PHASE_HUNT);
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
  assert.ok(g.snapshotFor('neu'));
});

test('Eingaben werden bereinigt', () => {
  const { g } = makeGame(19);
  g.setInput('p1', { up: 'ja', left: 0 }, { primary: 1, unbekannt: true }, NaN, 5);
  const p = g.players.get('p1');
  assert.equal(p.input.up, true);
  assert.equal(p.input.left, false);
  assert.equal(p.actions.primary, true);
  assert.equal('unbekannt' in p.actions, false);
  assert.equal(p.aim, 0);
  assert.equal(p.seq, 5);
});

test('Anzeigetafel ist nach Punkten sortiert', () => {
  const { g } = makeGame(20);
  g.players.get('p2').score = 50;
  g.players.get('p3').score = 90;
  const sb = g.scoreboard();
  assert.deepEqual(sb.map((r) => r.id), ['p3', 'p2', 'p1']);
});
