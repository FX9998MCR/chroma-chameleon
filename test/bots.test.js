import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/constants.js';
import { generateMap, idx } from '../shared/map.js';
import { Room } from '../server/room.js';
import { bfs, pathTo, BotBrain } from '../server/bots.js';
import { makeGame, seconds, DT } from './helpers.js';

test('BFS findet Wege und meidet Waende', () => {
  const map = generateMap(5);
  const s = map.spawns[0], t = map.spawns[5];
  const search = bfs(map, Math.floor(s.x / C.TILE), Math.floor(s.y / C.TILE));
  const path = pathTo(search, idx(Math.floor(t.x / C.TILE), Math.floor(t.y / C.TILE)));
  assert.ok(path && path.length > 2);
  for (const w of path) assert.ok(!C.SOLID_TILES.has(map.tiles[idx(Math.floor(w.x / C.TILE), Math.floor(w.y / C.TILE))]));
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    assert.equal(d, C.TILE, 'Schritte sind Nachbarkacheln');
  }
});

test('Raum: Bots hinzufuegen/entfernen, zaehlen zur Kapazitaet, immer bereit', () => {
  const room = new Room('TEST', { seed: 3 });
  const fakeWs = { readyState: 1, bufferedAmount: 0, send() {} };
  const id = room.join(fakeWs, 'Mensch');
  assert.ok(room.addBot());
  assert.ok(room.addBot());
  assert.equal(room.total, 3);
  assert.equal(room.game.players.size, 3);
  const sb = room.game.scoreboard();
  assert.equal(sb.filter((r) => r.bot).length, 2);
  assert.ok(sb.filter((r) => r.bot).every((r) => r.ready));
  assert.equal(room.game.allReady(), false, 'Mensch noch nicht bereit');
  room.game.setReady(id, true);
  assert.equal(room.game.allReady(), true);
  assert.ok(room.removeBot());
  assert.equal(room.total, 2);
  // Nur Bots -> kein automatischer Start
  room.leave(id);
  assert.equal(room.game.allReady(), false);
});

test('Bots allein starten keine Runde; Mensch + Bot startet', () => {
  const room = new Room('T2', { seed: 4 });
  room.addBot(); room.addBot();
  room.game.update(DT);
  assert.equal(room.game.phase, C.PHASE_LOBBY);
  const fakeWs = { readyState: 1, bufferedAmount: 0, send() {} };
  const id = room.join(fakeWs, 'Ich');
  room.game.setReady(id, true);
  room.game.update(DT);
  assert.equal(room.game.phase, C.PHASE_PREP);
});

test('Chamaeleon-Bot sucht ein Versteck, faerbt sich und haelt still', async () => {
  const { g } = makeGame(21, ['Mensch']);
  const bot = g.addPlayer('bot1', 'Bot Kiwi'); bot.bot = true;
  const brain = new BotBrain(g, 'bot1', () => 0.5);
  g.startRound();
  // Der Mensch soll Jaeger sein, damit der Bot versteckt.
  const human = g.players.get('p1');
  if (human.role !== C.ROLE_SEEKER) { human.role = C.ROLE_SEEKER; bot.role = C.ROLE_HIDER; bot.seekerRounds = 0; }
  const start = { x: bot.x, y: bot.y };
  for (let i = 0; i < 20 * 14; i++) { brain.think(DT); g.update(DT); }
  assert.ok(Math.hypot(bot.x - start.x, bot.y - start.y) > 60, 'Bot hat sich bewegt');
  const { baseVisibility } = await import('../shared/physics.js');
  assert.ok(baseVisibility(g.map, bot) < 0.25, 'Bot ist gut getarnt: ' + baseVisibility(g.map, bot));
  assert.ok(bot.stillTime > 0.5, 'Bot steht still');
});

test('Jaeger-Bot verfolgt und faengt ein sichtbares Chamaeleon', async () => {
  const { g } = makeGame(22, ['Mensch']);
  const bot = g.addPlayer('bot1', 'Bot Nova'); bot.bot = true;
  const brain = new BotBrain(g, 'bot1', () => 0.5);
  g.startRound();
  const human = g.players.get('p1');
  bot.role = C.ROLE_SEEKER; human.role = C.ROLE_HIDER;
  g.phaseTime = 0.01; g.update(DT);
  assert.equal(g.phase, C.PHASE_HUNT);
  // Mensch steht sichtbar (falsche Farbe, in Bewegung gehalten) 150px vom Bot.
  human.color = [255, 255, 255];
  bot.x = g.seekerSpawn.x; bot.y = g.seekerSpawn.y;
  // Freie Kachel in der Naehe finden
  const { bfs } = await import('../server/bots.js');
  const s = bfs(g.map, Math.floor(bot.x / C.TILE), Math.floor(bot.y / C.TILE));
  let ti = -1;
  for (let i = 0; i < s.dist.length; i++) if (s.dist[i] === 4 && g.map.tiles[i] === C.T_FLOOR) { ti = i; break; }
  assert.ok(ti >= 0);
  human.x = (ti % C.MAP_W) * C.TILE + 16; human.y = Math.floor(ti / C.MAP_W) * C.TILE + 16;
  human.stillTime = 0; human.lastMoveT = 0;
  let caught = false;
  for (let i = 0; i < 20 * 12 && !caught; i++) {
    human.stillTime = 0;   // Mensch "zappelt" - bleibt sichtbar
    brain.think(DT); g.update(DT);
    if (!human.alive) caught = true;
  }
  assert.ok(caught, 'Bot hat gefangen');
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
  const sb = room.game.scoreboard();
  assert.ok(sb.some((r) => r.bot && r.score > 0), 'Bots sammeln Punkte');
});
