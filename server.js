"use strict";

/**
 * Local skribbl game server.
 *
 * Serves the static client (index.html, css/, js/, img/, audio/) and implements
 * the two endpoints the client needs:
 *   POST /api/play  -> the game server URL, proxied from the real skribbl.io API
 *                      (LOCAL_GAME=1 or ?local=1 uses the bundled local engine)
 *   socket.io       -> the room/game protocol described in js/game.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const DEFAULT_WORDS = require("./words");

const PORT = Number(process.env.PORT) || 8080;
// Only public/ is exposed over HTTP, which is also what a static host publishes.
const ROOT = path.join(__dirname, "public");
const SKRIBBL_PLAY_API = process.env.SKRIBBL_PLAY_API || "https://skribbl.io/api/play";

/* ------------------------------------------------------------------ *
 * Protocol constants (mirrors js/game.js)
 * ------------------------------------------------------------------ */

// game phases, sent inside the "state" packet
const PHASE = {
  WAITING: 0,
  STARTING: 1,
  ROUND: 2,
  CHOOSING: 3,
  DRAWING: 4,
  ROUND_END: 5,
  GAME_END: 6,
  LOBBY: 7,
};

// round end reasons
const ROUND_END = {
  ALL_GUESSED: 0,
  TIME_UP: 1,
  DRAWER_LEFT: 2,
  SKIPPED: 5,
};

// leave reasons
const LEAVE = { LEFT: 0, KICK: 1, BAN: 2 };

// server -> client packet ids
const S = {
  JOIN: 1,
  LEAVE: 2,
  VOTEKICK: 5,
  RATE: 8,
  AVATAR: 9,
  ROOM: 10,
  STATE: 11,
  SETTINGS: 12,
  HINTS: 13,
  GUESSED: 15,
  CLOSE: 16,
  OWNER: 17,
  CHAT: 30,
  WARNING: 31,
  NAME: 90,
};

// settings indexes (same order as data-setting attributes in index.html)
const SETTING = { LANG: 0, SLOTS: 1, DRAWTIME: 2, ROUNDS: 3, WORDCOUNT: 4, HINTS: 5, WORDMODE: 6, CUSTOM_ONLY: 7 };
const WORDMODE = { NORMAL: 0, HIDDEN: 1, COMBINATION: 2 };

const CHOOSE_TIME = 15;
const START_DELAY = 3;
const ROUND_INTRO = 3;
const ROUND_END_TIME = 6;
const GAME_END_TIME = 15;

/* ------------------------------------------------------------------ *
 * HTTP server: static files + /api/play
 * ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// only expose the client assets, never server sources or node_modules
const PUBLIC_FILE = /^\/(index\.html|favicon\.png|favicon\.ico)$/;
const PUBLIC_DIR = /^\/(css|js|img|audio)\//;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/play") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    if (req.method !== "POST") {
      res.writeHead(405, { ...corsHeaders(), "Content-Type": "text/plain" });
      return res.end("Method Not Allowed");
    }
    // The client posts id=<room> or lang=<n> and expects the game server URL as
    // plain text. By default it is proxied from skribbl.io so the page joins the
    // real game; pass ?local=1 (or set LOCAL_GAME=1) for the bundled engine.
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on("end", () => {
      const host = req.headers.host || `127.0.0.1:${PORT}`;
      const useLocal = process.env.LOCAL_GAME === "1" || url.searchParams.get("local") === "1";
      if (useLocal) return sendPlayUrl(res, `http://${host}`);
      proxyPlayRequest(body, res);
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    return res.end("Method Not Allowed");
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  if (!PUBLIC_FILE.test(pathname) && !PUBLIC_DIR.test(pathname)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }

  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    res.end(data);
  });
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function sendPlayUrl(res, text) {
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

// A 503 makes the client show its "servers are under maintenance" message, which
// is the honest outcome when the upstream API cannot be reached.
function sendUnavailable(res) {
  res.writeHead(503, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  res.end("upstream game server unavailable");
}

async function proxyPlayRequest(body, res) {
  try {
    const upstream = await fetch(SKRIBBL_PLAY_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const url = (await upstream.text()).trim();
    if (!upstream.ok || !/^https?:\/\/[^\s]+$/.test(url)) return sendUnavailable(res);
    sendPlayUrl(res, url);
  } catch {
    sendUnavailable(res);
  }
}

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 20000,
  pingTimeout: 20000,
});

/* ------------------------------------------------------------------ *
 * Room state
 * ------------------------------------------------------------------ */

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeRoom(code, type) {
  return {
    code,
    type,
    settings: defaultSettings(),
    players: [],
    ownerId: -1,
    round: 0,
    drawnIds: new Set(),
    drawerId: -1,
    word: "",
    words: [],
    wordPool: [],
    hintsGiven: new Set(),
    state: { id: PHASE.LOBBY, time: 0, data: 0 },
    turnStartScores: new Map(),
    phaseTimer: null,
    hintTimer: null,
  };
}

