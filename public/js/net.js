// WebSocket-Verbindung zum Spielserver.
// Kleine Ereignisschnittstelle: on('state', fn), on('lobby', fn) usw.

import { PROTOCOL_VERSION } from '/shared/constants.js';

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.connected = false;
    this.rtt = 0;
    this.serverOffset = 0;     // geschaetzte Differenz Serveruhr - Clientuhr
    this._pingTimer = null;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, data) {
    const list = this.handlers.get(type);
    if (list) for (const fn of list) fn(data);
  }

  /** Verbindet und schickt sofort den Beitrittswunsch. */
  connect(join) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.send({ t: 'join', protocol: PROTOCOL_VERSION, ...join });
      this._pingTimer = setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 2000);
      this.emit('open');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'pong') {
        const now = performance.now();
        this.rtt = Math.round(now - msg.ts);
        // Serverzeit ~ Clientzeit + offset (halbe Laufzeit herausgerechnet)
        this.serverOffset = msg.st - (Date.now() - this.rtt / 2);
        return;
      }
      this.emit(msg.t, msg);
    };
    ws.onclose = (ev) => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this.emit('close', { code: ev.code, reason: ev.reason });
    };
    ws.onerror = () => { /* onclose folgt */ };
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(obj));
  }

  close() {
    clearInterval(this._pingTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* egal */ } }
    this.ws = null;
    this.connected = false;
  }
}
