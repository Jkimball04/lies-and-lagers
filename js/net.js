// How the host's laptop and the players' phones talk to each other.
//
// "peer" (normal): the host's browser registers the room with the free PeerJS
//   matchmaking service; phones find it by room code and then connect directly.
// "local" (testing): every page is a tab in the same browser, talking over a
//   BroadcastChannel. Used to test the game without real phones.
//
// The TV window always talks to the host window over a BroadcastChannel,
// because both are on the same laptop.

import { uid } from "./common.js";

const peerIdFor = room => "lieslagers-" + room.toLowerCase();

export function hostNet(room, mode, h) {
  return mode === "local" ? localHost(room, h) : peerHost(room, h);
}

export function clientNet(room, mode, h) {
  return mode === "local" ? localClient(room, h) : peerClient(room, h);
}

export function tvChannel(room) {
  return new BroadcastChannel("ll-tv-" + room);
}

// ---------------------------------------------------------------- PeerJS: host side

function peerHost(room, h) {
  const conns = new Map();
  let peer = null, closed = false, retry = null;
  const status = s => h.onStatus && h.onStatus(s);

  function start() {
    if (closed) return;
    status("starting");
    peer = new window.Peer(peerIdFor(room), { debug: 1 });
    peer.on("open", () => status("online"));
    peer.on("connection", conn => {
      conn.on("open", () => { conns.set(conn.connectionId, conn); h.onConnect(conn.connectionId); });
      conn.on("data", d => h.onMessage(conn.connectionId, d));
      const gone = () => { if (conns.delete(conn.connectionId)) h.onDisconnect(conn.connectionId); };
      conn.on("close", gone);
      conn.on("error", gone);
    });
    peer.on("disconnected", () => {
      // Lost the matchmaking server; existing players stay connected. Re-register so new ones can join.
      status("reconnecting");
      setTimeout(() => { if (!closed && peer && !peer.destroyed) peer.reconnect(); }, 2000);
    });
    peer.on("error", err => {
      if (err.type === "unavailable-id") {
        // The room code is still held from a moment ago (e.g. the host page was reloaded). Try again shortly.
        status("waiting-for-code");
        restart(3000);
      } else if (peer && peer.destroyed) {
        status("reconnecting");
        restart(3000);
      } else if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) {
        status("reconnecting");
      } else {
        console.warn("PeerJS:", err.type, err);
      }
    });
  }

  function restart(ms) {
    clearTimeout(retry);
    retry = setTimeout(() => { try { peer && peer.destroy(); } catch { /* ignore */ } start(); }, ms);
  }

  start();
  return {
    send(cid, msg) { const c = conns.get(cid); if (c && c.open) { try { c.send(msg); } catch { /* ignore */ } } },
    drop(cid) { const c = conns.get(cid); if (c) { conns.delete(cid); try { c.close(); } catch { /* ignore */ } } },
    close() { closed = true; clearTimeout(retry); try { peer && peer.destroy(); } catch { /* ignore */ } },
  };
}

// ---------------------------------------------------------------- PeerJS: phone side

