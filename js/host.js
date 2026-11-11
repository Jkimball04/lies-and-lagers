// The host's laptop. It runs the whole game: holds the state, talks to every phone,
// and tells the TV window what to show. The game is saved after every change, so
// reloading this page picks up right where it left off.

import {
  esc, param, netMode, pageUrl, joinUrl, storage, keepAwake, pictureHTML, qrSVG, FRIENDS, loadDeck,
  listNames, cleanName, makeRoomCode, uid, shuffle, rulesHTML,
} from "./common.js";
import { hostNet, tvChannel } from "./net.js";

const mode = netMode();
const $ = s => document.querySelector(s);
const SAVE_KEY = "ll-host";
const MAX_PLAYERS = 16;
const GAME_ROUNDS = 13; // rounds in a game (a ?rounds= web address setting overrides it, e.g. for a quick test)
const ACTIVE = ["writing", "reading", "voting"];

let deck = null, cats = [], catById = {};
let S = null;              // the whole game
let net = null, tv = null;
const conns = new Map();   // connection id -> player id
const ui = { cat: null, draft: null, editCovers: false, wiki: null, netStatus: "starting", saved: null };
let saveTimer = null, tvTimer = null, toastTimer = null, beat = null;

init();

// ---------------------------------------------------------------- starting up

async function init() {
  try {
    deck = await loadDeck();
  } catch (e) {
    $("#main").innerHTML = `<p class="err">Sorry, ${esc(e.message)}. Try reloading the page.</p>`;
    return;
  }
  cats = [...deck.categories, FRIENDS];
  for (const c of cats) catById[c.id] = c;
  bindEvents();
  const saved = storage.get(SAVE_KEY);
  const recent = saved && saved.v === 1 && saved.mode === mode && Date.now() - saved.updated < 12 * 3600e3;
  if (param("new") == null && recent && saved.phase !== "final") showResume(saved);
  else start(null);
}

function newState() {
  const rounds = Math.max(1, Math.min(50, Number(param("rounds")) || GAME_ROUNDS));
  return { v: 1, mode, room: makeRoomCode(), phase: "lobby", players: {}, order: [], round: null, roundNo: 0, rounds, used: [], updated: Date.now() };
}

function showResume(saved) {
  ui.saved = saved;
  const names = saved.order.map(pid => saved.players[pid] && saved.players[pid].name).filter(Boolean);
  $("#hdr").innerHTML = brandHTML();
  $("#main").innerHTML = `<section class="resume panel"><h2>Pick up where you left off?</h2>
    <p>Game <b>${esc(saved.room)}</b>${saved.roundNo ? `, round ${saved.roundNo}` : ""}${names.length ? `, with ${esc(listNames(names))}` : ""}.</p>
    <div class="actions"><button class="btn ghost" data-act="fresh">Start a new game</button>
    <button class="btn big" data-act="resume">Resume this game</button></div></section>`;
}

function start(saved) {
  S = saved || newState();
  for (const p of Object.values(S.players)) p.connected = false;
  net = hostNet(S.room, mode, {
    onConnect() { /* the phone introduces itself with a "hello" */ },
    onMessage,
    onDisconnect,
    onStatus(s) { ui.netStatus = s; renderHeader(); },
  });
  tv = tvChannel(S.room);
  tv.onmessage = e => { if (e.data && e.data.k === "hello") pushTV(true); };
  clearInterval(beat);
  beat = setInterval(heartbeat, 4000);
  keepAwake();
  save();
  renderAll();
  pushTV(true);
}

function bindEvents() {
  document.addEventListener("click", onClick);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onInput);
  document.addEventListener("submit", onSubmit);
  window.addEventListener("pagehide", save);
}

// ---------------------------------------------------------------- talking to phones

function onMessage(cid, m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "hello") return hello(cid, m);
  const pid = conns.get(cid);
  const p = pid && S.players[pid];
  if (!p) return;
  p.lastSeen = Date.now();
  if (!p.connected) { p.connected = true; refresh({ main: needsMainRefresh() }); }
  if (m.t === "pong") return;

  const r = S.round;
  if ((m.t === "draft" || m.t === "submit") && S.phase === "writing" && r && r.inRound.includes(pid)) {
    const e = r.entries[pid] || (r.entries[pid] = { text: "", submitted: false, correct: false });
    if (e.submitted) return;
    e.text = String(m.text || "").slice(0, 160);
    if (m.t === "submit" && e.text.trim()) {
      e.submitted = true;
      e.sentBack = false;
      refresh({ views: [pid] });
    } else {
      updateWritingCard(pid);
      scheduleSave();
    }
  } else if (m.t === "vote" && S.phase === "voting" && r && isVoter(pid)) {
    // A vote is the number of an answer. Players can change it until the host confirms the votes.
    const v = r.votes[pid], a = r.list.find(x => x.n === Number(m.n));
    if (!v || v.skipped || !a || a.author === pid) { sendView(pid); return; }
    Object.assign(v, { submitted: true, target: a.id });
    refresh({ views: [pid] });
  }
}

function hello(cid, m) {
  const name = cleanName(m.name);
  if (!name) return reject(cid, "Please type your name.");
  let p = m.pid && S.players[m.pid];
  if (!p) {
    const same = Object.values(S.players).find(x => x.name.toLowerCase() === name.toLowerCase());
    if (same) {
      const live = [...conns.values()].includes(same.pid) && Date.now() - (same.lastSeen || 0) < 8000;
      if (live) return reject(cid, `Someone called ${same.name} is already playing. Try a different name.`);
      p = same; // same name, new tab or new phone: let them back in with their score
    } else {
      if (S.order.length >= MAX_PLAYERS) return reject(cid, "Sorry, this game is full.");
      const pid = "p" + uid(8);
      p = S.players[pid] = { pid, name, score: 0, connected: false, lastSeen: 0 };
      S.order.push(pid);
    }
  }
  for (const [c, x] of conns) if (x === p.pid && c !== cid) { conns.delete(c); net.drop(c); }
  conns.set(cid, p.pid);
  p.connected = true;
  p.lastSeen = Date.now();
  net.send(cid, { t: "welcome", pid: p.pid, name: p.name, room: S.room });
  sendView(p.pid);
  refresh({ main: needsMainRefresh() });
}

