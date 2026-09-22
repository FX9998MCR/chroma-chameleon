// Integrationstest: echter HTTP+WebSocket-Server, echte Clients.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as C from '../shared/constants.js';
import { createServer } from '../server/index.js';

const { server, rooms } = createServer();
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const port = server.address().port;
after(() => new Promise((res) => server.close(res)));

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) { const w = waiters.splice(i, 1)[0]; w.res(m); } else queue.push(m);
  });
  const next = (pred, ms = 3000) => new Promise((res, rej) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return res(queue.splice(i, 1)[0]);
    const w = { pred, res };
    waiters.push(w);
    setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); rej(new Error('Zeitueberschreitung')); } }, ms);
  });
  const send = (o) => ws.send(JSON.stringify(o));
  return new Promise((res) => ws.on('open', () => res({ ws, next, send })));
}

test('Raum erstellen, beitreten, Karte erhalten', async () => {
  const a = await connect();
  a.send({ t: 'join', mode: 'create', name: 'Anna', protocol: C.PROTOCOL_VERSION });
  const wa = await a.next((m) => m.t === 'welcome');
  assert.equal(wa.room.length, C.ROOM_CODE_LEN);
  assert.equal(wa.map.tiles.length, C.MAP_W * C.MAP_H);
  assert.equal(wa.hostId, wa.id);

  const b = await connect();
  b.send({ t: 'join', mode: 'join', room: wa.room.toLowerCase(), name: 'Ben', protocol: C.PROTOCOL_VERSION });
  const wb = await b.next((m) => m.t === 'welcome');
  assert.equal(wb.room, wa.room);
  const lobby = await a.next((m) => m.t === 'lobby' && m.players.length === 2);
  assert.deepEqual(lobby.players.map((p) => p.name).sort(), ['Anna', 'Ben']);

  // Beide bereit -> Vorbereitung beginnt, Snapshots kommen.
  a.send({ t: 'ready', ready: true });
  b.send({ t: 'ready', ready: true });
  const st = await b.next((m) => m.t === 'state' && m.phase === C.PHASE_PREP, 4000);
  assert.ok(st.you.role === C.ROLE_HIDER || st.you.role === C.ROLE_SEEKER);
  assert.ok(st.timeLeft > 0);

  // Chat kommt bei beiden an.
  a.send({ t: 'chat', text: '  hallo <b>welt</b>  ' });
  const chat = await b.next((m) => m.t === 'chat');
  assert.equal(chat.text, 'hallo <b>welt</b>');
  assert.equal(chat.from, 'Anna');

  // Ping/Pong
  a.send({ t: 'ping', ts: 123 });
  const pong = await a.next((m) => m.t === 'pong');
  assert.equal(pong.ts, 123);

  a.ws.close(); b.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rooms.size, 0, 'leerer Raum wird entfernt');
});

test('Bemalung wird weitergereicht, geprueft und Neuankoemmlingen nachgeliefert', async () => {
  const a = await connect();
  a.send({ t: 'join', mode: 'create', name: 'Maler', protocol: C.PROTOCOL_VERSION });
  const wa = await a.next((m) => m.t === 'welcome');
  const b = await connect();
  b.send({ t: 'join', mode: 'join', room: wa.room, name: 'Zuschauer', protocol: C.PROTOCOL_VERSION });
  const wb = await b.next((m) => m.t === 'welcome');

  a.send({ t: 'paint', paint: { fill: [10, 20, 30] }, avg: [10, 20, 30] });
  const p1 = await b.next((m) => m.t === 'paint');
  assert.equal(p1.id, wa.id);
  assert.deepEqual(p1.paint, { fill: [10, 20, 30] });

  const png = 'data:image/png;base64,' + 'iVBORw0KGgo='.repeat(4);
  a.send({ t: 'paint', paint: { png } });
  const p2 = await b.next((m) => m.t === 'paint');
  assert.equal(p2.paint.png, png);

  // Ungueltiges wird verworfen: kein weiteres paint bei b
  a.send({ t: 'paint', paint: { png: 'data:text/html;base64,AAAA' } });
  a.send({ t: 'paint', paint: { fill: [1, 2] } });
  a.send({ t: 'paint', paint: 'x' });
  a.send({ t: 'ping', ts: 42 });
  await a.next((m) => m.t === 'pong' && m.ts === 42);
  await new Promise((r) => setTimeout(r, 80));
  await assert.rejects(b.next((m) => m.t === 'paint', 150), /Zeitueberschreitung/);

  // Dritter kommt spaeter: bekommt den Stand per paintall
  const c = await connect();
  c.send({ t: 'join', mode: 'join', room: wa.room, name: 'Spaet', protocol: C.PROTOCOL_VERSION });
  await c.next((m) => m.t === 'welcome');
  const all = await c.next((m) => m.t === 'paintall');
  assert.deepEqual(all.items, [{ id: wa.id, paint: { png } }]);
  a.ws.close(); b.ws.close(); c.ws.close();
  void wb;
});

