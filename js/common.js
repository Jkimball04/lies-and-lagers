// Shared helpers for the host, TV and phone pages.

// Room codes use consonants only, so they can't spell words and are easy to read off a TV.
export const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";

export function makeRoomCode() {
  const a = new Uint32Array(4);
  crypto.getRandomValues(a);
  return Array.from(a, n => CODE_LETTERS[n % CODE_LETTERS.length]).join("");
}

export function uid(len = 10) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, n => chars[n % chars.length]).join("");
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Everything a player types goes through esc() before it touches the page.
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const param = name => new URLSearchParams(location.search).get(name);

// "local" is a test mode: every page is a tab in the same browser and they talk directly.
export const netMode = () => (param("net") === "local" ? "local" : "peer");

export function pageUrl(page, params = {}) {
  const u = new URL(page, location.href);
  u.search = "";
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, v);
  return u.href;
}

export function joinUrl(room) {
  return pageUrl("index.html", { room, net: netMode() === "local" ? "local" : null });
}

export function shortUrl(url) {
  const u = new URL(url);
  return u.host + u.pathname;
}

export const storage = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Per-tab memory (survives a page reload in the same tab, so a phone that reloads rejoins as itself).
export const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

// Keep the screen from going to sleep (where the browser allows it).
export async function keepAwake() {
  if (!("wakeLock" in navigator)) return;
  const ask = async () => { try { await navigator.wakeLock.request("screen"); } catch { /* not allowed yet */ } };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") ask(); });
  await ask();
}

export function coversHTML(covers = [], editing = false) {
  return covers.map((c, i) =>
    `<span class="cover" data-i="${i}" style="left:${c.x * 100}%;top:${c.y * 100}%;width:${c.w * 100}%;height:${c.h * 100}%">` +
    (editing ? `<button class="cover-x" data-act="cover-x" data-i="${i}" title="Remove this cover">×</button>` : "") +
    `</span>`).join("");
}

export function pictureHTML(image, { covered = true, editing = false, cls = "" } = {}) {
  if (!image || !image.url) return "";
  return `<div class="pic ${cls}"><div class="pic-frame${editing ? " editing" : ""}">` +
    `<img src="${esc(image.url)}" alt="" draggable="false">` +
    `${covered ? coversHTML(image.covers || [], editing) : ""}</div></div>`;
}

export function qrSVG(text) {
  if (!window.qrcode) return "";
  const q = window.qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export const FRIENDS = { id: "friends", name: "Friends & Family", type: "text", question: "" };

export async function loadDeck() {
  const r = await fetch("deck/sample-deck.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("couldn't load the prompt deck");
  return r.json();
}

export function listNames(names) {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

export const cleanName = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 16);

export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
