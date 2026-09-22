import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/constants.js';
import { generateMap, idx } from '../shared/map.js';
import { Room } from '../server/room.js';
import { bfs, pathTo, BotBrain } from '../server/bots.js';
import { makeGame, DT, startHunt, openSpot, openRun, place } from './helpers.js';

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
