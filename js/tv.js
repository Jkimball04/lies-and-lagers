// The TV screen. It only shows what every player is allowed to see, and gets
// everything from the host window on the same laptop.

import { esc, param, keepAwake, pictureHTML, qrSVG, listNames, shortUrl, rulesHTML, logoHTML, markerHTML } from "./common.js";
import { tvChannel } from "./net.js";

const room = (param("room") || "").toUpperCase();
const app = document.getElementById("tv");
const fs = document.getElementById("fs");
let view = null, lastView = 0;

if (!room) {
  app.innerHTML = `<div class="tvbody col"><div class="tvh md">No room yet</div>
    <p class="tvsub">Open the TV screen from the host's laptop (the “Open TV screen” button).</p></div>`;
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
  app.innerHTML = `<div class="tvbody col"><div class="tvh md">Lost the host's window</div>
    <p class="tvsub">Is the host page still open on the laptop?</p></div>`;
}

// ---------------------------------------------------------------- shared pieces

const pad = n => String(n).padStart(2, "0");
const total = v => v.total || 13;
const top = (v, mid = "") => `<div class="tvtop">${logoHTML()}${mid || "<span></span>"}
  <div class="tvround">${v.round ? `<span>Round</span><b>${v.round}</b><i>/${total(v)}</i>` : ""}</div></div>`;
const caseTab = v => (v.category ? `<div class="tvcase"><span>Case file</span><b>${esc(v.category.name)}</b></div>` : "");
const tape = text => `<div class="caution ${text.cls || ""}">${esc(text.words.repeat(10))}</div>`;
const crowd = v => (v.players.length > 12 ? "lots" : v.players.length > 8 ? "many" : "");
const placard = (p, i) => `<div class="placard ${p.connected ? "" : "off"}"><span class="no">No. ${pad(i + 1)}</span><b>${esc(p.name)}</b></div>`;
const joinFoot = (v, words) => `<div class="tvfoot"><div class="tvwait"><div class="qrmini">${qrSVG(v.joinUrl)}</div>
  <p class="tvsub">${words} · room <b>${esc(v.room)}</b></p></div></div>`;

function render() {
  const v = view;
  if (!v) return;
  const fn = { lobby, rules, pick: between, writing, reading, voting, novotes, reveal, scores, final }[v.phase];
  app.innerHTML = fn ? fn(v) : "";
}

// ---------------------------------------------------------------- before the game

// The lobby: the ransom-note logo, how to join, and everyone who's in, lined up for a mugshot.
function lobby(v) {
  const heights = `<div class="heights">${["5′0″", "5′6″", "6′0″", "6′6″"].map((h, i) =>
    `<span style="bottom:calc(${i + 1} * 4.2vh + 3px)">${h}</span>`).join("")}</div>`;
  const people = v.players.map(placard).join("");
  return `<div class="tvbody"><div class="tvlobby">
      <div>${logoHTML("stack")}
        <p class="tagline">the game of believable lies</p>
        <p class="joinline">Join at <b>${esc(shortUrl(v.joinUrl))}</b></p>
        <div class="codeline"><span class="lab">Room<br>code</span>
          <div class="code">${[...v.room].map(c => `<span class="ch">${esc(c)}</span>`).join("")}</div></div></div>
      <div class="qrcard taped">${qrSVG(v.joinUrl)}<p>Scan to join</p></div></div></div>
    <div class="lineup ${crowd(v)}">${tape({ words: "Lies & Lagers  •  Suspects only beyond this point  •  " })}${heights}
      ${people || `<p class="empty">Waiting for suspects…</p>`}</div>`;
}

// How to play: five case cards, pinned up in a crooked row.
function rules(v) {
  return `${top(v)}<div class="tvbody col tvrulesbody"><div class="tvh xl">How to play<span class="scribble">it's easy</span></div>
      ${rulesHTML("steps5")}
      <p class="tvsub"><span class="hl">${total(v)} rounds</span>&ensp;Most points wins</p></div>
    ${joinFoot(v, "Just got here? Scan to join")}`;
}