function reject(cid, reason) {
  net.send(cid, { t: "reject", reason });
  setTimeout(() => net.drop(cid), 400);
}

function onDisconnect(cid) {
  const pid = conns.get(cid);
  conns.delete(cid);
  if (!pid || !S.players[pid]) return;
  if (![...conns.values()].includes(pid)) {
    S.players[pid].connected = false;
    refresh({ main: needsMainRefresh() });
  }
}

function heartbeat() {
  const now = Date.now();
  let changed = false;
  for (const [cid, pid] of conns) {
    net.send(cid, { t: "ping" });
    const p = S.players[pid];
    if (p && p.connected && now - (p.lastSeen || 0) > 15000) { p.connected = false; changed = true; }
  }
  if (changed) refresh({ main: needsMainRefresh() });
}

// The writing and voting pages show who's connected; other pages have forms we mustn't wipe.
const needsMainRefresh = () => ["lobby", "writing", "voting"].includes(S.phase);

// ---------------------------------------------------------------- keeping everything in step

function refresh({ main = true, side = true, views = false } = {}) {
  if (main) renderMain();
  if (side) renderSide();
  renderHeader();
  pushTV();
  if (views === true) S.order.forEach(sendView);
  else if (Array.isArray(views)) views.forEach(sendView);
  scheduleSave();
}

function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
function save() { if (S) { S.updated = Date.now(); storage.set(SAVE_KEY, S); } }

function pushTV(now = false) {
  if (!tv || !S) return;
  clearTimeout(tvTimer);
  const go = () => { try { tv.postMessage({ k: "view", view: tvView() }); } catch (e) { console.warn(e); } };
  if (now) go(); else tvTimer = setTimeout(go, 60);
}

function sendView(pid) {
  if (!S.players[pid]) return;
  const view = playerView(pid);
  for (const [cid, x] of conns) if (x === pid) net.send(cid, { t: "view", view });
}

// ---------------------------------------------------------------- small helpers

const nameOf = pid => (S.players[pid] ? S.players[pid].name : "(left)");
const catName = id => (catById[id] || { name: "Custom" }).name;
const ranking = () => [...S.order].sort((a, b) => S.players[b].score - S.players[a].score || nameOf(a).localeCompare(nameOf(b)));
const isVoter = pid => { const r = S.round; return !!r && r.inRound.includes(pid) && !(r.entries[pid] && r.entries[pid].correct); };
const voters = () => S.round.inRound.filter(isVoter);
const votersFor = id => Object.keys(S.round.votes).filter(pid => S.round.votes[pid].target === id && !S.round.votes[pid].skipped);
const voteDone = pid => { const v = S.round.votes[pid]; return !!v && (v.skipped || (v.submitted && !!v.target)); };
const totalRounds = () => S.rounds || GAME_ROUNDS;
const lastRoundDone = () => S.roundNo >= totalRounds();
const roundsText = () => `${totalRounds()} round${totalRounds() === 1 ? "" : "s"}`;
const roundLabel = () => (S.phase === "lobby" || S.phase === "rules" ? roundsText()
  : `Round <b>${Math.min(S.phase === "pick" ? S.roundNo + 1 : S.roundNo, totalRounds())}</b> of ${totalRounds()}`);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.textContent = ""; }, 5000);
}

// ---------------------------------------------------------------- the round, step by step

function deckToDraft(p) {
  const c = catById[p.category];
  return {
    deckId: p.id, category: p.category, custom: false, sitOut: [],
    question: c.type === "picture" ? c.question : p.prompt,
    display: p.image ? "" : p.prompt,
    image: p.image ? JSON.parse(JSON.stringify(p.image)) : null,
    answer: p.answer, source: p.source || null,
  };
}

function choosePrompt(id) {
  const p = deck.prompts.find(x => x.id === id);
  if (!p) return;
  ui.draft = deckToDraft(p);
  ui.editCovers = false;
  renderMain();
}

function startCustom() {
  const cat = ui.cat || "friends";
  const c = catById[cat];
  ui.draft = { deckId: null, category: cat, custom: true, sitOut: [], question: c.type === "picture" ? c.question : "",
    display: "", image: null, answer: "", source: null };
  ui.wiki = null;
  ui.editCovers = false;
  renderMain();
}

function startRoundFromDraft() {
  const d = ui.draft;
  if (!d) return;
  const question = (d.question || "").trim(), answer = (d.answer || "").trim();
  if (!question || !answer) return toast("Fill in the question and the true answer first.");
  const prompt = {
    deckId: d.deckId, category: d.category, kind: d.image ? "picture" : "text", question,
    display: d.image ? "" : ((d.display || "").trim() || question),
    image: d.image ? JSON.parse(JSON.stringify(d.image)) : null,
    answer, source: d.source || null,
  };
  const sitOut = (d.sitOut || []).filter(pid => S.players[pid]);
  S.roundNo += 1;
  S.round = { n: S.roundNo, prompt, sitOut, inRound: S.order.filter(pid => !sitOut.includes(pid)),
    entries: {}, list: null, readIndex: 0, votes: {}, points: {}, confirmed: false };
  if (prompt.deckId && !S.used.includes(prompt.deckId)) S.used.push(prompt.deckId);
  S.phase = "writing";
  Object.assign(ui, { draft: null, editCovers: false, wiki: null });
  refresh({ views: true });
}

function cancelRound() {
  if (!confirm("Cancel this round? Nobody scores, and you go back to picking a prompt.")) return;
  const id = S.round && S.round.prompt.deckId;
  S.used = S.used.filter(x => x !== id);
  S.roundNo -= 1;
  S.round = null;
  S.phase = "pick";
  refresh({ views: true });
}

function toggleCorrect(pid) {
  const r = S.round;
  const e = r.entries[pid] || (r.entries[pid] = { text: "", submitted: false, correct: false });
  e.correct = !e.correct;
  refresh({ views: [pid] });
}

