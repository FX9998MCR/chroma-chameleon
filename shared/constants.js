// Geteilte Spielkonstanten. Server und Browser laden exakt diese Datei,
// damit Vorhersage im Client und Autoritaet im Server nie auseinanderlaufen.

export const PROTOCOL_VERSION = 3;

// --- Takt und Welt ---------------------------------------------------------
export const TICK_RATE = 20;                 // Server-Simulationen pro Sekunde
export const TICK_MS = 1000 / TICK_RATE;
export const TILE = 32;                      // Kantenlaenge einer Kachel in Pixeln
export const MAP_W = 64;                     // Kacheln waagerecht
export const MAP_H = 44;                     // Kacheln senkrecht
export const WORLD_W = MAP_W * TILE;
export const WORLD_H = MAP_H * TILE;

// --- Kacheltypen -----------------------------------------------------------
export const T_FLOOR = 0;   // begehbar, traegt eine Zonenfarbe
export const T_WALL = 1;    // blockiert Bewegung und Sicht-Freigabe
export const T_BUSH = 2;    // begehbar, zusaetzliche Deckung, bremst leicht
export const T_WATER = 3;   // begehbar, bremst stark, verraet durch Wellen
export const T_PILLAR = 4;  // blockiert, dient als Anker fuer den Zungenhaken

export const SOLID_TILES = new Set([T_WALL, T_PILLAR]);

// --- Farbpalette der Zonen -------------------------------------------------
// Jede Bodenkachel zeigt eine dieser Farben. Chamaeleons koennen sie aufnehmen.
export const PALETTE = [
  [ 92, 128,  86],  // 0 Moosgruen
  [176, 154,  96],  // 1 Sandgelb
  [ 78, 106, 140],  // 2 Schiefergrau-Blau
  [150,  84,  92],  // 3 Ziegelrot
  [110,  92, 138],  // 4 Amethyst
  [ 84, 142, 138],  // 5 Tuerkis
  [188, 120,  70],  // 6 Kupfer
  [ 70,  84,  96],  // 7 Basalt
];

export const BUSH_COLOR  = [ 54,  92,  58];
export const WATER_COLOR = [ 58, 104, 132];
export const WALL_COLOR  = [ 44,  48,  58];

// --- Bewegung --------------------------------------------------------------
export const PLAYER_RADIUS = 11;
export const HIDER_SPEED = 152;      // px/s Grundtempo Chamaeleon
export const HIDER_SPRINT = 246;     // px/s mit Ausdauer
export const SEEKER_SPEED = 172;     // px/s Jaeger - schneller als Gehen, langsamer als Sprint
export const ACCEL = 1400;           // px/s^2 Beschleunigung
export const FRICTION = 1500;        // px/s^2 Bremsen ohne Eingabe
export const BUSH_SLOW = 0.78;       // Tempofaktor im Gebuesch
export const WATER_SLOW = 0.58;      // Tempofaktor im Wasser

export const STAMINA_MAX = 100;
export const STAMINA_DRAIN = 30;     // pro Sekunde beim Sprinten
export const STAMINA_REGEN = 19;     // pro Sekunde in Ruhe
export const STAMINA_REGEN_DELAY = 0.7; // Sekunden nach Sprintende
export const STAMINA_SPRINT_MIN = 12;   // Mindestausdauer zum Losspurten

// --- Tarnung ---------------------------------------------------------------
// Sichtbarkeit 0 = perfekt getarnt, 1 = voll sichtbar.
export const CAMO_COLOR_WEIGHT = 0.55;   // Anteil Farbuebereinstimmung
export const CAMO_STILL_WEIGHT = 0.45;   // Anteil Bewegungslosigkeit
export const CAMO_STILL_RAMP = 0.9;      // Sekunden Stillstand bis volle Wirkung
export const CAMO_BUSH_BONUS = 0.14;     // Zusatzdeckung im Gebuesch
export const CAMO_WATER_MALUS = 0.20;    // Wellen verraten
export const CAMO_MAX_CONCEAL = 0.985;   // nie absolut unsichtbar
export const CAMO_SHIMMER_TIME = 1.1;    // Sekunden sichtbares Flimmern nach Farbaufnahme
export const CAMO_SHIMMER_FLOOR = 0.55;  // Mindestsichtbarkeit waehrend des Flimmerns

