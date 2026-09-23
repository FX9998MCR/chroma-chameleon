// Geteilte Spielkonstanten. Server und Browser laden exakt diese Datei,
// damit Vorhersage im Client und Autoritaet im Server nie auseinanderlaufen.

export const PROTOCOL_VERSION = 4;

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

// --- 3D-Welt ---------------------------------------------------------------
// Eine Kachel entspricht einem Meter. Hoehen in Kacheln.
export const WALL_H_INNER = 2.4;         // Innenmauern, blicken nicht drueber
export const WALL_H_EDGE = 3.6;          // Aussenmauer
export const PILLAR_H = 2.6;
export const BUSH_H = 0.9;
export const EYE_H = 1.55;               // Augenhoehe stehender Figur
export const BODY_H = 1.75;              // Koerperhoehe stehend
export const BODY_R = 0.34;              // Trefferradius (Kacheln)
export const VIEW_RADIUS = 1400;         // Server sendet nur, was so nah ist (px)

// --- Malen ---------------------------------------------------------------
export const PAINT_TEX = 512;            // Kantenlaenge der Koerpertextur
export const PAINT_MAX_BYTES = 420_000;  // Obergrenze fuer eine Textur-Nachricht (Base64-PNG)
export const PAINT_MSG_PER_SEC = 4;      // Ratenbegrenzung je Spieler
export const BRUSH_MIN = 3;
export const BRUSH_MAX = 40;
export const BRUSH_DEFAULT = 12;

// --- Posen -----------------------------------------------------------------
// Index -> Name; Details (Gliedmassen) stehen im Client, Trefferhoehe hier.
export const POSES = [
  { id: 'stand',  name: 'Stehen',      h: 1.75 },
  { id: 'crouch', name: 'Hocken',      h: 1.15 },
  { id: 'sit',    name: 'Sitzen',      h: 0.95 },
  { id: 'lie',    name: 'Liegen',      h: 0.35 },
  { id: 'press',  name: 'Wandpresse',  h: 1.75 },
  { id: 'ball',   name: 'Kugel',       h: 0.75 },
];

// --- Koeder (Chamaeleon) ---------------------------------------------------
export const DECOY_COOLDOWN = 24;
export const DECOY_LIFETIME = 22;
export const DECOY_STUN = 1.6;           // Sekunden Betaeubung fuer den Jaeger
export const DECOY_MAX_PER_PLAYER = 1;

// --- Farbmarkierer (Jaeger) ------------------------------------------------
export const SHOT_RANGE = 16;            // Kacheln
export const SHOT_COOLDOWN = 1.0;
export const SHOT_SPREAD = 0.005;        // Radiant, leichte Streuung (0,5 Grad)

// --- Sprint-Dash (Jaeger) --------------------------------------------------
export const DASH_COOLDOWN = 7.0;
export const DASH_SPEED = 430;
export const DASH_TIME = 0.28;

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