// Reopen a player's answer box (their answer stays in it) so they can change it and send it again.
function sendBackAnswer(pid) {
  const e = S.round && S.round.entries[pid];
  if (S.phase !== "writing" || !e || !e.submitted || e.correct) return;
  e.submitted = false;
  e.sentBack = true;
  refresh({ views: [pid] });
}

function startReading() {
  const r = S.round, list = [];
  for (const pid of r.inRound) {
    const e = r.entries[pid];
    if (!e || e.correct) continue;
    const text = (e.text || "").trim();
    if (!text) continue;
    e.submitted = true; // time's up: whatever they typed is their answer
    list.push({ id: "a-" + pid, text, author: pid, isTrue: false });
  }
  list.push({ id: "true", text: r.prompt.answer, author: null, isTrue: true });
  shuffle(list).forEach((a, i) => { a.n = i + 1; });
  r.list = list;
  r.readIndex = 0;
  S.phase = "reading";
  refresh({ views: true });
}

function moveReading(step) {
  const r = S.round;
  r.readIndex = Math.max(0, Math.min(r.list.length - 1, r.readIndex + step));
  refresh({ side: false });
}

function startVoting() {
  const r = S.round;
  r.votes = {};
  for (const pid of voters()) r.votes[pid] = { submitted: false, target: null, skipped: false };
  S.phase = "voting";
  refresh({ views: true });
}

// For anyone who can't vote (phone died, wandered off). Their phone stops offering the numbers.
function setSkip(pid, on) {
  const v = S.round.votes[pid];
  if (v) { v.skipped = on; if (on) { v.target = null; v.submitted = false; } }
  refresh({ side: false, views: [pid] });
}

function confirmVotes() {
  const r = S.round;
  if (!voters().every(voteDone)) return toast("Wait for everyone's vote, or skip anyone who can't vote.");
  const pts = {};
  const add = (pid, n) => { pts[pid] = (pts[pid] || 0) + n; };
  for (const pid of r.inRound) if (r.entries[pid] && r.entries[pid].correct) add(pid, 1);   // wrote the true answer
  for (const pid of voters()) {
    const v = r.votes[pid];
    if (v.skipped || !v.target) continue;
    const a = r.list.find(x => x.id === v.target);
    if (a.isTrue) add(pid, 1);                                   // picked the true answer
    else if (a.author && S.players[a.author]) add(a.author, 1); // fooled by someone's fake
  }
  r.points = pts;
  r.confirmed = true;
  for (const [pid, n] of Object.entries(pts)) if (S.players[pid]) S.players[pid].score += n;
  S.phase = "novotes"; // first, whose fakes fooled nobody; then the full reveal
  refresh({ views: true });
}

// Fakes that nobody voted for. The true answer is never in this list, so it doesn't give anything away.
const noVoteFakes = () => S.round.list.filter(a => !a.isTrue && !votersFor(a.id).length);

function showReveal() {
  S.phase = "reveal";
  refresh({ views: true });
}

function nextRound() {
  S.phase = "pick";
  S.round = null;
  Object.assign(ui, { draft: null, editCovers: false, wiki: null });
  refresh({ views: true });
}

function endGame() {
  if (!confirm("End the game early and show the final scores?")) return;
  finishGame();
}

function finishGame() {
  S.phase = "final";
  S.round = null;
  refresh({ views: true });
}

function playAgain() {
  if (!confirm("Start a new game with the same players? Everyone's score goes back to zero.")) return;
  for (const p of Object.values(S.players)) p.score = 0;
  Object.assign(S, { phase: "lobby", round: null, roundNo: 0 });
  refresh({ views: true });
}

function removePlayer(pid) {
  const p = S.players[pid];
  if (!p) return;
  if (ACTIVE.includes(S.phase)) return toast("You can remove players between rounds.");
  if (!confirm(`Remove ${p.name} from the game?`)) return;
  for (const [cid, x] of [...conns]) {
    if (x !== pid) continue;
    net.send(cid, { t: "removed" });
    conns.delete(cid);
    setTimeout(() => net.drop(cid), 400);
  }
  delete S.players[pid];
  S.order = S.order.filter(x => x !== pid);
  refresh({});
}

function openTV() {
  const w = window.open(pageUrl("tv.html", { room: S.room }), "lieslagers-tv", "popup,width=1280,height=720");
  if (!w) toast("Your browser blocked the TV window. Allow pop-ups for this page, then try again.");
  else setTimeout(() => pushTV(true), 800);
}

// ---------------------------------------------------------------- what each phone and the TV see

function playerView(pid) {
  const p = S.players[pid], r = S.round;
  const v = { phase: "lobby", round: S.roundNo, total: totalRounds(), name: p.name, score: p.score,
    rank: ranking().indexOf(pid) + 1, players: S.order.length };
  if (r) v.category = catName(r.prompt.category);
  const inR = !!r && r.inRound.includes(pid);
  switch (S.phase) {
    case "lobby": v.phase = "lobby"; break;
    case "rules": v.phase = "rules"; break;
    case "pick": v.phase = "between"; break;
    case "writing": case "reading": case "voting":
      if (!inR) { v.phase = r && r.sitOut.includes(pid) ? "sitout" : "late"; break; }
      v.phase = S.phase;
      if (S.phase === "writing") {
        const e = r.entries[pid] || {};
        v.answer = { text: e.text || "", submitted: !!(e.submitted || e.correct), sentBack: !!e.sentBack && !e.submitted && !e.correct };
      }
      if (S.phase === "voting") {
        const vt = r.votes[pid];
        v.canVote = !!vt && !vt.skipped;
        if (v.canVote) {
          const chosen = vt.target && r.list.find(a => a.id === vt.target), mine = r.list.find(a => a.author === pid);
          v.vote = { count: r.list.length, n: chosen ? chosen.n : null, mine: mine ? mine.n : null };
        }
      }
      break;
    case "novotes":
      v.phase = inR ? "novotes" : "between";
      v.score = p.score - ((r && r.points[pid]) || 0); // keep this round's points a surprise until the reveal
      break;
    case "reveal": v.phase = inR ? "reveal" : "between"; if (inR) v.result = resultFor(pid); break;
    case "scores": v.phase = "scores"; break;
    case "final": v.phase = "final"; break;
  }
  return v;
}

