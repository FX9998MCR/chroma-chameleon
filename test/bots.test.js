import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/constants.js';
import { generateMap, idx } from '../shared/map.js';
import { Room } from '../server/room.js';
import { bfs, pathTo, BotBrain, TURN_AIM, TURN_SCAN } from '../server/bots.js';
import { angleDiff } from '../shared/physics.js';
import { makeGame, DT, startHunt, openSpot, openRun, place, input, aimAt, seededRng } from './helpers.js';

test('BFS findet Wege und meidet Waende', () => {
  const map = generateMap(5);
  const s = map.spawns[0], t = map.spawns[5];
  const search = bfs(map, Math.floor(s.x / C.TILE), Math.floor(s.y / C.TILE));
  const path = pathTo(search, idx(Math.floor(t.x / C.TILE), Math.floor(t.y / C.TILE)));
  assert.ok(path && path.length > 2);
  for (const w of path) assert.ok(!C.SOLID_TILES.has(map.tiles[idx(Math.floor(w.x / C.TILE), Math.floor(w.y / C.TILE))]));
  for (let i = 1; i < path.length; i++) {
    assert.equal(Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y), C.TILE);
  }
});

test('Raum: Bots hinzufuegen/entfernen, zaehlen zur Kapazitaet, immer bereit', () => {
  const room = new Room('TEST', { seed: 3 });
  const fakeWs = { readyState: 1, bufferedAmount: 0, send() {} };
  const id = room.join(fakeWs, 'Mensch');
  assert.ok(room.addBot());
  assert.ok(room.addBot());
  assert.equal(room.total, 3);
  const sb = room.game.scoreboard();
  assert.equal(sb.filter((r) => r.bot).length, 2);
  assert.ok(sb.filter((r) => r.bot).every((r) => r.ready));
  assert.equal(room.game.allReady(), false);
  room.game.setReady(id, true);
  assert.equal(room.game.allReady(), true);
  assert.ok(room.removeBot());
  assert.equal(room.total, 2);
  room.leave(id);
  assert.equal(room.game.allReady(), false);
});

test('Chamaeleon-Bot geht ins Versteck, malt sich in Umgebungsfarbe und nimmt eine Pose ein', async () => {
  const { g } = makeGame(21, ['Mensch']);
  const bot = g.addPlayer('bot1', 'Bot Kiwi'); bot.bot = true;
  const brain = new BotBrain(g, 'bot1', () => 0.5);
  g.startRound();
  const human = g.players.get('p1');
  if (human.role !== C.ROLE_SEEKER) { human.role = C.ROLE_SEEKER; bot.role = C.ROLE_HIDER; }
  const start = { x: bot.x, y: bot.y };
  for (let i = 0; i < 20 * 14; i++) { brain.think(DT); g.update(DT); }
  assert.ok(Math.hypot(bot.x - start.x, bot.y - start.y) > 60, 'Bot hat sich bewegt');
  assert.ok(bot.paint && bot.paint.fill, 'Bot hat sich bemalt');
  assert.ok(bot.pose !== 0, 'Bot posiert: ' + bot.pose);
  assert.ok(bot.stillTime > 0.5, 'Bot steht still');
  assert.ok(g.events.some((e) => e.k === 'paint' && e.id === 'bot1'), 'Bemalung wurde gemeldet');
  // Farbe passt zu Boden oder Nachbarwand
  const { tileColorAt, wallColorAt } = await import('../shared/map.js');
  const tx = Math.floor(bot.x / C.TILE), ty = Math.floor(bot.y / C.TILE);
  const cands = [tileColorAt(g.map, bot.x, bot.y)];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (g.map.tiles[idx(tx + dx, ty + dy)] === C.T_WALL) cands.push(wallColorAt(g.map, tx + dx, ty + dy));
  assert.ok(cands.some((c) => c.join() === bot.paint.fill.join()), 'Farbe stammt aus der Umgebung');
});