// settings defaults explicit, in case the array literal above ever drifts
function defaultSettings() {
  const s = [];
  s[SETTING.LANG] = 0; // English
  s[SETTING.SLOTS] = 8;
  s[SETTING.DRAWTIME] = 80;
  s[SETTING.ROUNDS] = 3;
  s[SETTING.WORDCOUNT] = 3;
  s[SETTING.HINTS] = 2;
  s[SETTING.WORDMODE] = WORDMODE.NORMAL;
  s[SETTING.CUSTOM_ONLY] = 0;
  return s;
}

let lastPlayerId = 0;

function newRoomCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (rooms.has(code));
  return code;
}

function clearTimers(room) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  if (room.hintTimer) clearInterval(room.hintTimer);
  room.phaseTimer = null;
  room.hintTimer = null;
}

function emitPacket(room, id, data) {
  io.to(room.code).emit("data", { id, data });
}

function setState(room, id, time, data) {
  room.state = { id, time, data };
  emitPacket(room, S.STATE, room.state);
}

function playerList(room) {
  return room.players.map((p) => ({
    id: p.id,
    flags: 0,
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    guessed: p.guessed,
  }));
}

function sendRoomData(socket, room, player) {
  socket.emit("data", {
    id: S.ROOM,
    data: {
      me: player.id,
      type: room.type,
      id: room.code,
      settings: room.settings,
      users: playerList(room),
      round: room.round,
      owner: room.ownerId,
      state: room.state,
    },
  });
}

function socketOf(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return null;
  return io.sockets.sockets.get(player.socketId) || null;
}

function activePlayers(room) {
  return room.players.filter((p) => !p.left);
}

/* ------------------------------------------------------------------ *
 * Game flow
 * ------------------------------------------------------------------ */

function startGame(room, customWordsRaw) {
  const players = activePlayers(room);
  if (players.length < 2) {
    const owner = room.players.find((p) => p.id === room.ownerId);
    if (owner) socketOf(room, owner.id)?.emit("data", { id: S.WARNING, data: { id: 0 } });
    return;
  }

  clearTimers(room);

  room.wordPool = parseCustomWords(customWordsRaw);
  if (room.settings[SETTING.CUSTOM_ONLY] && room.wordPool.length < 10) {
    room.wordPool = [];
  }

  room.round = 0;
  room.drawnIds = new Set();
  room.drawerId = -1;
  room.word = "";
  for (const p of room.players) {
    p.score = 0;
    p.guessed = false;
  }

  // refresh everyone's scores/highlights
  setState(room, PHASE.STARTING, START_DELAY, 0);
  room.phaseTimer = setTimeout(() => beginRound(room), START_DELAY * 1000);
}