function resultFor(pid) {
  const r = S.round;
  const res = { delta: r.points[pid] || 0, wroteTrue: !!(r.entries[pid] && r.entries[pid].correct), guessedRight: false, picked: null, fooled: [] };
  const v = r.votes[pid];
  if (v && v.target && !v.skipped) {
    const a = r.list.find(x => x.id === v.target);
    res.guessedRight = !!(a && a.isTrue);
    if (a && !a.isTrue) res.picked = nameOf(a.author);
  }
  const mine = r.list.find(a => a.author === pid);
  if (mine) res.fooled = votersFor(mine.id).map(nameOf);
  return res;
}

function tvView() {
  const r = S.round;
  const view = {
    room: S.room, joinUrl: joinUrl(S.room), phase: S.phase, round: S.roundNo, total: totalRounds(),
    players: S.order.map(pid => ({ name: nameOf(pid), connected: S.players[pid].connected })),
  };
  if (r && ["writing", "reading", "voting", "novotes", "reveal"].includes(S.phase)) {
    view.category = { name: catName(r.prompt.category) };
    view.prompt = {
      question: r.prompt.question,
      display: r.prompt.display || "",
      image: r.prompt.image ? { url: r.prompt.image.url, covers: r.prompt.image.covers || [] } : null,
    };
  }
  if (S.phase === "writing") {
    view.done = r.inRound.map(pid => ({ name: nameOf(pid), done: !!(r.entries[pid] && (r.entries[pid].submitted || r.entries[pid].correct)) }));
  }
  if (S.phase === "reading") view.reading = { count: r.list.length, index: r.readIndex };
  if (S.phase === "voting") {
    view.voting = voters().map(pid => ({ name: nameOf(pid), voted: voteDone(pid) }));
    view.choices = r.list.length;
  }
  if (S.phase === "novotes") view.novotes = noVoteFakes().map(a => ({ n: a.n, text: a.text, author: nameOf(a.author) }));
  if (S.phase === "reveal") {
    view.reveal = {
      answers: r.list.map(a => ({ n: a.n, text: a.text, isTrue: a.isTrue, author: a.author ? nameOf(a.author) : null, pickers: votersFor(a.id).map(nameOf) })),
      correctWriters: r.inRound.filter(pid => r.entries[pid] && r.entries[pid].correct).map(nameOf),
      points: Object.entries(r.points).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([pid, n]) => ({ name: nameOf(pid), n })),
      image: r.prompt.image ? { url: r.prompt.image.url, credit: r.prompt.image.credit || "", license: r.prompt.image.license || "" } : null,
    };
  }
  if (["pick", "reveal", "scores", "final"].includes(S.phase)) {
    view.scores = ranking().map(pid => ({ name: nameOf(pid), score: S.players[pid].score }));
  }
  return view;
}

// ---------------------------------------------------------------- drawing the host's screen

const brandHTML = () => `<div class="brand">Lies <span>&amp;</span> Lagers</div>`;
const STEPS = [["lobby", "Lobby"], ["rules", "How to play"], ["pick", "Pick a prompt"], ["writing", "Writing"], ["reading", "Reading"],
  ["voting", "Voting"], ["novotes", "No votes"], ["reveal", "Reveal"], ["scores", "Scores"]];
const NET_LABEL = { online: "● Ready for players", starting: "Starting…", reconnecting: "Reconnecting…",
  "waiting-for-code": "Getting the room ready…" };

function renderAll() { renderHeader(); renderSide(); renderMain(); }

function renderHeader() {
  if (!S) return;
  const key = S.phase === "final" ? "scores" : S.phase;
  $("#hdr").innerHTML = `${brandHTML()}
    <div class="steps">${STEPS.map(([k, l]) => `<span class="${k === key ? "on" : ""}">${l}</span>`).join("")}</div>
    <div class="roomcode">${roundLabel()}</div>
    <div class="roomcode">Room <b>${esc(S.room)}</b></div>
    <div class="netstat ${esc(ui.netStatus)}">${esc(NET_LABEL[ui.netStatus] || ui.netStatus)}${mode === "local" ? " · test mode" : ""}</div>
    <button class="btn small ghost" data-act="open-tv">Open TV screen</button>`;
}

function renderSide() {
  if (!S) return;
  const canRemove = !ACTIVE.includes(S.phase);
  const rows = S.order.map(pid => {
    const p = S.players[pid];
    return `<li class="${p.connected ? "" : "off"}" title="${p.connected ? "Connected" : "Not connected"}"><span class="dot"></span>
      <span class="nm">${esc(p.name)}</span><span class="sc">${p.score}</span>
      ${canRemove ? `<button class="x" data-act="remove" data-pid="${p.pid}" title="Remove ${esc(p.name)}">×</button>` : ""}</li>`;
  }).join("");
  const url = joinUrl(S.room);
  $("#side").innerHTML = `<h3>Players (${S.order.length})</h3>
    <ul class="players">${rows || `<li class="empty">Nobody yet</li>`}</ul>
    <div class="joininfo"><div class="qr">${qrSVG(url)}</div>
    <div>Players join at<br><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></div></div>`;
}

function renderMain() {
  if (!S) return;
  const fn = { lobby: mainLobby, rules: mainRules, pick: mainPick, writing: mainWriting, reading: mainReading, voting: mainVoting,
    novotes: mainNoVotes, reveal: mainReveal, scores: mainScores, final: mainFinal }[S.phase];
  $("#main").innerHTML = fn();
  if (S.phase === "pick" && ui.draft && ui.draft.image && ui.editCovers) {
    const frame = document.querySelector(".draft .pic-frame");
    if (frame) attachCoverEditor(frame, ui.draft.image.covers || (ui.draft.image.covers = []));
  }
}