test('Jaeger-Bot entdeckt ein unbemaltes, bewegtes Chamaeleon in Sichtlinie und trifft es', async () => {
  const { g } = makeGame(22, ['Mensch']);
  const bot = g.addPlayer('bot1', 'Bot Nova'); bot.bot = true;
  let seed = 7;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const brain = new BotBrain(g, 'bot1', rng);
  g.startRound();
  const human = g.players.get('p1');
  bot.role = C.ROLE_SEEKER; human.role = C.ROLE_HIDER;
  g.phaseTime = 0.01; g.update(DT);
  assert.equal(g.phase, C.PHASE_HUNT);
  place(bot, g.seekerSpawn.x, g.seekerSpawn.y);
  const s = bfs(g.map, Math.floor(bot.x / C.TILE), Math.floor(bot.y / C.TILE));
  let ti = -1;
  for (let i = 0; i < s.dist.length; i++) if (s.dist[i] === 4 && g.map.tiles[i] === C.T_FLOOR) { ti = i; break; }
  assert.ok(ti >= 0);
  place(human, (ti % C.MAP_W) * C.TILE + 16, Math.floor(ti / C.MAP_W) * C.TILE + 16);
  let caught = false;
  for (let i = 0; i < 20 * 20 && !caught; i++) {
    human.stillTime = 0;   // Mensch zappelt
    brain.think(DT); g.update(DT);
    if (!human.alive) caught = true;
  }
  assert.ok(caught, 'Bot hat getroffen');
});

test('Jaeger-Bot uebersieht ein gut bemaltes, stilles Chamaeleon meist', async () => {
  const { g } = makeGame(23, ['Mensch']);
  const bot = g.addPlayer('bot1', 'Bot Nova'); bot.bot = true;
  let seed = 3;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const brain = new BotBrain(g, 'bot1', rng);
  g.startRound();
  const human = g.players.get('p1');
  bot.role = C.ROLE_SEEKER; human.role = C.ROLE_HIDER;
  g.phaseTime = 0.01; g.update(DT);
  const { tileColorAt } = await import('../shared/map.js');
  const run = openRun(g.map, 7);
  const spot = { x: run.x + 6 * C.TILE, y: run.y };
  place(human, spot.x, spot.y);
  place(bot, run.x, run.y);
  human.pose = 3;
  human.stillTime = 99;
  // Der Bot schaut von schraeg oben auf den Boden hinter der Figur: Bodenfarbe zaehlt.
  g.setPaint(human.id, { fill: tileColorAt(g.map, spot.x, spot.y) }, tileColorAt(g.map, spot.x, spot.y));
  let seen = 0;
  for (let k = 0; k < 40; k++) if (brain.perceive(bot, human, 0.25)) seen++;
  assert.ok(seen <= 8, 'gut getarnt wird selten entdeckt: ' + seen + '/40');
  human.paint = null; human.avgColor = [245, 245, 245];
  let seen2 = 0;
  for (let k = 0; k < 40; k++) if (brain.perceive(bot, human, 0.25)) seen2++;
  assert.ok(seen2 > seen, 'weiss ist auffaelliger: ' + seen2);
});

test('Bots ueberstehen viele Runden ohne Fehler (Stresstest)', () => {
  const room = new Room('T3', { seed: 9 });
  const fakeWs = { readyState: 1, bufferedAmount: 0, send() {} };
  const id = room.join(fakeWs, 'Ich');
  for (let i = 0; i < 6; i++) room.addBot();
  room.game.setReady(id, true);
  let now = 1_000_000;
  for (let i = 0; i < 20 * 400; i++) { now += C.TICK_MS; room.step(now); }
  assert.ok(room.game.round >= 2, 'mehrere Runden gespielt: ' + room.game.round);
  assert.ok(room.game.scoreboard().some((r) => r.bot && r.score > 0), 'Bots sammeln Punkte');
});

// ------------------------------------------------------------------ Regressionen und Verhalten

/** Summe und Maximum der Blickdrehung ueber eine Folge von yaw-Werten. */
function turnStats(yaws) {
  let total = 0, maxStep = 0, maxWindow = 0;
  const steps = [];
  for (let i = 1; i < yaws.length; i++) {
    const d = Math.abs(angleDiff(yaws[i - 1], yaws[i]));
    steps.push(d);
    total += d;
    maxStep = Math.max(maxStep, d);
  }
  const win = Math.round(1 / DT);
  let acc = 0;
  for (let i = 0; i < steps.length; i++) {
    acc += steps[i];
    if (i >= win) acc -= steps[i - win];
    maxWindow = Math.max(maxWindow, acc);
  }
  return { total, maxStep, maxWindow };
}

