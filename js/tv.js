// The TV screen. It only shows what every player is allowed to see, and gets
// everything from the host window on the same laptop.

import { esc, param, keepAwake, pictureHTML, qrSVG, listNames, shortUrl, rulesHTML } from "./common.js";
import { tvChannel } from "./net.js";

const room = (param("room") || "").toUpperCase();
const app = document.getElementById("tv");
const fs = document.getElementById("fs");
let view = null, lastView = 0;

if (!room) {
  app.innerHTML = `<div class="tvbody col"><p class="tvsub">Open the TV screen from the host's laptop (the “Open TV screen” button).</p></div>`;
} else {
  const ch = tvChannel(room);
  ch.onmessage = e => {
    if (e.data && e.data.k === "view") { view = e.data.view; lastView = Date.now(); render(); }
  };
  const hello = () => ch.postMessage({ k: "hello" });
  hello();
  setInterval(() => {
    if (Date.now() - lastView > 9000) hello();
    if (view && Date.now() - lastView > 25000) lost();
  }, 3000);
}

keepAwake();
fs.addEventListener("click", () => { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); });
document.addEventListener("fullscreenchange", () => fs.classList.toggle("hide", !!document.fullscreenElement));
document.addEventListener("dblclick", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
});

function lost() {
  app.innerHTML = `<div class="tvbody col"><div class="tvbig">Lost the host's window</div>
    <p class="tvsub">Is the host page still open on the laptop?</p></div>`;
}

const brand = `<div class="tvbrand">Lies <span>&amp;</span> Lagers</div>`;
const roundOf = (n, v) => `Round ${n}${v.total ? ` of ${v.total}` : ""}`;
const top = (v, mid = "") => `<div class="tvtop">${brand}${mid}<div class="tvround">${v.round ? roundOf(v.round, v) : ""}</div></div>`;
const catChip = v => (v.category ? `<div class="tvcat">${esc(v.category.name)}</div>` : "");

function render() {
  const v = view;
  if (!v) return;
  const fn = { lobby, rules, pick: between, writing, reading, voting, novotes, reveal, scores, final: scores }[v.phase];
  app.innerHTML = fn ? fn(v) : "";
}

const playerChips = v => v.players.map(p => `<span class="tvchip here ${p.connected ? "" : "off"}">${esc(p.name)}</span>`).join("");

function lobby(v) {
  const chips = playerChips(v);
  return `<div class="tvbody"><div class="tvlobby">
      <div class="tvqr">${qrSVG(v.joinUrl)}</div>
      <div class="tvjoin"><h1>Lies <span>&amp;</span> Lagers</h1>
        <p>Scan the code with your phone's camera, or go to</p>
        <p><b>${esc(shortUrl(v.joinUrl))}</b></p>
        <p>and enter the room code</p>
        <div class="code">${esc(v.room)}</div></div></div></div>
    <div class="tvfoot">${chips || `<p class="tvsub">Waiting for players…</p>`}</div>`;
}

// Before round 1: how to play, with a small code in the corner for anyone who turns up late.
function rules(v) {
  return `${top(v)}<div class="tvbody col tvrulesbody"><div class="tvrules-title">How to play</div>
      ${rulesHTML("tvrules")}
      <p class="tvsub"><b>${v.total || 13} rounds</b> · most points wins</p></div>
    <div class="tvfoot"><div class="tvwait"><div class="tvqr mini">${qrSVG(v.joinUrl)}</div>
      <p class="tvsub">Just got here? Scan to join: room <b>${esc(v.room)}</b></p></div></div>`;
}

// Between rounds: the scoreboard (or, before round 1, who's playing) while the host picks a prompt.
function between(v) {
  const middle = v.round ? board(v.scores) : `<div class="tvchips">${playerChips(v)}</div>`;
  return `${top(v)}<div class="tvbody col"><div class="tvbig">${roundOf(v.round + 1, v)} coming up…</div>${middle}</div>
    <div class="tvfoot"><div class="tvwait"><div class="tvqr small">${qrSVG(v.joinUrl)}</div>
      <p class="tvsub">New players can join now: room <b>${esc(v.room)}</b></p></div></div>`;
}

// size: "" (big), "withq" (big, leaving room for the question above it) or "small"
function promptBlock(v, size = "") {
  if (v.prompt.image) return `<div class="tvpic ${size}">${pictureHTML(v.prompt.image)}</div>`;
  return `<div class="tvprompt ${size === "small" ? "small" : ""}">${esc(v.prompt.display)}</div>`;
}

// Picture questions: the question sits above the picture (word prompts already show it as their text).
function questionAbove(v) {
  const q = v.prompt.question;
  return q && q !== v.prompt.display ? `<div class="tvq">${esc(q)}</div>` : "";
}