function peerClient(room, h) {
  let peer = null, conn = null, closed = false, timer = null, delay = 1000, lastSeen = 0;
  const status = s => h.onStatus && h.onStatus(s);

  function ensurePeer() {
    if (peer && !peer.destroyed) {
      if (peer.disconnected) peer.reconnect();
      else if (peer.open) connect();
      return;
    }
    peer = new window.Peer({ debug: 1 });
    peer.on("open", () => connect());
    peer.on("error", err => {
      status(err.type === "peer-unavailable" ? "no-host" : "reconnecting");
      schedule();
    });
    peer.on("disconnected", () => {
      if (!closed) setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1000);
    });
  }

  function connect() {
    if (closed) return;
    if (!peer || peer.destroyed || !peer.open) { ensurePeer(); return; }
    if (conn) { const old = conn; conn = null; try { old.close(); } catch { /* ignore */ } }
    status("connecting");
    const c = peer.connect(peerIdFor(room), { reliable: true });
    conn = c;
    const giveUp = setTimeout(() => {
      if (c === conn && !c.open) { conn = null; try { c.close(); } catch { /* ignore */ } schedule(); }
    }, 9000);
    c.on("open", () => {
      clearTimeout(giveUp);
      if (c !== conn) return;
      delay = 1000;
      lastSeen = Date.now();
      status("online");
      h.onOpen();
    });
    c.on("data", d => { if (c === conn) { lastSeen = Date.now(); h.onMessage(d); } });
    const lost = () => {
      if (c !== conn) return;
      conn = null;
      status("reconnecting");
      h.onClose && h.onClose();
      schedule();
    };
    c.on("close", lost);
    c.on("error", lost);
  }

  function schedule() {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 1.6, 8000);
  }

  // The host pings every few seconds; if it goes quiet (phone was asleep), reconnect.
  setInterval(() => {
    if (conn && conn.open && Date.now() - lastSeen > 13000) {
      const c = conn; conn = null;
      try { c.close(); } catch { /* ignore */ }
      status("reconnecting");
      h.onClose && h.onClose();
      schedule();
    }
  }, 3000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !(conn && conn.open)) { delay = 500; schedule(); }
  });

  ensurePeer();
  return {
    send(msg) { if (conn && conn.open) { try { conn.send(msg); return true; } catch { /* ignore */ } } return false; },
    close() { closed = true; clearTimeout(timer); try { peer && peer.destroy(); } catch { /* ignore */ } },
    get connected() { return !!(conn && conn.open); },
  };
}

// ---------------------------------------------------------------- Test mode: same-browser tabs

function localHost(room, h) {
  const bc = new BroadcastChannel("ll-net-" + room);
  const clients = new Set();
  bc.onmessage = e => {
    const m = e.data || {};
    if (m.k === "connect") {
      clients.add(m.cid);
      bc.postMessage({ k: "accept", to: m.cid });
      h.onConnect(m.cid);
    } else if (m.k === "msg" && m.to === "host" && clients.has(m.from)) {
      h.onMessage(m.from, m.msg);
    } else if (m.k === "bye" && clients.delete(m.cid)) {
      h.onDisconnect(m.cid);
    }
  };
  bc.postMessage({ k: "host-up" });
  setTimeout(() => h.onStatus && h.onStatus("online"), 0);
  return {
    send(cid, msg) { if (clients.has(cid)) bc.postMessage({ k: "msg", to: cid, msg }); },
    drop(cid) { if (clients.delete(cid)) bc.postMessage({ k: "msg", to: cid, msg: { t: "dropped" } }); },
    close() { bc.close(); },
  };
}

function localClient(room, h) {
  const bc = new BroadcastChannel("ll-net-" + room);
  let cid = null, open = false, lastSeen = 0, closed = false;
  const status = s => h.onStatus && h.onStatus(s);
  const connect = () => {
    if (closed) return;
    cid = uid();
    open = false;
    status("connecting");
    bc.postMessage({ k: "connect", cid });
  };
  bc.onmessage = e => {
    const m = e.data || {};
    if (m.k === "accept" && m.to === cid) {
      open = true; lastSeen = Date.now(); status("online"); h.onOpen();
    } else if (m.k === "msg" && m.to === cid) {
      lastSeen = Date.now();
      if (m.msg && m.msg.t === "dropped") { open = false; return; }
      h.onMessage(m.msg);
    } else if (m.k === "host-up") {
      connect();
    }
  };
  setInterval(() => {
    if (closed) return;
    if (open && Date.now() - lastSeen > 13000) { open = false; status("reconnecting"); h.onClose && h.onClose(); }
    if (!open) connect();
  }, 4000);
  addEventListener("pagehide", () => { if (cid) bc.postMessage({ k: "bye", cid }); });
  connect();
  return {
    send(msg) { if (open) { bc.postMessage({ k: "msg", from: cid, to: "host", msg }); return true; } return false; },
    close() { closed = true; if (cid) bc.postMessage({ k: "bye", cid }); bc.close(); },
    get connected() { return open; },
  };
}