test('Regression: gefangener Bot wird Jaeger und dreht sich danach nicht im Kreis', () => {
  for (const seed of [21, 23, 31]) {
    const { g } = makeGame(seed, ['Mensch', 'Anna']);
    const bot = g.addPlayer('bot1', 'Bot Kiwi'); bot.bot = true;
    const brain = new BotBrain(g, 'bot1', seededRng(seed));
    startHunt(g);
    const human = g.players.get('p1');
    human.role = C.ROLE_SEEKER; bot.role = C.ROLE_HIDER;
    g.players.get('p2').role = C.ROLE_HIDER;          // damit die Runde nach dem Fang weiterlaeuft
    const run = openRun(g.map, 7);
    place(human, run.x, run.y);
    place(bot, run.x + 4 * C.TILE, run.y);
    // Echter Treffer mit dem Farbmarkierer
    const a = aimAt(human, bot, 0.5);
    input(g, 'p1', {}, { primary: true }, a.yaw, a.pitch);
    g.update(DT);
    assert.equal(bot.alive, false, 'Bot wurde getroffen (Seed ' + seed + ')');
    for (let i = 0; i < 20 * 4 && bot.role !== C.ROLE_SEEKER; i++) { brain.think(DT); g.update(DT); }
    assert.equal(bot.role, C.ROLE_SEEKER, 'Bot ist jetzt Jaeger');
    assert.equal(g.phase, C.PHASE_HUNT);

    const start = { x: bot.x, y: bot.y };
    const yaws = [bot.yaw];
    let pathLen = 0, px = bot.x, py = bot.y;
    for (let i = 0; i < 20 * 10; i++) {
      brain.think(DT); g.update(DT);
      yaws.push(bot.yaw);
      pathLen += Math.hypot(bot.x - px, bot.y - py); px = bot.x; py = bot.y;
      assert.ok(bot.yaw >= -Math.PI - 1e-9 && bot.yaw <= Math.PI + 1e-9, 'yaw bleibt normiert: ' + bot.yaw);
    }
    const st = turnStats(yaws);
    // Vorher: Sprung um bis zu PI pro Takt und ueber 6 rad pro Sekunde im Dauerkreisel.
    assert.ok(st.maxStep <= TURN_AIM * DT + 0.02, `Seed ${seed}: Drehung pro Takt begrenzt (${st.maxStep.toFixed(2)})`);
    assert.ok(st.maxWindow < Math.PI * 1.5, `Seed ${seed}: kein Kreiseln (${st.maxWindow.toFixed(2)} rad in 1 s)`);
    assert.ok(st.total / 10 < 2, `Seed ${seed}: ruhiger Blick (${(st.total / 10).toFixed(2)} rad/s)`);
    const net = Math.hypot(bot.x - start.x, bot.y - start.y);
    assert.ok(net > 4 * C.TILE, `Seed ${seed}: Bot kommt voran (${(net / C.TILE).toFixed(1)} Kacheln)`);
    assert.ok(pathLen < net * 3 + 4 * C.TILE, `Seed ${seed}: kein Umherirren (Weg ${pathLen.toFixed(0)} px, netto ${net.toFixed(0)} px)`);
  }
});