function mainLobby() {
  const n = S.order.length;
  return `<section class="lobby"><h2>Get everyone in</h2>
    <ol class="steps-list">
      <li><b>Open the TV screen</b> (button above), drag that window onto the TV and make it full screen.</li>
      <li><b>Players scan the QR code</b> on the TV, or open the link, then type their name.</li>
      <li>When everyone's in, <b>start the game</b>. The TV explains how to play first, and people can still join between rounds.</li>
    </ol>
    <div class="actions"><span class="muted">${n ? `${n} player${n === 1 ? "" : "s"} in` : "Waiting for players…"} · ${roundsText()}</span>
      <button class="btn ghost" data-act="open-tv">Open TV screen</button>
      <button class="btn big" data-act="start-game" ${n ? "" : "disabled"}>Start the game →</button></div>
    ${mode === "local" ? `<p class="small muted">Test mode: players have to be tabs in this same browser.</p>` : ""}</section>`;
}

// Before round 1: the same five steps the TV and phones show, so the host can talk everyone through them.
function mainRules() {
  return `<section class="rules"><h2>How to play <span class="muted small">(showing on the TV now)</span></h2>
    <p class="muted">Talk everyone through the steps on the TV. Their phones show them too.</p>
    ${rulesHTML()}
    <p class="rules-total">${roundsText()}. Most points wins.</p>
    <div class="panel"><p class="label">Also worth saying</p>
      <ul class="tips">
        <li>Picture questions have two parts, like who it is <i>and</i> what they're known for. Answer both.</li>
        <li>Spelling doesn't matter. Answers never go up on the screen before the vote, and you read them all out in your own words.</li>
        <li>Anyone who writes the real answer gets a point and skips the vote. You mark it correct while they're writing.</li>
        <li>Phones only show the answer box and, for voting, the answer numbers. Everything else is on the TV.</li>
      </ul></div>
    <div class="actions"><button class="btn ghost" data-act="back-lobby">◀ Back to the lobby</button>
      <button class="btn big" data-act="lets-play">Let's play →</button></div></section>`;
}

function mainPick() {
  if (!ui.cat) ui.cat = cats[0].id;
  const chips = cats.map(c => {
    const left = deck.prompts.filter(p => p.category === c.id && !S.used.includes(p.id)).length;
    return `<button class="chip ${c.id === ui.cat ? "on" : ""}" data-act="cat" data-cat="${c.id}">${esc(c.name)}<small>${c.id === "friends" ? "✎" : left}</small></button>`;
  }).join("");
  const cards = deck.prompts.filter(p => p.category === ui.cat).map(p => {
    const used = S.used.includes(p.id), on = ui.draft && ui.draft.deckId === p.id;
    return `<div class="pcard ${used ? "used" : ""} ${on ? "on" : ""}" data-act="pick" data-id="${esc(p.id)}" role="button" tabindex="0">
      ${p.image ? pictureHTML(p.image) : `<span class="ptext">${esc(p.prompt)}</span>`}
      <span class="pans">${used ? "<b>Used</b> · " : ""}${esc(p.answer)}</span></div>`;
  }).join("");
  const empty = ui.cat === "friends"
    ? `<div class="panel"><p class="muted">You make these up yourself. Get the true answer from the person in secret first; they sit the round out.</p>
       <button class="btn small" data-act="custom">✎ Make one now</button></div>`
    : `<p class="muted">No prompts in this category yet.</p>`;
  return `<section class="pick"><div class="pick-head"><h2>Round ${S.roundNo + 1} of ${totalRounds()}: pick a prompt</h2>
      <button class="btn small ghost" data-act="custom">✎ Make your own</button></div>
    <div class="chips">${chips}</div>
    <div class="pick-body"><div class="prompt-list">${cards || empty}</div>
      <div class="draft">${ui.draft ? (ui.draft.custom ? customPanel() : draftPanel()) : `<div class="panel muted">Pick a prompt to see it here, or make your own.</div>`}</div></div></section>`;
}

function coverTools(d) {
  const n = (d.image.covers || []).length;
  return `<div class="cover-tools"><button class="btn tiny ghost" data-act="edit-covers">${ui.editCovers ? "Done covering" : "Cover something up"}</button>
    <span class="small muted">${ui.editCovers ? "Drag across the picture to cover a name or title. Tap × to remove one."
      : n ? `${n} cover${n === 1 ? "" : "s"}: they stay on until the reveal.` : ""}</span></div>`;
}

function draftPanel() {
  const d = ui.draft;
  return `<div class="panel"><p class="label">${esc(catName(d.category))}</p>
    ${d.image ? pictureHTML(d.image, { editing: ui.editCovers, cls: "big" }) + coverTools(d) : `<p class="tvtext">${esc(d.display)}</p>`}
    <p class="label">Read this out</p><p class="read">${esc(d.question)}</p>
    <p class="label">True answer</p><p class="answer">${esc(d.answer)}</p>
    ${d.source ? `<p class="small muted">Source: <a href="${esc(d.source.url)}" target="_blank" rel="noopener">${esc(d.source.title)}</a></p>` : ""}
    <div class="actions"><button class="btn big" data-act="start-round">Start round ${S.roundNo + 1} →</button></div></div>`;
}