// The rap sheet: the standings, on a typed-up police record. Long lists shrink or go to two columns.
function rapSheet(list, head) {
  const all = list || [];
  const two = all.length > 8;
  const rows = two ? Math.ceil(all.length / 2) : all.length;
  const k = rows <= 4 ? 1 : rows <= 6 ? 0.82 : 0.68;
  return `<div class="rapsheet ${two ? "two" : ""}" style="--k:${k}"><div class="head"><span>Rap sheet</span><span>${esc(head)}</span></div>
    <ol>${all.map((s, i) => `<li><span class="rk">${i + 1}</span><span class="nm">${esc(s.name)}</span><span class="sc">${s.score}</span></li>`).join("")}</ol></div>`;
}

// Between rounds: what's next, plus the standings (or, before round 1, who's playing).
function between(v) {
  const middle = v.round ? rapSheet(v.scores, `After round ${v.round}`)
    : `<div class="placards ${crowd(v)}">${v.players.map(placard).join("")}</div>`;
  return `${top(v)}<div class="tvbody col"><div class="kicker">${v.round ? "Next case" : "First case"}</div>
      <div class="tvh lg">Round ${v.round + 1}<em> of ${total(v)}</em><span class="scribble">coming up…</span></div>${middle}</div>
    ${joinFoot(v, "New suspects can join now")}`;
}

// ---------------------------------------------------------------- the round

// size: "" (big), "withq" (big, leaving room for the question above it) or "small"
function promptBlock(v, size = "") {
  if (v.prompt.image) return `<div class="tvpic ${size}">${pictureHTML(v.prompt.image)}</div>`;
  return `<div class="tvprompt ${size === "small" ? "small" : ""}"><span class="exhibit">Exhibit A</span>${esc(v.prompt.display)}</div>`;
}

// Picture questions: the question sits above the picture (word prompts already show it on their card).
function questionAbove(v) {
  const q = v.prompt.question;
  return q && q !== v.prompt.display ? `<div class="tvq">${esc(q)}</div>` : "";
}

const doneTags = list => list.map(p => `<span class="tvchip ${p.done ? "done" : ""}">${p.done ? "✓ " : ""}${esc(p.name)}</span>`).join("");

function writing(v) {
  const q = questionAbove(v);
  return `${top(v, caseTab(v))}<div class="tvbody col">${q}${promptBlock(v, q ? "withq" : "")}</div>
    <div class="tvfoot">${doneTags(v.done)}</div>`;
}

// Reading: one evidence marker per answer; the one being read sits up front with a scribbled "this one".
function reading(v) {
  const n = v.reading.count, i = v.reading.index;
  const marks = Array.from({ length: n }, (_, k) => `<div class="mkwrap ${k === i ? "now" : ""}"><span class="scribble">this one</span>${markerHTML(k + 1, k <= i ? "" : "dim")}</div>`).join("");
  return `${top(v, caseTab(v))}<div class="tvbody col">${questionAbove(v)}${promptBlock(v, "small")}
    <div class="tvmarkers ${n > 12 ? "lots" : n > 8 ? "many" : ""}">${marks}</div>
    <p class="tvsub"><b>Listen up.</b> Remember the number of the one you think is true.</p></div>`;
}

// Voting: the numbers to tap on your phone, and who has voted.
function voting(v) {
  const done = v.voting.filter(p => p.voted).length;
  const n = v.choices || 0;
  const marks = Array.from({ length: n }, (_, k) => markerHTML(k + 1)).join("");
  return `${top(v, caseTab(v))}<div class="tvbody col">${questionAbove(v)}${promptBlock(v, "small")}
    <div class="tvmarkers vote ${n > 12 ? "lots" : n > 8 ? "many" : ""}">${marks}</div>
    <div class="tvh md">Which one's the truth?</div>
    <p class="tvsub">Tap its number on your phone · <b>${done} of ${v.voting.length}</b> in</p></div>
    <div class="tvfoot">${doneTags(v.voting.map(p => ({ name: p.name, done: p.voted })))}</div>`;
}

