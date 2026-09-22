// DOM-Anzeige: Rollenbanner, Uhr, Balken, Faehigkeiten, Meldungen, Tafeln, Chat.

import * as C from '/shared/constants.js';

const $ = (id) => document.getElementById(id);

const ABILITIES = {
  [C.ROLE_HIDER]: [
    { key: 'RMT', icon: '🪝', name: 'Haken', cd: 'grapple', max: C.GRAPPLE_COOLDOWN },
    { key: 'Q', icon: '🎭', name: 'Köder', cd: 'decoy', max: C.DECOY_COOLDOWN },
    { key: 'E', icon: '🎨', name: 'Farbe', progress: 'absorb' },
    { key: '⇧', icon: '💨', name: 'Sprint', stamina: true },
  ],
  [C.ROLE_SEEKER]: [
    { key: 'LMT', icon: '👅', name: 'Schlag', cd: 'catch', max: C.CATCH_COOLDOWN },
    { key: '␣', icon: '📡', name: 'Scan', cd: 'scan', max: C.SCAN_COOLDOWN },
    { key: '⇧', icon: '⚡', name: 'Dash', cd: 'dash', max: C.DASH_COOLDOWN },
  ],
};

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), role: $('role-banner'), timer: $('timer'), counter: $('counter'), center: $('hud-center'),
      stamina: $('stamina'), camo: $('camo'), camoBar: $('camo-bar'), abilities: $('abilities'), score: $('score'),
      feed: $('feed'), blind: $('prep-blind'), blindCount: $('blind-count'), caught: $('caught'), caughtCount: $('caught-count'),
      scoreboard: $('scoreboard'), roundend: $('roundend'), roundendTitle: $('roundend-title'), roundendSub: $('roundend-sub'),
      roundendCount: $('roundend-count'), chatLog: $('chat-log'), chatInput: $('chat-input'), netinfo: $('netinfo'),
    };
    this.abilityRole = null;
    this.abilityEls = [];
    this.centerTimer = null;
    this.lastLobby = null;
    this.meId = null;
  }

  show(on) { this.el.hud.hidden = !on; }

  buildAbilities(role) {
    if (this.abilityRole === role) return;
    this.abilityRole = role;
    this.el.abilities.innerHTML = '';
    this.abilityEls = [];
    for (const a of ABILITIES[role] ?? []) {
      const d = document.createElement('div');
      d.className = 'ab';
      d.innerHTML = `<span class="key">${a.key}</span><span class="icon">${a.icon}</span><span>${a.name}</span><div class="cd"></div>`;
      this.el.abilities.appendChild(d);
      this.abilityEls.push({ def: a, el: d, cd: d.querySelector('.cd') });
    }
    this.el.camoBar.style.display = role === C.ROLE_HIDER ? '' : 'none';
  }

  /** Jeden Frame: Zustand des eigenen Spielers und der Runde. */
  update(st, me, rtt) {
    if (!st || !me) return;
    const role = me.role;
    this.el.role.textContent = role === C.ROLE_SEEKER ? 'Jäger' : 'Chamäleon';
    this.el.role.className = role;
    this.buildAbilities(role);

    const t = Math.ceil(st.timeLeft);
    const m = Math.floor(t / 60), s = t % 60;
    this.el.timer.textContent = st.phase === C.PHASE_LOBBY ? 'Lobby' : `${m}:${String(s).padStart(2, '0')}`;
    this.el.timer.classList.toggle('warn', st.phase === C.PHASE_HUNT && t <= 20);

    if (st.phase === C.PHASE_LOBBY) this.el.counter.textContent = 'Warten auf Spielstart';
    else if (st.phase === C.PHASE_PREP) this.el.counter.textContent = `Runde ${st.round} · Verstecken`;
    else this.el.counter.textContent = `Runde ${st.round} · ${st.hidersLeft}/${st.hidersTotal} Chamäleons frei · ${st.seekers} Jäger`;

    this.el.stamina.style.width = `${me.stamina}%`;
    if (role === C.ROLE_HIDER) this.el.camo.style.width = `${Math.round((1 - me.vis) * 100)}%`;
    this.el.score.textContent = String(me.score + (me.roundScore ?? 0));

    for (const a of this.abilityEls) {
      const d = a.def;
      let frac = 0, active = false;
      if (d.cd) { frac = Math.min(1, (me.cd[d.cd] ?? 0) / d.max); }
      if (d.progress) { frac = 1 - (me[d.progress] ?? 0); active = (me[d.progress] ?? 0) > 0; }
      if (d.stamina) { frac = 1 - me.stamina / C.STAMINA_MAX; active = !!me.sprint; }
      a.cd.style.height = `${Math.round(frac * 100)}%`;
      a.el.classList.toggle('ready', frac <= 0.001 && !d.stamina);
      a.el.classList.toggle('active', active);
    }

    // Jaeger: Augen zu in der Vorbereitung
    const blind = role === C.ROLE_SEEKER && st.phase === C.PHASE_PREP && me.alive;
    this.el.blind.hidden = !blind;
    if (blind) this.el.blindCount.textContent = String(t);

    const caught = !me.alive;
    this.el.caught.hidden = !caught;
    if (caught) this.el.caughtCount.textContent = String(Math.ceil(me.respawn));

    if (st.phase === C.PHASE_OVER) this.el.roundendCount.textContent = String(t);
    else this.el.roundend.hidden = true;

    this.el.netinfo.textContent = `${rtt} ms · ${st.tick}`;
  }

  showCenter(html, ms = 2500) {
    this.el.center.innerHTML = html;
    clearTimeout(this.centerTimer);
    this.centerTimer = setTimeout(() => { this.el.center.innerHTML = ''; }, ms);
  }

  feed(text, cls = '') {
    const d = document.createElement('div');
    d.className = `feed-item ${cls}`;
    d.textContent = text;
    this.el.feed.appendChild(d);
    while (this.el.feed.children.length > 6) this.el.feed.firstChild.remove();
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .6s'; setTimeout(() => d.remove(), 600); }, 5000);
  }

  chat(from, text, sys = false) {
    const d = document.createElement('div');
    if (sys) { d.className = 'sys'; d.textContent = text; }
    else { const b = document.createElement('b'); b.textContent = from + ': '; d.appendChild(b); d.appendChild(document.createTextNode(text)); }
    this.el.chatLog.appendChild(d);
    while (this.el.chatLog.children.length > 8) this.el.chatLog.firstChild.remove();
    setTimeout(() => { d.style.opacity = '0.35'; }, 12000);
  }

  fillTable(tbody, rows, meId) {
    tbody.innerHTML = '';
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (r.id === meId) tr.className = 'me';
      const roleTxt = r.role === C.ROLE_SEEKER ? 'Jäger' : 'Chamäleon';
      const cells = [String(i + 1), r.name, roleTxt, String(r.round ?? r.roundScore ?? 0), String(r.total ?? r.score ?? 0)];
      cells.forEach((c, k) => {
        const td = document.createElement('td');
        td.textContent = c;
        if (k === 2) td.className = r.role === C.ROLE_SEEKER ? 'r-seeker' : 'r-hider';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  scoreboard(show) {
    this.el.scoreboard.hidden = !show;
    if (show && this.lastLobby) this.fillTable(this.el.scoreboard.querySelector('tbody'), this.lastLobby.players, this.meId);
  }

  roundEnd(ev, myRole) {
    const hidersWon = ev.winner === C.ROLE_HIDER;
    this.el.roundendTitle.textContent = hidersWon ? 'Die Chamäleons entkommen!' : 'Die Jäger haben alle erwischt!';
    this.el.roundendTitle.className = ev.winner;
    const iWon = myRole === ev.winner;
    this.el.roundendSub.textContent = (iWon ? 'Sieg! ' : 'Niederlage. ') + (ev.survivors.length ? `Überlebt: ${ev.survivors.join(', ')}` : 'Niemand hat überlebt.');
    this.fillTable(this.el.roundend.querySelector('tbody'), ev.scores, this.meId);
    this.el.roundend.hidden = false;
    return iWon;
  }
}