function writing(v) {
  const chips = v.done.map(p => `<span class="tvchip ${p.done ? "done" : ""}">${p.done ? "✓ " : ""}${esc(p.name)}</span>`).join("");
  const q = questionAbove(v);
  return `${top(v, catChip(v))}<div class="tvbody col">${q}${promptBlock(v, q ? "withq" : "")}</div><div class="tvfoot">${chips}</div>`;
}

function reading(v) {
  const n = v.reading.count, i = v.reading.index;
  const tiles = Array.from({ length: n }, (_, k) =>
    `<div class="tvtile ${k < i ? "read" : ""} ${k === i ? "now" : ""}">${k + 1}</div>`).join("");
  return `${top(v, catChip(v))}<div class="tvbody col">${questionAbove(v)}${promptBlock(v, "small")}<div class="tvtiles">${tiles}</div>
    <p class="tvsub">Listen to the host 👂 and remember the one you think is true</p></div>`;
}

function voting(v) {
  const done = v.voting.filter(p => p.voted).length;
  const chips = v.voting.map(p => `<span class="tvchip ${p.voted ? "done" : ""}">${p.voted ? "✓ " : ""}${esc(p.name)}</span>`).join("");
  return `${top(v, catChip(v))}<div class="tvbody col">${questionAbove(v)}${promptBlock(v, "small")}
    <div class="tvbig">Which one is true?</div><p class="tvsub">Type your vote on your phone · ${done} of ${v.voting.length} in</p></div>
    <div class="tvfoot">${chips}</div>`;
}

// After the votes: whose fakes fooled nobody. The true answer is never listed, so nothing is given away.
function novotes(v) {
  const list = v.novotes || [];
  const q = v.prompt.question || v.prompt.display;
  const body = list.length
    ? `<div class="tvbig">Nobody fell for…</div>
       <div class="tvflops ${list.length <= 2 ? "few" : list.length > 6 ? "many" : ""}">${list.map(a => `<div class="tvflop"><span class="n">${a.n}</span>
         <span class="who">${esc(a.author)}</span><span class="t">“${esc(a.text)}”</span></div>`).join("")}</div>`
    : `<div class="tvbig">Every fake fooled somebody! 🎉</div>`;
  return `${top(v, catChip(v))}<div class="tvbody col">${q ? `<div class="tvq small">${esc(q)}</div>` : ""}${body}</div>`;
}

function reveal(v) {
  const R = v.reveal;
  const left = R.image
    ? `<div><div class="tvpic">${pictureHTML(R.image, { covered: false })}</div>
        <p class="tvcredit">Picture: ${esc(R.image.credit || "unknown")}${R.image.license ? " · " + esc(R.image.license) : ""} · via Wikipedia</p></div>`
    : `<div class="tvprompt small">${esc(v.prompt.display)}</div>`;
  // Shrink everything a little when there are lots of answers, so they all fit on the screen.
  const n = R.answers.length;
  const k = n <= 5 ? 1 : n <= 7 ? 0.88 : n <= 9 ? 0.76 : n <= 12 ? 0.64 : 0.56;
  const rows = R.answers.map(a => {
    const tags = a.pickers.map(name => `<span class="tvvote">${esc(name)}</span>`).join("");
    const votes = a.pickers.length ? `<span class="lbl">${a.isTrue ? "found by" : "fooled"}</span>${tags}`
      : `<span class="lbl">${a.isTrue ? "nobody found it" : "fooled nobody"}</span>`;
    return `<li class="${a.isTrue ? "true" : ""}"><span class="n">${a.n}</span>
      <span class="t">${esc(a.text)}</span>
      <span class="m"><span class="by">${a.isTrue ? `<b class="true">★ The true answer</b>` : `by <b>${esc(a.author)}</b>`}</span>
        <span class="votes">${votes}</span></span></li>`;
  }).join("");
  const extra = R.correctWriters.length ? `<p class="tvsub">${esc(listNames(R.correctWriters))} wrote the true answer! +1</p>` : "";
  const pts = R.points.length ? `<p class="tvsub">${R.points.map(p => `${esc(p.name)} +${p.n}`).join(" · ")}</p>` : "";
  return `${top(v, catChip(v))}<div class="tvbody"><div class="tvreveal">${left}
    <div style="--k:${k}"><ol class="tvans">${rows}</ol><div class="tvrevfoot">${extra}${pts}</div></div></div></div>`;
}

function board(list) {
  return `<ol class="tvboard">${(list || []).map((s, i) => `<li><span>${i + 1}. ${esc(s.name)}</span><b>${s.score}</b></li>`).join("")}</ol>`;
}

function scores(v) {
  const final = v.phase === "final";
  const top3 = v.scores && v.scores[0];
  return `${top(v)}<div class="tvbody col"><div class="tvbig">${final ? (top3 ? `🏆 ${esc(top3.name)} wins!` : "Game over") : "Scores"}</div>${board(v.scores)}</div>`;
}