export const REVEAL_RADIUS = 96;         // ab hier sieht der Jaeger Umrisse
export const REVEAL_HARD_RADIUS = 46;    // ab hier immer voll sichtbar
export const VIEW_RADIUS = 900;          // Server sendet nur, was so nah ist
export const SEND_ALPHA_MIN = 0.05;      // darunter wird gar nicht gesendet (Cheat-Schutz)

// --- Farbaufnahme ----------------------------------------------------------
export const ABSORB_TIME = 0.75;         // Sekunden Halten bis Farbwechsel
export const ABSORB_MOVE_TOLERANCE = 42; // px/s, darueber bricht die Aufnahme ab

// --- Zungenhaken (Chamaeleon) ---------------------------------------------
export const GRAPPLE_RANGE = 288;
export const GRAPPLE_PULL_SPEED = 540;
export const GRAPPLE_COOLDOWN = 6.0;
export const GRAPPLE_RELEASE_DIST = 34;  // so nah am Anker loest der Haken
export const GRAPPLE_MAX_TIME = 1.6;     // Notbremse, falls der Zug haengt

// --- Koeder (Chamaeleon) ---------------------------------------------------
export const DECOY_COOLDOWN = 24;
export const DECOY_LIFETIME = 22;
export const DECOY_STUN = 1.6;           // Sekunden Betaeubung fuer den Jaeger
export const DECOY_MAX_PER_PLAYER = 1;

// --- Puls-Scan (Jaeger) ----------------------------------------------------
export const SCAN_COOLDOWN = 9.0;
export const SCAN_RADIUS = 330;
export const SCAN_SPEED = 620;           // px/s Ausbreitung der Welle
export const SCAN_MOTION_WINDOW = 1.6;   // Sekunden: so lange zaehlt Bewegung als frisch
export const SCAN_MOTION_THRESHOLD = 26; // px/s, darueber gilt man als bewegt
export const SCAN_MARK_TIME = 2.2;       // Sekunden Markierung nach Treffer

// --- Sprint-Dash (Jaeger) --------------------------------------------------
export const DASH_COOLDOWN = 7.0;
export const DASH_SPEED = 430;
export const DASH_TIME = 0.28;

// --- Fangen ----------------------------------------------------------------
export const CATCH_RANGE = 62;
export const CATCH_ARC = Math.PI * 0.55;  // Oeffnungswinkel des Zungenschlags
export const CATCH_COOLDOWN = 1.15;
export const CATCH_WINDUP = 0.0;

// --- Farbspuren ------------------------------------------------------------
export const SPLAT_INTERVAL = 0.24;      // Sekunden zwischen Klecksen beim Sprint
export const SPLAT_LIFETIME = 9;
export const SPLAT_MAX = 160;

// --- Rundenablauf ----------------------------------------------------------
export const PHASE_LOBBY = 'lobby';
export const PHASE_PREP = 'prep';
export const PHASE_HUNT = 'hunt';
export const PHASE_OVER = 'over';

export const PREP_SECONDS = 15;
export const HUNT_SECONDS = 150;
export const OVER_SECONDS = 8;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 24;
export const SEEKER_RATIO = 4;           // ein Jaeger je angefangene vier Spieler
export const RESPAWN_SECONDS = 3;        // Wartezeit nach dem Gefangenwerden

// --- Punkte ----------------------------------------------------------------
export const PTS_SURVIVE_PER_SEC = 1;    // Chamaeleon je ueberlebter Sekunde
export const PTS_SURVIVE_ROUND = 120;    // Bonus fuer das Ueberleben der Runde
export const PTS_CATCH = 90;             // Jaeger je Fang
export const PTS_LAST_ONE = 80;          // Bonus fuer das letzte lebende Chamaeleon
export const PTS_DECOY_HIT = 45;         // Chamaeleon, wenn ein Koeder trifft

// --- Rollen ----------------------------------------------------------------
export const ROLE_HIDER = 'hider';
export const ROLE_SEEKER = 'seeker';

// --- Netz ------------------------------------------------------------------
export const INPUT_RATE = 30;            // Client-Eingaben pro Sekunde
export const INTERP_DELAY_MS = 110;      // Puffer fuer weiche Interpolation
export const NAME_MAX = 16;
export const CHAT_MAX = 140;
export const ROOM_CODE_LEN = 4;
export const AFK_TIMEOUT_MS = 90_000;    // ohne Eingabe fliegt man aus dem Raum