function parseCustomWords(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const seen = new Set();
  const out = [];
  for (const piece of raw.split(",")) {
    const word = piece.trim().toLowerCase();
    if (!word || word.length > 32 || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out.length >= 10 ? out : [];
}

function beginRound(room) {
  clearTimers(room);
  if (activePlayers(room).length < 2) return returnToLobby(room);
  if (room.round >= room.settings[SETTING.ROUNDS]) return endGame(room);

  room.round += 1;
  room.drawnIds = new Set();
  for (const p of room.players) p.guessed = false;

  setState(room, PHASE.ROUND, ROUND_INTRO, room.round - 1);
  room.phaseTimer = setTimeout(() => nextTurn(room), ROUND_INTRO * 1000);
}

function nextTurn(room) {
  clearTimers(room);
  const players = activePlayers(room);
  if (players.length < 2) return returnToLobby(room);

  if (room.drawnIds.size >= players.length) return beginRound(room);

  const remaining = players.filter((p) => !room.drawnIds.has(p.id));
  const drawer = remaining[Math.floor(Math.random() * remaining.length)];
  room.drawnIds.add(drawer.id);

  room.drawerId = drawer.id;
  room.word = "";
  room.hintsGiven = new Set();
  for (const p of room.players) p.guessed = false;
  room.turnStartScores = new Map(room.players.map((p) => [p.id, p.score]));

  room.words = pickWords(room, room.settings[SETTING.WORDMODE] === WORDMODE.COMBINATION ? 6 : 3);

  // phase 3: the drawer picks a word, everyone else waits
  room.state = { id: PHASE.CHOOSING, time: CHOOSE_TIME, data: { id: drawer.id } };
  for (const p of room.players) {
    const socket = socketOf(room, p.id);
    if (!socket) continue;
    const data = p.id === drawer.id ? { id: drawer.id, words: room.words } : { id: drawer.id };
    socket.emit("data", { id: S.STATE, data: { id: PHASE.CHOOSING, time: CHOOSE_TIME, data } });
  }

  room.phaseTimer = setTimeout(() => {
    // nobody chose: take the first option
    const fallback = room.words[0];
    if (fallback) beginDrawing(room, fallback);
  }, CHOOSE_TIME * 1000);
}

function pickWords(room, count) {
  const pool = room.wordPool.length >= 10 ? room.wordPool : DEFAULT_WORDS;
  const chosen = [];
  const used = new Set();
  let guard = 0;
  while (chosen.length < count && guard < 500) {
    guard += 1;
    const word = pool[Math.floor(Math.random() * pool.length)];
    if (used.has(word)) continue;
    used.add(word);
    chosen.push(word);
  }
  return chosen;
}

function chooseWord(room, player, payload) {
  if (room.state.id !== PHASE.CHOOSING || player.id !== room.drawerId) return;
  const half = room.words.length / 2;
  let word;
  if (Array.isArray(payload) && room.settings[SETTING.WORDMODE] === WORDMODE.COMBINATION) {
    const first = room.words[Number(payload[0])];
    const second = room.words[Number(payload[1]) + half];
    if (!first || !second) return;
    word = `${first} ${second}`;
  } else {
    const index = Number(payload);
    const candidate = room.words[Number.isInteger(index) && !Array.isArray(payload) ? index : 0];
    if (!candidate) return;
    word = candidate;
  }
  beginDrawing(room, word);
}

function beginDrawing(room, word) {
  clearTimers(room);
  room.word = word;

  const drawTime = Number(room.settings[SETTING.DRAWTIME]) || 80;
  const hidden = room.settings[SETTING.WORDMODE] === WORDMODE.HIDDEN;
  room.drawTimeEndsAt = Date.now() + drawTime * 1000;
  const lengths = word.split(" ").map((part) => part.length);

  room.state = { id: PHASE.DRAWING, time: drawTime, data: { id: room.drawerId } };
  for (const p of room.players) {
    const socket = socketOf(room, p.id);
    if (!socket) continue;
    const data =
      p.id === room.drawerId
        ? { id: room.drawerId, word, hints: [], drawCommands: [] }
        : { id: room.drawerId, word: lengths, hints: [], drawCommands: [] };
    socket.emit("data", { id: S.STATE, data: { id: PHASE.DRAWING, time: drawTime, data } });
  }

  if (!hidden) scheduleHints(room, drawTime);

  room.phaseTimer = setTimeout(() => endRound(room, ROUND_END.TIME_UP), drawTime * 1000);
}

function scheduleHints(room, drawTime) {
  const total = Number(room.settings[SETTING.HINTS]) || 0;
  if (total <= 0) return;

  const positions = [];
  for (let i = 0; i < room.word.length; i++) {
    if (room.word[i] !== " ") positions.push(i);
  }
  const reveal = positions.slice(0, total);
  if (!reveal.length) return;

  const interval = (drawTime * 1000) / (reveal.length + 1);
  let next = 0;
  room.hintTimer = setInterval(() => {
    if (room.state.id !== PHASE.DRAWING || next >= reveal.length) return;
    const index = reveal[next];
    next += 1;
    for (const p of room.players) {
      if (p.id === room.drawerId) continue;
      const socket = socketOf(room, p.id);
      if (socket) socket.emit("data", { id: S.HINTS, data: [[index, room.word[index]]] });
    }
  }, interval);
}

function remainingSeconds(room) {
  if (!room.drawTimeEndsAt) return 0;
  return Math.max(0, Math.round((room.drawTimeEndsAt - Date.now()) / 1000));
}

function endRound(room, reason) {
  clearTimers(room);
  room.drawTimeEndsAt = 0;
  if (room.state.id !== PHASE.DRAWING && room.state.id !== PHASE.CHOOSING) return;

  const guessers = new Set();
  for (const p of room.players) if (p.guessed && p.id !== room.drawerId) guessers.add(p.id);
  const drawer = room.players.find((p) => p.id === room.drawerId);
  if (drawer && reason !== ROUND_END.DRAWER_LEFT) {
    drawer.score += 25 * guessers.size;
  }

  const scores = [];
  for (const p of room.players) {
    const before = room.turnStartScores.get(p.id) ?? p.score;
    scores.push(p.id, p.score, p.score - before);
  }

  room.roundEndData = { word: room.word, reason, scores };
  setState(room, PHASE.ROUND_END, ROUND_END_TIME, room.roundEndData);
  room.phaseTimer = setTimeout(() => nextTurn(room), ROUND_END_TIME * 1000);
}

function endGame(room) {
  clearTimers(room);
  const ranked = activePlayers(room)
    .slice()
    .sort((a, b) => b.score - a.score);
  const data = ranked.map((p, index) => [p.id, index, ""]);
  setState(room, PHASE.GAME_END, GAME_END_TIME, data);
  room.phaseTimer = setTimeout(() => returnToLobby(room), GAME_END_TIME * 1000);
}

function returnToLobby(room) {
  clearTimers(room);
  room.round = 0;
  room.drawerId = -1;
  room.word = "";
  room.words = [];
  room.drawnIds = new Set();
  room.hintsGiven = new Set();
  for (const p of room.players) p.guessed = false;
  setState(room, PHASE.LOBBY, 0, 0);
}

/* ------------------------------------------------------------------ *
 * Chat / guessing
 * ------------------------------------------------------------------ */

function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function isClose(guess, target) {
  if (!guess || !target) return false;
  if (Math.abs(guess.length - target.length) > 1) return false;
  let edits = 0;
  for (let i = 0; i < Math.max(guess.length, target.length); i++) {
    if (guess[i] !== target[i]) edits += 1;
    if (edits > 1) return false;
  }
  return edits === 1;
}

function handleChat(room, player, message) {
  const text = String(message == null ? "" : message).trim().slice(0, 200);
  if (!text) return;

  const drawing = room.state.id === PHASE.DRAWING;
  if (drawing && player.id !== room.drawerId && !player.guessed) {
    const guess = normalize(text);
    const target = normalize(room.word);

    if (guess && guess === target) {
      const left = remainingSeconds(room);
      const points = 50 + left * 2;
      player.guessed = true;
      player.score += points;
      emitPacket(room, S.GUESSED, { id: player.id, word: room.word });
      const everyone = activePlayers(room).every((p) => p.id === room.drawerId || p.guessed);
      if (everyone) setTimeout(() => endRound(room, ROUND_END.ALL_GUESSED), 300);
      return;
    }

    if (isClose(guess, target)) {
      socketOf(room, player.id)?.emit("data", { id: S.CLOSE, data: text });
    }
  }

  emitPacket(room, S.CHAT, { id: player.id, msg: text });
}

/* ------------------------------------------------------------------ *
 * Socket wiring
 * ------------------------------------------------------------------ */

io.on("connection", (socket) => {
  socket.on("login", (payload) => {
    if (socket.data.roomCode || !payload || typeof payload !== "object") return;

    const requested = typeof payload.join === "string" ? payload.join.trim().toUpperCase() : "";
    const create = Number(payload.create) === 1;

    let room = null;
    if (requested) {
      room = rooms.get(requested) || null;
      if (!room) {
        socket.emit("joinerr", 1); // room not found
        return;
      }
    } else if (!create) {
      // play button without a room code: join any open public room
      for (const candidate of rooms.values()) {
        if (candidate.type === 0 && candidate.players.length < Number(candidate.settings[SETTING.SLOTS])) {
          room = candidate;
          break;
        }
      }
    }

    if (!room) {
      const code = newRoomCode();
      room = makeRoom(code, create ? 1 : 0);
      rooms.set(code, room);
    }

    if (room.players.length >= Number(room.settings[SETTING.SLOTS])) {
      socket.emit("joinerr", 2); // room full
      return;
    }

    const name = String(payload.name || "").trim().slice(0, 20) || `Player ${lastPlayerId + 1}`;
    const avatar = Array.isArray(payload.avatar) ? payload.avatar.slice(0, 4).map(Number) : [0, 0, 0, -1];

    lastPlayerId += 1;
    const player = {
      id: lastPlayerId,
      socketId: socket.id,
      name,
      avatar,
      score: 0,
      guessed: false,
      left: false,
    };
    room.players.push(player);

    if (room.ownerId === -1) room.ownerId = player.id;
    if (Number(payload.lang) > 0 && room.players.length === 1) {
      room.settings[SETTING.LANG] = Number(payload.lang);
    }

    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);

    sendRoomData(socket, room, player);
    socket.to(room.code).emit("data", {
      id: S.JOIN,
      data: { id: player.id, flags: 0, name: player.name, avatar: player.avatar, score: 0, guessed: false },
    });

    // a late joiner should still see the current phase
    if (room.state.id === PHASE.DRAWING) {
      const lengths = room.word.split(" ").map((part) => part.length);
      socket.emit("data", {
        id: S.STATE,
        data: { id: PHASE.DRAWING, time: remainingSeconds(room) || room.state.time, data: { id: room.drawerId, word: lengths, hints: [], drawCommands: [] } },
      });
    } else if (room.state.id !== PHASE.LOBBY) {
      socket.emit("data", { id: S.STATE, data: room.state });
    }
  });

  socket.on("data", (packet) => {
    if (!packet || typeof packet.id === "undefined") return;
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.data.playerId);
    if (!player) return;

    switch (Number(packet.id)) {
      case 22: {
        // start game (owner only)
        if (player.id === room.ownerId) startGame(room, packet.data);
        break;
      }
      case 18: {
        chooseWord(room, player, packet.data);
        break;
      }
      case 19: {
        // canvas commands -> relay to the other players
        if (room.state.id !== PHASE.DRAWING || player.id !== room.drawerId) return;
        if (!Array.isArray(packet.data) || packet.data.length > 200) return;
        socket.to(room.code).emit("data", { id: 19, data: packet.data });
        break;
      }
      case 20: {
        if (room.state.id !== PHASE.DRAWING || player.id !== room.drawerId) return;
        socket.to(room.code).emit("data", { id: 20 });
        break;
      }
      case 21: {
        if (room.state.id !== PHASE.DRAWING || player.id !== room.drawerId) return;
        const commands = Math.max(0, Math.min(Number(packet.data) || 0, 100000));
        socket.to(room.code).emit("data", { id: 21, data: commands });
        break;
      }
      case 30: {
        handleChat(room, player, packet.data);
        break;
      }
      case 8: {
        // drawing rating
        if (room.state.id !== PHASE.DRAWING) return;
        emitPacket(room, S.RATE, { id: player.id, vote: packet.data ? 1 : 0 });
        break;
      }
      case 12: {
        // settings change (owner only, lobby only)
        if (player.id !== room.ownerId || room.state.id !== PHASE.LOBBY) return;
        const setting = Number(packet.data && packet.data.id);
        const value = packet.data && packet.data.val;
        if (!Number.isInteger(setting) || setting < 0 || setting > 7) return;
        room.settings[setting] = value;
        emitPacket(room, S.SETTINGS, { id: setting, val: value });
        break;
      }
      case 3:
      case 4: {
        // kick / ban (owner only)
        if (player.id !== room.ownerId) return;
        if (room.state.id !== PHASE.LOBBY) return;
        const target = room.players.find((p) => p.id === Number(packet.data));
        if (!target || target.id === room.ownerId) return;
        removePlayer(room, target, Number(packet.id) === 3 ? LEAVE.KICK : LEAVE.BAN);
        break;
      }
      default:
        // mute (7), report (6), votekick (5) and unhandled packets are ignored
        break;
    }
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.data.playerId);
    if (!player) return;
    removePlayer(room, player, LEAVE.LEFT);
  });
});

function removePlayer(room, player, reason) {
  const wasDrawer = player.id === room.drawerId;
  const index = room.players.indexOf(player);
  if (index === -1) return;
  room.players.splice(index, 1);

  io.to(room.code).emit("data", { id: S.LEAVE, data: { id: player.id, reason } });
  if (reason !== LEAVE.LEFT) io.sockets.sockets.get(player.socketId)?.disconnect(true);

  if (room.players.length === 0) {
    clearTimers(room);
    rooms.delete(room.code);
    return;
  }

  if (room.ownerId === player.id) {
    room.ownerId = room.players[0].id;
    emitPacket(room, S.OWNER, room.ownerId);
  }

  if (wasDrawer && (room.state.id === PHASE.DRAWING || room.state.id === PHASE.CHOOSING)) {
    endRound(room, ROUND_END.DRAWER_LEFT);
  } else if (activePlayers(room).length < 2 && room.state.id !== PHASE.LOBBY) {
    returnToLobby(room);
  }
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`skribbl local server running at http://127.0.0.1:${PORT}`);
});