test('falsche Protokollversion und unbekannter Raum werden abgewiesen', async () => {
  const a = await connect();
  a.send({ t: 'join', mode: 'create', name: 'X', protocol: -1 });
  const err = await a.next((m) => m.t === 'error');
  assert.equal(err.code, 'version');
  await new Promise((r) => a.ws.on('close', r));

  const b = await connect();
  b.send({ t: 'join', mode: 'join', room: 'ZZZZ', name: 'Y', protocol: C.PROTOCOL_VERSION });
  const e2 = await b.next((m) => m.t === 'error');
  assert.equal(e2.code, 'noroom');
  b.ws.close();
});

test('Schnellspiel fuellt einen oeffentlichen Raum auf', async () => {
  const a = await connect();
  a.send({ t: 'join', mode: 'quick', name: 'Q1', protocol: C.PROTOCOL_VERSION });
  const wa = await a.next((m) => m.t === 'welcome');
  assert.equal(wa.isPublic, true);
  const b = await connect();
  b.send({ t: 'join', mode: 'quick', name: 'Q2', protocol: C.PROTOCOL_VERSION });
  const wb = await b.next((m) => m.t === 'welcome');
  assert.equal(wb.room, wa.room);
  a.ws.close(); b.ws.close();
});

test('doppelte Namen werden eindeutig, Muell-Nachrichten stoeren nicht', async () => {
  const a = await connect();
  a.send({ t: 'join', mode: 'create', name: 'Gleich', protocol: C.PROTOCOL_VERSION });
  const wa = await a.next((m) => m.t === 'welcome');
  const b = await connect();
  b.send({ t: 'join', mode: 'join', room: wa.room, name: 'Gleich', protocol: C.PROTOCOL_VERSION });
  const wb = await b.next((m) => m.t === 'welcome');
  assert.equal(wb.name, 'Gleich 2');
  b.ws.send('kein json');
  b.ws.send(JSON.stringify({ t: 'input', k: 'unsinn', a: 5 }));
  b.ws.send(JSON.stringify(null));
  b.send({ t: 'ping', ts: 1 });
  const pong = await b.next((m) => m.t === 'pong');
  assert.equal(pong.ts, 1);
  a.ws.close(); b.ws.close();
});

test('nur der Host kann die Runde manuell starten', async () => {
  const a = await connect();
  a.send({ t: 'join', mode: 'create', name: 'Host', protocol: C.PROTOCOL_VERSION });
  const wa = await a.next((m) => m.t === 'welcome');
  const b = await connect();
  b.send({ t: 'join', mode: 'join', room: wa.room, name: 'Gast', protocol: C.PROTOCOL_VERSION });
  await b.next((m) => m.t === 'welcome');
  await a.next((m) => m.t === 'lobby' && m.players.length === 2);
  b.send({ t: 'start' });
  await new Promise((r) => setTimeout(r, 150));
  const room = rooms.get(wa.room);
  assert.equal(room.game.phase, C.PHASE_LOBBY, 'Gast darf nicht starten');
  a.send({ t: 'start' });
  const st = await b.next((m) => m.t === 'state' && m.phase === C.PHASE_PREP);
  assert.equal(st.round, 1);
  a.ws.close(); b.ws.close();
});
