"use strict";

/**
 * Protocol check for the local skribbl server: two socket.io clients play one
 * turn, exercising /api/play, room create/join, start, word choice, draw relay
 * and a correct guess.
 *
 * Run with: npm test   (server must be running on PORT)
 */

const { io } = require("socket.io-client");

const PORT = Number(process.env.PORT) || 8080;
const BASE = `http://127.0.0.1:${PORT}`;

const PHASE = { STARTING: 1, ROUND: 2, CHOOSING: 3, DRAWING: 4, ROUND_END: 5 };

let failures = 0;
function check(name, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures += 1;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ["websocket", "polling"], reconnection: false });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

function nextPacket(socket, predicate, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("data", handler);
      reject(new Error("timeout waiting for packet"));
    }, timeout);
    function handler(packet) {
      if (!predicate(packet)) return;
      clearTimeout(timer);
      socket.off("data", handler);
      resolve(packet);
    }
    socket.on("data", handler);
  });
}

(async () => {
  try {
    const index = await fetch(`${BASE}/`);
    check("GET / serves index.html", index.status === 200 && (await index.text()).includes("<title>skribbl"));

    const css = await fetch(`${BASE}/css/style.css`);
    check("GET /css/style.css", css.status === 200);

    const secret = await fetch(`${BASE}/server.js`);
    check("server source is not exposed", secret.status === 404);

    const proxied = await fetch(`${BASE}/api/play`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "lang=0",
    });
    const proxiedUrl = (await proxied.text()).trim();
    check(
      "POST /api/play proxies the real skribbl game server",
      proxied.status === 200 && /^https:\/\/[^\s]+skribbl\.io:\d+$/.test(proxiedUrl),
      proxiedUrl,
    );

    const play = await fetch(`${BASE}/api/play?local=1`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "lang=0",
    });
    const serverUrl = (await play.text()).trim();
    check("POST /api/play?local=1 returns the local engine", serverUrl === BASE, serverUrl);

    const host = await connect(serverUrl);
    host.emit("login", { join: "", create: 1, name: "Host", lang: 0, avatar: [1, 2, 3, -1] });
    const roomPacket = await nextPacket(host, (p) => p.id === 10);
    const code = roomPacket.data.id;
    check("host receives room data", typeof code === "string" && code.length === 4, `room ${code}`);
    check("room starts in lobby", roomPacket.data.state.id === 7);
    check("host is owner", roomPacket.data.owner === roomPacket.data.me);

    const guest = await connect(serverUrl);
    guest.emit("login", { join: code, create: 0, name: "Guest", lang: 0, avatar: [4, 5, 6, -1] });
    const guestRoom = await nextPacket(guest, (p) => p.id === 10);
    check("guest joins by code", guestRoom.data.id === code);
    const joinNotice = await nextPacket(host, (p) => p.id === 1);
    check("host is told about the join", joinNotice.data.name === "Guest");

    // start: STARTING -> ROUND -> CHOOSING
    host.emit("data", { id: 22, data: "" });
    const starting = await nextPacket(guest, (p) => p.id === 11 && p.data.id === PHASE.STARTING);
    check("game start phase", starting.data.id === PHASE.STARTING);

    const [hostPhase, guestPhase] = await Promise.all([
      nextPacket(host, (p) => p.id === 11 && p.data.id === PHASE.CHOOSING, 15000),
      nextPacket(guest, (p) => p.id === 11 && p.data.id === PHASE.CHOOSING, 15000),
    ]);
    const drawer = hostPhase.data.data.words ? host : guest;
    const guesser = drawer === host ? guest : host;
    const drawerId = hostPhase.data.data.id;
    check("one player gets 3 words to choose from", [hostPhase, guestPhase].some((p) => (p.data.data.words || []).length === 3));
    check("the other player only sees who chooses", [hostPhase, guestPhase].some((p) => !p.data.data.words));

    drawer.emit("data", { id: 18, data: 0 });
    const [drawerDraw, guesserDraw] = await Promise.all([
      nextPacket(drawer, (p) => p.id === 11 && p.data.id === PHASE.DRAWING, 10000),
      nextPacket(guesser, (p) => p.id === 11 && p.data.id === PHASE.DRAWING, 10000),
    ]);
    const word = drawerDraw.data.data.word;
    check("drawer receives the word", typeof word === "string" && word.length > 0, word);
    check("guesser only receives word lengths", Array.isArray(guesserDraw.data.data.word), JSON.stringify(guesserDraw.data.data.word));
    check("drawer id is broadcast", drawerDraw.data.data.id === drawerId);

    // drawing relay
    const relay = nextPacket(guesser, (p) => p.id === 19);
    drawer.emit("data", { id: 19, data: [[0, 0, 10, 10, 10, 10]] });
    const relayed = await relay;
    check("draw commands are relayed", Array.isArray(relayed.data) && relayed.data.length === 1);

    // wrong guess stays chat, correct guess scores
    const chat = nextPacket(guesser, (p) => p.id === 30);
    guesser.emit("data", { id: 30, data: "definitely not the word" });
    check("wrong guess is broadcast as chat", (await chat).data.msg === "definitely not the word");

    const guessed = nextPacket(host, (p) => p.id === 15);
    guesser.emit("data", { id: 30, data: word.toUpperCase() });
    const guessedPacket = await guessed;
    check("correct guess is announced with the word", guessedPacket.data.word === word);

    const roundEnd = await nextPacket(host, (p) => p.id === 11 && p.data.id === PHASE.ROUND_END, 10000);
    check("round ends after everyone guessed", roundEnd.data.data.reason === 0);
    check("round end carries the word", roundEnd.data.data.word === word);
    check(
      "scores are sent as [id, total, gained] triplets",
      Array.isArray(roundEnd.data.data.scores) && roundEnd.data.data.scores.length % 3 === 0,
    );

    host.close();
    guest.close();
  } catch (error) {
    failures += 1;
    console.error("FAIL ", error.message);
  }

  console.log(failures === 0 ? "\nall protocol checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