function customPanel() {
  const d = ui.draft, w = ui.wiki || {};
  const opts = cats.map(c => `<option value="${c.id}" ${c.id === d.category ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  let results = "";
  if (w.loading) results = `<p class="small muted">Searching…</p>`;
  else if (w.error) results = `<p class="small err">${esc(w.error)}</p>`;
  else if (w.results) results = w.results.length
    ? `<ul class="wikires">${w.results.map(x => `<li><button data-act="wiki-pick" data-title="${esc(x.title)}"><b>${esc(x.title)}</b><br><span class="small muted">${esc(x.snippet)}</span></button></li>`).join("")}</ul>`
    : `<p class="small muted">Nothing found.</p>`;
  const sitOut = S.order.map(pid => `<label class="inline"><input type="checkbox" data-sitout="${pid}" ${d.sitOut.includes(pid) ? "checked" : ""}> ${esc(nameOf(pid))}</label>`).join("");
  return `<div class="panel custom"><h3>Make your own prompt</h3>
    <label>Category<select data-field="category">${opts}</select></label>
    <form data-form="wiki"><label for="wq">Find a picture or facts on Wikipedia <span class="muted">(optional)</span></label>
      <div class="row"><input id="wq" name="q" placeholder="e.g. Blobfish" value="${esc(w.q || "")}"><button class="btn small">Search</button></div></form>
    ${results}
    ${w.loadingPage ? `<p class="small muted">Loading the page…</p>` : ""}
    ${w.page ? `<details><summary class="small">What Wikipedia says about ${esc(w.page.title)}</summary><p class="extract">${esc(w.page.extract)}</p></details>` : ""}
    ${d.image ? pictureHTML(d.image, { editing: ui.editCovers, cls: "big" }) + coverTools(d) + `<button class="btn tiny ghost" data-act="no-picture">Don't use a picture</button>` : ""}
    <label>Question to read out<textarea data-field="question" rows="2" placeholder="e.g. What does “snollygoster” mean?">${esc(d.question)}</textarea></label>
    ${d.image ? "" : `<label>What the TV shows <span class="muted">(leave blank to show the question)</span><textarea data-field="display" rows="2">${esc(d.display)}</textarea></label>`}
    <label>True answer<textarea data-field="answer" rows="2" placeholder="Short and plain, the way a player would write it">${esc(d.answer)}</textarea></label>
    ${S.order.length ? `<p class="label" style="margin-top:1em">Sitting this round out <span class="muted">(like the person it's about)</span></p><div class="sitout">${sitOut}</div>` : ""}
    <div class="actions"><button class="btn big" data-act="start-round">Start round ${S.roundNo + 1} →</button></div></div>`;
}

function writingCard(pid) {
  const p = S.players[pid], e = S.round.entries[pid] || {};
  const status = e.correct ? `<span class="tag good">Marked correct · won't be read out</span>`
    : e.submitted ? `<span class="tag ok">✓ Sent</span>`
    : e.sentBack ? `<span class="tag warn">Sent back</span>`
    : e.text ? `<span class="tag">typing…</span>`
    : `<span class="tag">${p && p.connected ? "nothing yet" : "not connected"}</span>`;
  return `<div class="card wcard ${e.correct ? "correct" : ""}" data-pid="${pid}">
    <div class="wtop"><b>${esc(nameOf(pid))}</b>${status}</div>
    <p class="draft-text">${esc(e.text || "")}</p>
    <div class="wbtns"><button class="btn tiny ${e.correct ? "" : "ghost"}" data-act="mark-correct" data-pid="${pid}">${e.correct ? "Undo “correct”" : "Mark as correct"}</button>
      ${e.submitted && !e.correct ? `<button class="btn tiny ghost" data-act="send-back-answer" data-pid="${pid}" aria-label="Send back ${esc(nameOf(pid))}'s answer">↩ Send back</button>` : ""}</div></div>`;
}

function updateWritingCard(pid) {
  if (S.phase !== "writing") return;
  const el = document.querySelector(`.wcard[data-pid="${pid}"]`);
  if (el) el.outerHTML = writingCard(pid); else renderMain();
}

function mainWriting() {
  const r = S.round, pr = r.prompt;
  const sent = r.inRound.filter(pid => r.entries[pid] && (r.entries[pid].submitted || r.entries[pid].correct)).length;
  return `<section class="writing">
    <div class="panel readout"><div>
      <p class="label">${esc(catName(pr.category))} · read this out</p><p class="read big">${esc(pr.question)}</p>
      <p class="label">True answer <span class="muted">(keep it to yourself)</span></p><p class="answer">${esc(pr.answer)}</p>
      ${r.sitOut.length ? `<p class="small muted">Sitting out: ${esc(listNames(r.sitOut.map(nameOf)))}</p>` : ""}</div>
      ${pr.image ? pictureHTML(pr.image, { cls: "thumb" }) : ""}</div>
    <div class="cards">${r.inRound.map(writingCard).join("")}</div>
    <div class="actions"><span class="muted">${sent} of ${r.inRound.length} answers sent</span>
      <button class="btn small ghost" data-act="cancel-round">Cancel round</button>
      <button class="btn big" data-act="start-reading">Start reading the answers →</button></div>
    ${sent < r.inRound.length ? `<p class="small muted right">Anyone who hasn't sent yet will be stuck with whatever they've typed so far.</p>` : ""}</section>`;
}

// The question (and picture) at the top of the reading and voting pages.
function questionBar(pr) {
  return `<div class="panel qbar"><div><p class="label">${esc(catName(pr.category))} · the question</p><p class="read">${esc(pr.question)}</p></div>
    ${pr.image ? pictureHTML(pr.image, { cls: "thumb" }) : ""}</div>`;
}

function mainReading() {
  const r = S.round;
  const rows = r.list.map((a, i) => `<li class="ans ${i === r.readIndex ? "now" : ""} ${i < r.readIndex ? "done" : ""}">
      <span class="num">${a.n}</span><span class="txt">${esc(a.text)}</span>
      <span class="who">${a.isTrue ? `<b class="true">★ TRUE ANSWER</b>` : esc(nameOf(a.author))}</span></li>`).join("");
  const last = r.readIndex >= r.list.length - 1;
  return `<section class="reading">${questionBar(r.prompt)}<h2>Read these out, in order</h2>
    <p class="muted">Say the number, then the answer. Word them so they all sound alike. The TV lights up each number as you go.</p>
    <ol class="answers">${rows}</ol>
    <div class="actions"><button class="btn ghost" data-act="read-prev" ${r.readIndex <= 0 ? "disabled" : ""}>◀ Back</button>
      ${last ? `<button class="btn ghost" data-act="read-restart">Read them all again</button>
        <button class="btn big" data-act="start-voting">Start voting →</button>`
        : `<button class="btn big" data-act="read-next">Next answer ▶</button>`}</div></section>`;
}

// Players vote by tapping an answer's number on their phone; each name shows up under its answer as it comes in.
function mainVoting() {
  const r = S.round, vs = voters(), pr = r.prompt;
  const answers = r.list.map(a => {
    const tags = votersFor(a.id).map(pid => `<span class="vname ${a.isTrue ? "good" : ""}">${esc(nameOf(pid))}</span>`).join("");
    return `<div class="vans ${a.isTrue ? "is-true" : ""}">
      <div class="vhead"><span class="num">${a.n}</span><span class="txt">${esc(a.text)}</span>
        <span class="who">${a.isTrue ? `<b class="true">★ TRUE</b>` : esc(nameOf(a.author))}</span></div>
      <div class="placed">${tags || `<span class="small muted">No votes yet</span>`}</div></div>`;
  }).join("");
  const notYet = vs.filter(pid => r.votes[pid] && !r.votes[pid].skipped && !voteDone(pid));
  const skipped = vs.filter(pid => r.votes[pid] && r.votes[pid].skipped);
  const sitting = r.inRound.filter(pid => !isVoter(pid));
  const done = vs.filter(voteDone).length;
  return `<section class="voting">${questionBar(pr)}
    <div class="vcols">
    <div><h2>The votes</h2>
      <p class="muted">Players tap a number on their phone, and their name shows up under that answer. They can change their vote until you confirm.</p>${answers}</div>
    <aside class="tray"><h3>Still voting</h3>
      ${notYet.length ? `<ul class="still">${notYet.map(pid => `<li><span>${esc(nameOf(pid))}</span>
        <button class="btn tiny ghost" data-act="skip" data-pid="${pid}" title="Leave ${esc(nameOf(pid))} out of this vote">Skip</button></li>`).join("")}</ul>`
        : `<p class="small muted">Everyone's voted.</p>`}
      ${skipped.length ? `<h3>Skipped</h3><ul class="still">${skipped.map(pid => `<li><span>${esc(nameOf(pid))}</span>
        <button class="btn tiny ghost" data-act="unskip" data-pid="${pid}">Undo</button></li>`).join("")}</ul>` : ""}
      ${sitting.length ? `<p class="small muted">Not voting (wrote the true answer): ${esc(listNames(sitting.map(nameOf)))}</p>` : ""}
    </aside></div>
    <div class="actions"><span class="muted">${done} of ${vs.length} votes in</span>
      <button class="btn big" data-act="confirm-votes" ${done === vs.length ? "" : "disabled"}>Confirm votes ✓</button></div></section>`;
}

function mainNoVotes() {
  const r = S.round, flops = noVoteFakes();
  const rows = flops.map(a => `<li class="ans"><span class="num">${a.n}</span><span class="txt">${esc(a.text)}</span>
      <span class="who"><b class="vname">${esc(nameOf(a.author))}</b></span></li>`).join("");
  return `<section class="novotes">${questionBar(r.prompt)}<h2>Nobody fell for… <span class="muted small">(showing on the TV)</span></h2>
    ${flops.length
      ? `<p class="muted">Read out whose answers these were. Nobody voted for them, so they score nothing for their fakes this round.</p><ol class="answers">${rows}</ol>`
      : `<p class="read big">Every fake fooled somebody!</p>`}
    <div class="actions"><button class="btn big" data-act="show-reveal">Reveal the answers →</button></div></section>`;
}

function mainReveal() {
  const r = S.round;
  const rows = r.list.map(a => {
    const pickers = votersFor(a.id).map(nameOf);
    const tags = pickers.map(n => `<span class="vname ${a.isTrue ? "good" : ""}">${esc(n)}</span>`).join("");
    return `<li class="ans ${a.isTrue ? "is-true" : ""}"><span class="num">${a.n}</span><span class="txt">${esc(a.text)}</span>
      <span class="who">${a.isTrue ? `<b class="true">★ TRUE</b>` : esc(nameOf(a.author))}</span>
      <span class="picks">${pickers.length ? `<span class="lbl">${a.isTrue ? "Found by" : "Fooled"}</span>${tags}`
        : `<span class="lbl">${a.isTrue ? "Nobody found it" : "Fooled nobody"}</span>`}</span></li>`;
  }).join("");
  const pts = Object.entries(r.points).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .map(([pid, n]) => `<li>${esc(nameOf(pid))} <b>+${n}</b></li>`).join("");
  return `<section class="reveal"><h2>Round ${r.n} results <span class="muted small">(showing on the TV)</span></h2>
    <ol class="answers">${rows}</ol>
    <h3>Points this round</h3><ul class="pts">${pts || `<li class="muted">Nobody scored this round</li>`}</ul>
    <div class="actions">${lastRoundDone()
      ? `<span class="muted">That was the last round!</span>
        <button class="btn big" data-act="finish">See the final scores →</button>`
      : `<button class="btn ghost" data-act="show-scores">Show the scoreboard on the TV</button>
        <button class="btn big" data-act="next-round">Next round →</button>`}</div></section>`;
}

const scoreboardHTML = () => `<ol class="board">${ranking().map((pid, i) =>
  `<li><span>${i + 1}. ${esc(nameOf(pid))}</span><b>${S.players[pid].score}</b></li>`).join("")}</ol>`;

function mainScores() {
  return `<section><h2>Scores after round ${S.roundNo} of ${totalRounds()}</h2>${scoreboardHTML()}
    <div class="actions">${lastRoundDone()
      ? `<button class="btn big" data-act="finish">See the final scores →</button>`
      : `<button class="btn ghost" data-act="end-game">End the game early</button>
        <button class="btn big" data-act="next-round">Next round →</button>`}</div></section>`;
}

function mainFinal() {
  const top = ranking()[0];
  return `<section><h2>Game over${top ? `: ${esc(nameOf(top))} wins!` : ""}</h2>${scoreboardHTML()}
    <div class="actions"><button class="btn big" data-act="play-again">Play again with the same people</button></div></section>`;
}

// ---------------------------------------------------------------- clicks, typing, forms

function onClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled || !b.dataset.act) return;
  const d = b.dataset;
  const actions = {
    resume: () => start(ui.saved),
    fresh: () => { storage.del(SAVE_KEY); start(null); },
    "open-tv": openTV,
    "start-game": () => { S.phase = "rules"; refresh({ views: true }); },
    "lets-play": () => { S.phase = "pick"; refresh({ views: true }); },
    "back-lobby": () => { S.phase = "lobby"; refresh({ views: true }); },
    cat: () => { ui.cat = d.cat; ui.draft = null; ui.editCovers = false; renderMain(); },
    pick: () => choosePrompt(d.id),
    custom: startCustom,
    "edit-covers": () => { ui.editCovers = !ui.editCovers; renderMain(); },
    "cover-x": () => { ui.draft.image.covers.splice(+d.i, 1); renderMain(); },
    "wiki-pick": () => pickWiki(d.title),
    "no-picture": () => { ui.draft.image = null; ui.editCovers = false; renderMain(); },
    "start-round": startRoundFromDraft,
    "mark-correct": () => toggleCorrect(d.pid),
    "send-back-answer": () => sendBackAnswer(d.pid),
    "cancel-round": cancelRound,
    "start-reading": startReading,
    "read-next": () => moveReading(1),
    "read-prev": () => moveReading(-1),
    "read-restart": () => { S.round.readIndex = 0; refresh({ side: false }); },
    "start-voting": startVoting,
    skip: () => setSkip(d.pid, true),
    unskip: () => setSkip(d.pid, false),
    "confirm-votes": confirmVotes,
    "show-reveal": showReveal,
    "show-scores": () => { S.phase = "scores"; refresh({ views: true }); },
    "next-round": nextRound,
    "end-game": endGame,
    finish: finishGame,
    "play-again": playAgain,
    remove: () => removePlayer(d.pid),
  };
  const fn = actions[d.act];
  if (fn) { e.preventDefault(); fn(); }
}

function onInput(e) {
  const t = e.target;
  if (!ui.draft || !t.dataset) return;
  if (t.dataset.sitout) {
    const pid = t.dataset.sitout;
    ui.draft.sitOut = t.checked ? [...new Set([...ui.draft.sitOut, pid])] : ui.draft.sitOut.filter(x => x !== pid);
    return;
  }
  const f = t.dataset.field;
  if (!f) return;
  if (t.tagName === "SELECT" && e.type === "input") return; // handled once, on "change"
  const before = ui.draft[f];
  ui.draft[f] = t.value;
  if (f === "category") {
    // Swap in the new category's question, unless the host has typed their own.
    const c = catById[ui.draft.category], old = catById[before];
    const q = (ui.draft.question || "").trim();
    if (!q || (old && q === old.question)) ui.draft.question = c && c.type === "picture" ? c.question : "";
    renderMain();
  }
}

async function onSubmit(e) {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form !== "wiki") return;
  const q = form.q.value.trim();
  if (!q) return;
  ui.wiki = { q, loading: true, results: null, page: null };
  renderMain();
  try { ui.wiki.results = await wikiSearch(q); } catch { ui.wiki.error = "Couldn't reach Wikipedia. Check the internet connection."; }
  ui.wiki.loading = false;
  if (S.phase === "pick" && ui.draft && ui.draft.custom) renderMain();
}

// Drag a box across a picture to cover a name or title.
function attachCoverEditor(frame, covers) {
  let start = null, box = null;
  const rel = e => {
    const r = frame.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  frame.addEventListener("pointerdown", e => {
    if (e.target.closest(".cover-x")) return;
    e.preventDefault();
    start = rel(e);
    box = document.createElement("span");
    box.className = "cover drawing";
    frame.appendChild(box);
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener("pointermove", e => {
    if (!start) return;
    const p = rel(e);
    const r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    Object.assign(box.style, { left: r.x * 100 + "%", top: r.y * 100 + "%", width: r.w * 100 + "%", height: r.h * 100 + "%" });
    box.dataset.r = JSON.stringify(r);
  });
  const end = () => {
    if (!start) return;
    const r = box && box.dataset.r ? JSON.parse(box.dataset.r) : null;
    start = null;
    if (box) box.remove();
    box = null;
    if (r && r.w > 0.015 && r.h > 0.015) { covers.push(r); renderMain(); }
  };
  frame.addEventListener("pointerup", end);
  frame.addEventListener("pointercancel", end);
}

// ---------------------------------------------------------------- Wikipedia search (for home-made prompts)

const WIKI = "https://en.wikipedia.org/w/api.php?";
const textOf = html => new DOMParser().parseFromString(html || "", "text/html").body.textContent || "";

async function wikiGet(params) {
  const r = await fetch(WIKI + new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params }));
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function wikiSearch(q) {
  const d = await wikiGet({ action: "query", list: "search", srsearch: q, srlimit: "8" });
  return d.query.search.map(s => ({ title: s.title, snippet: textOf(s.snippet) }));
}

async function wikiPage(title) {
  const d = await wikiGet({ action: "query", prop: "extracts|pageimages|info", titles: title, redirects: "1", exintro: "1",
    explaintext: "1", piprop: "thumbnail|name", pithumbsize: "1280", inprop: "url" });
  const p = d.query.pages[0];
  let image = null;
  if (p.thumbnail && p.pageimage) {
    image = { url: p.thumbnail.source, covers: [], credit: "", license: "", file_page: "" };
    try {
      const m = await wikiGet({ action: "query", prop: "imageinfo", titles: "File:" + p.pageimage, iiprop: "extmetadata|url",
        iiextmetadatafilter: "Artist|LicenseShortName" });
      const ii = m.query.pages[0].imageinfo && m.query.pages[0].imageinfo[0];
      if (ii) {
        const md = ii.extmetadata || {};
        image.credit = textOf(md.Artist && md.Artist.value).trim();
        image.license = (md.LicenseShortName && md.LicenseShortName.value) || "";
        image.file_page = ii.descriptionurl || "";
      }
    } catch { /* the credit is nice to have, not essential */ }
  }
  return { title: p.title, extract: p.extract || "", url: p.fullurl || "", image };
}

async function pickWiki(title) {
  ui.wiki = { ...(ui.wiki || {}), loadingPage: true };
  renderMain();
  try {
    const page = await wikiPage(title);
    ui.wiki.page = page;
    ui.wiki.results = null; // tuck the search results away so the picture is right there
    if (ui.draft) {
      ui.draft.source = { title: page.title, url: page.url };
      if (page.image) { ui.draft.image = page.image; ui.editCovers = false; }
      else toast("That page has no picture, but its summary is below to help with the true answer.");
    }
  } catch {
    toast("Couldn't load that page from Wikipedia.");
  }
  ui.wiki.loadingPage = false;
  if (S.phase === "pick") renderMain();
}
