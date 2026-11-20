"use strict";

/**
 * POST /api/play as a serverless function (Vercel).
 *
 * The client reads the response body as plain text and treats it as the game
 * server URL, so this proxies the real skribbl.io API exactly like server.js
 * does locally. On Vercel there is no long-running process to host it.
 */

const SKRIBBL_PLAY_API = process.env.SKRIBBL_PLAY_API || "https://skribbl.io/api/play";

function bodyText(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return new URLSearchParams(req.body).toString();
  return "";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(405).send("Method Not Allowed");
    return;
  }

  // 503 makes the client show its "servers are under maintenance" message.
  try {
    const upstream = await fetch(SKRIBBL_PLAY_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyText(req),
      signal: AbortSignal.timeout(8000),
    });
    const url = (await upstream.text()).trim();
    if (!upstream.ok || !/^https?:\/\/[^\s]+$/.test(url)) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.status(503).send("upstream game server unavailable");
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200).send(url);
  } catch {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(503).send("upstream game server unavailable");
  }
};