test('Bot erreicht Zielpunkte und bleibt stehen, statt um sie zu kreisen', () => {
  const { g } = makeGame(5, ['Mensch']);
  const bot = g.addPlayer('bot1', 'Bot Kiwi'); bot.bot = true;
  const brain = new BotBrain(g, 'bot1', seededRng(5));
  const rng = seededRng(99);
  for (const role of [C.ROLE_HIDER, C.ROLE_SEEKER]) {
    bot.role = role;
    for (let k = 0; k < 8; k++) {
      const s = bfs(g.map, Math.floor(bot.x / C.TILE), Math.floor(bot.y / C.TILE));
      const cands = [];
      for (let i = 0; i < s.dist.length; i++) if (s.dist[i] >= 5 && s.dist[i] <= 30) cands.push(i);
      const ti = cands[(rng() * cands.length) | 0];
      const goal = { x: (ti % C.MAP_W) * C.TILE + 16, y: Math.floor(ti / C.MAP_W) * C.TILE + 16 };
      assert.ok(brain.pathToPoint(bot, goal.x, goal.y));
      const yaws = [bot.yaw];
      let status = 'moving', t = 0;
      for (; t < 20 * 15 && status !== 'arrived'; t++) {
        if (brain.moveYaw !== null) brain.turnTo(brain.moveYaw, 4.5, DT);
        const r = brain.moveAlong(bot, DT, {});
        status = r.status;
        if (r.status === 'none' && brain.unstickT <= 0) brain.pathToPoint(bot, goal.x, goal.y);
        brain.send(r.keys, null);
        g.update(DT);
        yaws.push(bot.yaw);
      }
      assert.equal(status, 'arrived', `${role}: Ziel ${k} erreicht`);
      const est = s.dist[ti] * C.TILE / C.HIDER_SPEED;
      assert.ok(t * DT < est * 1.6 + 1.5, `${role}: zuegig angekommen (${(t * DT).toFixed(1)} s, Schaetzung ${est.toFixed(1)} s)`);
      // Ein paar Takte ohne Eingabe: steht wirklich
      for (let i = 0; i < 10; i++) { brain.send({}, null); g.update(DT); }
      assert.ok(Math.hypot(bot.x - goal.x, bot.y - goal.y) < 9, `${role}: steht am Ziel`);
      assert.ok(Math.hypot(bot.vx, bot.vy) < 1, `${role}: in Ruhe`);
      assert.ok(turnStats(yaws).maxWindow < Math.PI * 1.5, `${role}: kein Kreiseln am Wegpunkt`);
    }
  }
});

test('Chamaeleon-Bot haelt nach dem Posieren still und fliegt nicht grundlos auf', () => {
  const { g } = makeGame(21, ['Mensch']);
  const bot = g.addPlayer('bot1', 'Bot Kiwi'); bot.bot = true;
  const brain = new BotBrain(g, 'bot1', seededRng(4));
  g.startRound();
  const human = g.players.get('p1');
  human.role = C.ROLE_SEEKER; bot.role = C.ROLE_HIDER;
  for (let i = 0; i < 20 * 14; i++) { brain.think(DT); g.update(DT); }
  assert.equal(brain.state, 'hide');
  const snap = { x: bot.x, y: bot.y, pose: bot.pose, yaw: bot.yaw };
  // Der Jaeger steht weit weg am Start und schaut in eine andere Richtung.
  human.yaw = Math.atan2(snap.y - human.y, snap.x - human.x) + Math.PI;
  for (let i = 0; i < 20 * 10; i++) { brain.think(DT); g.update(DT); }
  assert.equal(g.phase, C.PHASE_HUNT);
  assert.equal(bot.x, snap.x); assert.equal(bot.y, snap.y);
  assert.equal(bot.pose, snap.pose, 'Pose bleibt');
  assert.equal(bot.yaw, snap.yaw, 'dreht sich nicht in der Pose');
  assert.ok(bot.stillTime > 9);
});

test('Chamaeleon-Bot flieht, wenn ein Jaeger ihn anstarrt, und versteckt sich neu', () => {
  const { g } = makeGame(22, ['Mensch']);
  const bot = g.addPlayer('bot1', 'Bot Kiwi'); bot.bot = true;
  const brain = new BotBrain(g, 'bot1', seededRng(6));
  startHunt(g);
  const human = g.players.get('p1');
  human.role = C.ROLE_SEEKER; bot.role = C.ROLE_HIDER;
  const run = openRun(g.map, 7);
  place(bot, run.x + 5 * C.TILE, run.y);
  place(human, run.x, run.y);
  g.setPaint('bot1', { fill: [100, 100, 100] }, [100, 100, 100]);
  // Bot sitzt bereits im Versteck (liegend).
  brain.think(DT);
  brain.state = 'hide'; brain.wanderT = 100; brain.wantPose = 3; bot.pose = 3; bot.stillTime = 5;
  let fled = false;
  for (let i = 0; i < 20 * 3 && !fled; i++) {
    const a = aimAt(human, bot);
    input(g, 'p1', {}, null, a.yaw, a.pitch);     // Jaeger starrt, schiesst aber nicht
    brain.think(DT); g.update(DT);
    if (brain.state === 'flee') fled = true;
  }
  assert.ok(fled, 'Bot flieht vor dem starrenden Jaeger');
  const at = { x: bot.x, y: bot.y };
  input(g, 'p1', {}, null, human.yaw + Math.PI, 0);  // Jaeger dreht sich weg
  for (let i = 0; i < 20 * 15; i++) { brain.think(DT); g.update(DT); }
  assert.ok(Math.hypot(bot.x - at.x, bot.y - at.y) > 3 * C.TILE, 'Bot ist weggelaufen');
  assert.ok(['hide', 'pose', 'paint', 'settle'].includes(brain.state), 'Bot versteckt sich neu: ' + brain.state);
});