// After the votes: whose fakes fooled nobody. The true answer is never listed, so nothing is given away.
function novotes(v) {
  const list = v.novotes || [];
  const q = v.prompt.question || v.prompt.display;
  const body = list.length
    ? `<div class="tvh lg">Nobody fell for…</div>
       <div class="flops ${list.length <= 2 ? "few" : list.length > 6 ? "many" : ""}">${list.map(a => `<div class="flop">${markerHTML(a.n)}
         <span class="who">${esc(a.author)}</span><span class="t">“${esc(a.text)}”</span><span class="stamp">Not buying it</span></div>`).join("")}</div>`
    : `<div class="tvh xl">Every fake fooled<br><em>somebody.</em></div><p class="tvsub"><span class="scribble">sneaky.</span></p>`;
  return `${top(v, caseTab(v))}<div class="tvbody col">${q ? `<div class="tvq small">${esc(q)}</div>` : ""}${body}</div>`;
}

// The verdict: every statement, who made it up, who fell for it, and the truth stamped TRUE.
function reveal(v) {
  const R = v.reveal;
  const left = R.image
    ? `<div><div class="tvpic">${pictureHTML(R.image, { covered: false })}</div>
        <p class="tvcredit">Picture: ${esc(R.image.credit || "unknown")}${R.image.license ? " · " + esc(R.image.license) : ""} · via Wikipedia</p></div>`
    : `<div class="tvprompt small"><span class="exhibit">Exhibit A</span>${esc(v.prompt.display)}</div>`;
  // Shrink everything a little when there are lots of answers, so they all fit on the screen.
  const n = R.answers.length;
  const k = n <= 5 ? 1 : n <= 7 ? 0.88 : n <= 9 ? 0.76 : n <= 12 ? 0.64 : 0.56;
  const rows = R.answers.map(a => {
    const tags = a.pickers.map(name => `<span class="tvvote">${esc(name)}</span>`).join("");
    const votes = a.pickers.length ? `<span class="lbl">${a.isTrue ? "Found by" : "Fooled"}</span>${tags}`
      : `<span class="lbl">${a.isTrue ? "Nobody found it" : "Fooled nobody"}</span>`;
    const by = a.isTrue ? "" : `<span class="by"><span class="lbl lie">Lie by</span><b>${esc(a.author)}</b></span>`;
    return `<li class="${a.isTrue ? "true" : ""}">${markerHTML(a.n)}<div><span class="t">${esc(a.text)}</span>
      <div class="m">${by}${votes}</div></div>${a.isTrue ? `<span class="stamp green">True</span>` : ""}</li>`;
  }).join("");
  const extra = R.correctWriters.length ? `<p class="tvsub">${esc(listNames(R.correctWriters))} wrote the true answer! +1</p>` : "";
  const pts = R.points.map(p => `<span class="ptsticker"><b>+${p.n}</b>${esc(p.name)}</span>`).join("");
  return `${top(v, caseTab(v))}<div class="tvbody"><div class="tvreveal">${left}
    <div style="--k:${k}"><ol class="verdict">${rows}</ol><div class="tvrevfoot">${extra}${pts}</div></div></div></div>`;
}

// ---------------------------------------------------------------- scores and the end

function scores(v) {
  return `${top(v)}<div class="tvbody col"><div class="kicker">After round ${v.round} of ${total(v)}</div>
    <div class="tvh lg">The rap sheet</div>${rapSheet(v.scores, "Standings")}</div>`;
}

function final(v) {
  const list = v.scores || [];
  const champ = list[0];
  if (!champ) return `${top(v)}<div class="tvbody col"><div class="tvh xl">Game over</div></div>`;
  return `${top(v)}<div class="tvbody"><div class="final">
      <div class="wanted taped"><div class="w1">Wanted</div><div class="w2">For crimes against the truth</div>
        <div class="w3">${esc(champ.name)}</div><div class="w4">${champ.score} point${champ.score === 1 ? "" : "s"}</div>
        <div class="w5">Reward: bragging rights</div><span class="stamp">Winner</span></div>
      ${rapSheet(list, "Final standings")}</div></div>
    <div class="tvfoot"></div>${tape({ words: "Case closed  •  ", cls: "finaltape" })}`;
}
