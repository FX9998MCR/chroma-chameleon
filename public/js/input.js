// Tastatur- und Maus-Eingabe. Aktionen sind Flanken (einmal pro Druck),
// Bewegung ist Zustand (gedrueckt halten).

export class Input {
  constructor(canvasEl) {
    this.keys = { up: false, down: false, left: false, right: false, sprint: false, absorb: false };
    this.actions = { primary: false, decoy: false, grapple: false, scan: false, dash: false };
    this.mouse = { x: 0, y: 0, down: false };
    this.aim = 0;
    this.enabled = true;
    this.onKey = null;        // Callback fuer UI-Tasten (Tab, Enter, Escape)

    const isTyping = () => {
      const el = document.activeElement;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    };

    window.addEventListener('keydown', (e) => {
      if (this.onKey && this.onKey(e, true) === false) return;
      if (isTyping()) return;
      if (!this.enabled) return;
      if (this.set(e.code, true)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      if (this.onKey && this.onKey(e, false) === false) return;
      if (isTyping()) return;
      if (this.set(e.code, false)) e.preventDefault();
    });
    window.addEventListener('blur', () => this.reset());

    canvasEl.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    canvasEl.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (isTyping()) document.activeElement.blur();
      if (e.button === 0) { this.actions.primary = true; this.mouse.down = true; }
      if (e.button === 2) this.actions.grapple = true;
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.down = false; });
    canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());
    // Touch: einfache Steuerung ueber Bildschirmhaelften ist fuer dieses Spiel
    // nicht praezise genug - Desktop mit Maus und Tastatur ist Zielplattform.
  }

  set(code, down) {
    switch (code) {
      case 'KeyW': case 'ArrowUp': this.keys.up = down; return true;
      case 'KeyS': case 'ArrowDown': this.keys.down = down; return true;
      case 'KeyA': case 'ArrowLeft': this.keys.left = down; return true;
      case 'KeyD': case 'ArrowRight': this.keys.right = down; return true;
      case 'ShiftLeft': case 'ShiftRight':
        this.keys.sprint = down;
        if (down) this.actions.dash = true;
        return true;
      case 'KeyE': this.keys.absorb = down; return true;
      case 'KeyQ': if (down) this.actions.decoy = true; return true;
      case 'KeyF': if (down) this.actions.grapple = true; return true;
      case 'Space': if (down) this.actions.scan = true; return true;
      default: return false;
    }
  }

  /** Liefert die aufgelaufenen Aktionen und setzt sie zurueck. */
  takeActions() {
    const a = { ...this.actions };
    for (const k of Object.keys(this.actions)) this.actions[k] = false;
    return a;
  }

  reset() {
    for (const k of Object.keys(this.keys)) this.keys[k] = false;
    for (const k of Object.keys(this.actions)) this.actions[k] = false;
    this.mouse.down = false;
  }
}