/** Zwei Bodenpunkte im Abstand n Kacheln mit freier Sicht (Augenhoehe -> Koerpermitte). */
function longSightLine(map, n) {
  for (let ty = 3; ty < C.MAP_H - 3; ty++) {
    for (let tx = 3; tx + n < C.MAP_W - 3; tx++) {
      let ok = true;
      for (let k = 0; k <= n && ok; k++) if (map.tiles[idx(tx + k, ty)] !== C.T_FLOOR) ok = false;
      if (ok) return { a: { x: tx * C.TILE + 16, y: ty * C.TILE + 16 }, b: { x: (tx + n) * C.TILE + 16, y: ty * C.TILE + 16 } };
    }
  }
  return null;
}

test('Jaeger-Bot zielt menschlich: Reaktionszeit, begrenzte Drehung, nicht jeder Schuss sitzt', () => {
  let hits = 0, trials = 0, minFirst = Infinity;
  for (let k = 0; k < 40; k++) {
    const { g } = makeGame(40 + (k % 4), ['Mensch', 'Anna']);
    const line = longSightLine(g.map, 12);
    assert.ok(line, 'freie Sichtlinie gefunden');
    const bot = g.addPlayer('bot1', 'Bot Nova'); bot.bot = true;
    const brain = new BotBrain(g, 'bot1', seededRng(1000 + k));
    startHunt(g);
    const human = g.players.get('p1');
    bot.role = C.ROLE_SEEKER; human.role = C.ROLE_HIDER; g.players.get('p2').role = C.ROLE_HIDER;
    place(g.players.get('p2'), 40, 40);                // abseits; haelt die Runde am Laufen
    place(bot, line.a.x, line.a.y);
    place(human, line.b.x, line.b.y);
    // Bot steht und schaut ungefaehr, aber nicht genau hin
    brain.think(DT);
    brain.yaw = 0.3; brain.openingScan = false;
    brain.state = 'scan'; brain.scanDirs = [0.3]; brain.scanHoldFor = [100]; brain.scanIdx = 0;
    const yaws = [brain.yaw];
    let first = null;
    for (let i = 0; i < 20 * 8 && first === null; i++) {
      human.stillTime = 0;
      brain.think(DT); g.update(DT);
      yaws.push(bot.yaw);
      const shot = g.events.find((e) => e.k === 'shot' && e.id === 'bot1');
      if (shot) first = { t: (i + 1) * DT, hit: shot.hit };
      g.flushEvents();
    }
    if (!first) continue;
    trials++;
    if (first.hit) hits++;
    minFirst = Math.min(minFirst, first.t);
    // Drehung je Takt: Zieltempo plus hoechstens das Zucken beim Abdruecken
    assert.ok(turnStats(yaws).maxStep < TURN_AIM * DT + 0.15, 'Blick springt nicht');
  }
  assert.ok(trials >= 30, 'Bot schiesst ueberhaupt: ' + trials + '/40');
  assert.ok(minFirst >= 0.3, 'nicht schneller als ein Mensch: erster Schuss nach ' + minFirst.toFixed(2) + ' s');
  assert.ok(hits < trials, `nicht jeder erste Schuss auf 12 m trifft (${hits}/${trials})`);
  assert.ok(hits > trials * 0.3, `aber ein guter Teil (${hits}/${trials})`);
});

