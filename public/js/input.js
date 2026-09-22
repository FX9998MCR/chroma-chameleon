// Tastatur und Maus. Spielmodus: Pointer-Lock, Maus dreht die Kamera.
// Malmodus: Cursor frei, linke Taste malt, rechte Taste dreht die Kamera.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Input {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.keys = { up: false, down: false, left: false, right: false, sprint: false, paint: false };
    this.actions = { primary: false, decoy: false, dash: false, pose: false };
    this.look = { yaw: 0, pitch: -0.25 };
    this.sensitivity = 0.0022;
    this.mouse = { x: 0, y: 0, left: false, right: false, dx: 0, dy: 0 };
    this.enabled = true;
    this.paintMode = false;
    this.locked = false;
    this.onKey = null;          // (event, down) => false unterdrueckt Spielverarbeitung
    this.onTogglePaint = null;  // F
    this.onEyedrop = null;      // Leertaste im Malmodus
    this.onWheel = null;        // Mausrad im Malmodus
    this.wantLock = false;

    const isTyping = () => {
      const el = document.activeElement;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    };

    window.addEventListener('keydown', (e) => {
      if (this.onKey && this.onKey(e, true) === false) return;
      if (isTyping()) return;
      if (!this.enabled) return;
      if (e.repeat && e.code !== 'Space') return;
      if (this.set(e.code, true)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      if (this.onKey && this.onKey(e, false) === false) return;
      if (isTyping()) return;
      if (this.set(e.code, false)) e.preventDefault();
    });
    window.addEventListener('blur', () => this.reset());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvasEl;
      if (!this.locked) this.reset();
    });
    document.addEventListener('pointerlockerror', () => { this.locked = false; });

    canvasEl.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      if (this.locked && !this.paintMode) {
        this.look.yaw += e.movementX * this.sensitivity;
        this.look.pitch = clamp(this.look.pitch - e.movementY * this.sensitivity, -1.25, 0.95);
      } else if (this.paintMode && this.mouse.right) {
        this.mouse.dx += e.movementX;
        this.mouse.dy += e.movementY;
      }
    });
    canvasEl.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (isTyping()) document.activeElement.blur();
      if (e.button === 0) {
        this.mouse.left = true;
        if (!this.paintMode) {
          // Ohne Pointer-Lock erst die Maus fangen; der Klick zaehlt trotzdem als Schuss,
          // damit das Spiel auch dort funktioniert, wo der Lock verweigert wird.
          if (!this.locked && this.wantLock) this.requestLock();
          this.actions.primary = true;
        }
      }
      if (e.button === 2) this.mouse.right = true;
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());
    canvasEl.addEventListener('wheel', (e) => {
      if (this.paintMode && this.onWheel) { this.onWheel(Math.sign(e.deltaY)); e.preventDefault(); }
    }, { passive: false });
  }

  requestLock() {
    try { this.canvas.requestPointerLock?.({ unadjustedMovement: true })?.catch?.(() => this.canvas.requestPointerLock()); }
    catch { try { this.canvas.requestPointerLock(); } catch { /* nicht verfuegbar */ } }
  }

  releaseLock() {
    if (document.pointerLockElement) { try { document.exitPointerLock(); } catch { /* egal */ } }
  }

  setPaintMode(on) {
    this.paintMode = on;
    this.keys.paint = on;
    if (on) this.releaseLock();
    else if (this.wantLock) this.requestLock();
    this.mouse.left = false; this.mouse.right = false;
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
      case 'KeyF': if (down && this.onTogglePaint) this.onTogglePaint(); return true;
      case 'KeyR': if (down) this.actions.pose = true; return true;
      case 'KeyQ': if (down) this.actions.decoy = true; return true;
      case 'Space': if (down && this.paintMode && this.onEyedrop) this.onEyedrop(); return true;
      default: return false;
    }
  }

  /** Liefert die aufgelaufenen Aktionen und setzt sie zurueck. */
  takeActions() {
    const a = { ...this.actions };
    for (const k of Object.keys(this.actions)) this.actions[k] = false;
    return a;
  }

  /** Kameradrehung im Malmodus (rechte Maustaste) abholen. */
  takeDrag() {
    const d = { dx: this.mouse.dx, dy: this.mouse.dy };
    this.mouse.dx = 0; this.mouse.dy = 0;
    return d;
  }

  reset() {
    for (const k of Object.keys(this.keys)) if (k !== 'paint') this.keys[k] = false;
    for (const k of Object.keys(this.actions)) this.actions[k] = false;
    this.mouse.left = false; this.mouse.right = false;
  }
}