test('Jaeger-Bot sieht nur, was in seinem Blickfeld liegt, und schaut sich zu Beginn um', () => {
  const { g } = makeGame(22, ['Mensch']);
  const bot = g.addPlayer('bot1', 'Bot Nova'); bot.bot = true;
  const brain = new BotBrain(g, 'bot1', seededRng(8));
  startHunt(g);
  const human = g.players.get('p1');
  bot.role = C.ROLE_SEEKER; human.role = C.ROLE_HIDER;
  const run = openRun(g.map, 7);
  place(bot, run.x, run.y);
  place(human, run.x + 5 * C.TILE, run.y);
  brain.think(DT);                        // Rollenwechsel verarbeiten
  // Direkt hinter dem Bot: waehrend er stur weg schaut, erkennt er nichts.
  brain.yaw = Math.PI; brain.state = 'patrol'; brain.path = null; brain.openingScan = false;
  for (let i = 0; i < 20 * 3; i++) {
    human.stillTime = 0;
    brain.yaw = Math.PI; brain.lookT = 0; brain.perceiveTick(bot, DT);
    assert.notEqual(brain.state, 'chase', 'hinter dem Ruecken nicht erkannt');
  }
  // Umschauen beim Start dreht einmal fast ganz herum.
  const { g: g2 } = makeGame(23, ['Mensch']);
  const b2 = g2.addPlayer('bot1', 'Bot Nova'); b2.bot = true;
  const br2 = new BotBrain(g2, 'bot1', seededRng(9));
  startHunt(g2);
  b2.role = C.ROLE_SEEKER; g2.players.get('p1').role = C.ROLE_HIDER;
  place(g2.players.get('p1'), 40, 40);
  const yaws = [];
  for (let i = 0; i < 20 * 4; i++) { br2.think(DT); g2.update(DT); yaws.push(b2.yaw); }
  const st = turnStats(yaws);
  assert.ok(st.total > Math.PI * 1.2, 'Bot schaut sich um: ' + st.total.toFixed(2));
  assert.ok(st.maxWindow < TURN_SCAN * 1.05 + 0.1, 'in ruhigem Tempo');
});

test('Rundensimulation: kein Bot kreiselt, Jaeger stehen nicht lange herum und fangen', () => {
  let catches = 0;   // Raeume nutzen echten Zufall: Faenge ueber beide Karten zusammen zaehlen
  for (const seed of [9, 3]) {
    const room = new Room('T' + seed, { seed });
    const fakeWs = { readyState: 1, bufferedAmount: 0, send() {} };
    const id = room.join(fakeWs, 'Ich');
    for (let i = 0; i < 6; i++) room.addBot();
    room.game.setReady(id, true);
    const g = room.game;
    let now = 1_000_000, spinning = 0, longestStand = 0;
    // Ereignisse werden in room.step verschickt und geleert: vorher mitzaehlen.
    const flush = g.flushEvents.bind(g);
    g.flushEvents = () => { catches += g.events.filter((e) => e.k === 'catch').length; flush(); };
    const track = new Map();
    for (let i = 0; i < 20 * 360; i++) {
      now += C.TICK_MS; room.step(now);
      for (const [bid, brain] of room.bots) {
        const p = g.players.get(bid);
        let t = track.get(bid);
        if (!t) { t = { yaws: [], ax: p.x, ay: p.y, stand: 0 }; track.set(bid, t); }
        t.yaws.push(p.yaw);
        if (t.yaws.length > 20) t.yaws.shift();
        // Eine volle Umdrehung pro Sekunde schafft auch ein panisch fliehender Bot nicht -
        // der alte Fehler lag bei rund zwei Umdrehungen pro Sekunde, dauerhaft.
        if (t.yaws.length === 20 && turnStats(t.yaws).total > Math.PI * 2) spinning++;
        const active = g.phase === C.PHASE_HUNT && p.alive && p.role === C.ROLE_SEEKER && brain.state !== 'chase';
        if (!active || Math.hypot(p.x - t.ax, p.y - t.ay) > C.TILE) { t.ax = p.x; t.ay = p.y; t.stand = 0; }
        else { t.stand += DT; longestStand = Math.max(longestStand, t.stand); }
      }
    }
    assert.equal(spinning, 0, `Seed ${seed}: kein Kreiseln`);
    assert.ok(longestStand < 8, `Seed ${seed}: Jaeger stehen hoechstens kurz (${longestStand.toFixed(1)} s)`);
  }
  assert.ok(catches >= 1, `Jaeger-Bots fangen jemanden (${catches})`);
});
