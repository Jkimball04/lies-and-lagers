// A player's phone: join, type an answer, type a vote. It never shows pictures,
// prompts or anyone else's answers; those are for the TV and the host.

import { esc, param, netMode, storage, session, keepAwake, cleanName, ordinal, listNames, pageUrl, rulesHTML } from "./common.js";
import { clientNet } from "./net.js";

const mode = netMode();
const app = document.getElementById("app");
let room = (param("room") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
let name = storage.get("ll-name", "");
let pid = room ? session.get("ll-pid-" + room) : null;
let net = null, view = null, status = "", joined = false, renderedKey = "";
let draft = "", voteDraft = "", draftTimer = null, flashTimer = null;

if (room && pid && name) { app.innerHTML = shell(`<p class="phbig">Rejoining…</p>`); connect(); } else joinScreen();

// ---------------------------------------------------------------- joining

function joinScreen(msg = "") {
  joined = false;
  renderedKey = "";
  const hostLink = pageUrl("host.html", { net: mode === "local" ? "local" : null });
  app.innerHTML = `<div class="join"><h1>Lies <span>&amp;</span> Lagers</h1><p class="muted">The game of believable lies.</p>
    <form id="joinform">
      <label>Room code<input name="room" maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false" value="${esc(room)}" required></label>
      <label>Your name<input name="name" maxlength="16" autocomplete="nickname" value="${esc(name)}" required></label>
      <button class="btn big">Join the game</button></form>
    ${msg ? `<p class="alert">${esc(msg)}</p>` : ""}
    <p class="phnote">Hosting? Open <a href="${esc(hostLink)}">the host screen</a> on your laptop.</p></div>`;
  document.getElementById("joinform").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    const r = f.room.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    const n = cleanName(f.name.value);
    if (r.length !== 4) return joinScreen("Room codes are 4 letters. Check the TV.");
    if (!n) return joinScreen("Type your name so everyone knows who's who.");
    if (r !== room) pid = session.get("ll-pid-" + r);
    room = r;
    name = n;
    storage.set("ll-name", name);
    app.innerHTML = shell(`<p class="phbig">Joining…</p><p class="muted">Looking for room ${esc(room)}.</p>`);
    connect();
  });
}

function connect() {
  if (net) net.close();
  net = clientNet(room, mode, {
    onOpen() { net.send({ t: "hello", pid, name }); },
    onMessage: handle,
    onClose() { setStatus("reconnecting"); },
    onStatus: setStatus,
  });
}

function handle(m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "ping") { net.send({ t: "pong" }); return; }
  if (m.t === "welcome") {
    pid = m.pid;
    name = m.name;
    session.set("ll-pid-" + room, pid);
    joined = true;
    keepAwake();
    render(true);
    return;
  }
  if (m.t === "reject" || m.t === "removed") {
    session.del("ll-pid-" + room);
    pid = null;
    if (net) net.close();
    net = null;
    joinScreen(m.t === "removed" ? "The host took you out of the game." : m.reason);
    return;
  }
  if (m.t === "view") { view = m.view; render(); }
}

function setStatus(s) {
  status = s;
  const b = document.getElementById("banner");
  if (b) b.textContent = bannerText();
}

function bannerText() {
  if (status === "online" || status === "") return "";
  if (status === "no-host") return `Can't find room ${room} right now. Is the host's screen open? Trying again…`;
  if (status === "connecting" && !joined) return "";
  return "Reconnecting…";
}

// ---------------------------------------------------------------- drawing the phone

function shell(body) {
  const v = view;
  return `<div class="banner" id="banner">${esc(bannerText())}</div>
    <div class="phtop"><div class="phbrand">Lies <span>&amp;</span> Lagers</div>
      <div class="phme"><b>${esc(name)}</b>${v && joined ? `<br>${v.score} point${v.score === 1 ? "" : "s"}` : ""}</div></div>
    <div id="flash"></div>
    <div class="phbody">${body}</div>`;
}

function render(force = false) {
  if (!joined) return;
  const v = view;
  // Only redraw when something that matters changed, so we never wipe what someone is typing.
  const key = v ? [v.phase, v.round, v.score, v.rank, v.answer && v.answer.submitted, v.canVote,
    v.vote && v.vote.submitted, v.vote && v.vote.sentBack].join("|") : "none";
  if (!force && key === renderedKey) return;
  const ta = document.getElementById("ans");
  if (ta) draft = ta.value;
  const vi = document.getElementById("vote");
  if (vi) voteDraft = vi.value;
  renderedKey = key;
  if (v && v.phase !== "writing") draft = "";
  if (v && v.phase !== "voting") voteDraft = "";
  app.innerHTML = shell(body(v));
  wire(v);
}

const standing = v => `<p class="muted">You're in ${ordinal(v.rank)} place with ${v.score} point${v.score === 1 ? "" : "s"}.</p>`;

function body(v) {
  if (!v) return `<p class="phbig">You're in!</p><p class="muted">Waiting for the host…</p>`;
  const cat = v.category ? `<div class="phcat">${esc(v.category)}</div>` : "";
  switch (v.phase) {
    case "lobby":
      return `<p class="phbig">You're in, ${esc(name)}! 🍺</p><p class="muted">Keep an eye on the TV. The game starts when the host is ready.</p>`;
    case "rules":
      return `<p class="phbig">How to play</p>${rulesHTML()}<p class="muted">${v.total || 13} rounds. Most points wins.</p>`;
    case "between":
      return `<p class="phbig">${v.round ? `Round ${v.round + 1}${v.total ? ` of ${v.total}` : ""} is coming up` : "Get ready!"}</p><p class="muted">Eyes on the TV.</p>${v.round ? standing(v) : ""}`;
    case "late":
      return `<p class="phbig">You're in from the next round</p><p class="muted">This round started before you joined. Sit tight!</p>`;
    case "sitout":
      return `${cat}<p class="phbig">You're sitting this one out</p><p class="muted">No answering or voting this round. Enjoy the show.</p>`;
    case "writing":
      if (v.answer && v.answer.submitted) {
        return `${cat}<p class="phbig">Answer sent ✓</p><p class="muted">Now look innocent.</p><div class="phsent">${esc(v.answer.text)}</div>`;
      }
      return `${cat}<p class="phbig">Make up an answer that sounds true</p><p class="muted">Listen to the host for the question.</p>
        <textarea id="ans" maxlength="160" placeholder="Type your answer…" autocomplete="off"></textarea>
        <button class="btn big" id="send" type="button">Send answer</button>
        <p class="phnote">The host can see your answer as you type it.</p>`;
    case "reading":
      return `${cat}<p class="phbig">Listen to the host 👂</p><p class="muted">Remember which answer you think is the true one.</p>`;
    case "voting":
      if (!v.canVote) return `${cat}<p class="phbig">Sit tight</p><p class="muted">You're not voting this round. Watch the TV for the reveal.</p>`;
      if (v.vote && v.vote.submitted) {
        return `${cat}<p class="phbig">Vote sent ✓</p><div class="phsent">${esc(v.vote.text)}</div><p class="muted">Watch the TV for the reveal.</p>`;
      }
      return `${cat}${v.vote && v.vote.sentBack ? `<p class="alert">The host needs you to be more specific!${v.vote.lastText ? ` You said “${esc(v.vote.lastText)}”.` : ""}</p>` : ""}
        <p class="phbig">Which answer is true?</p><p class="muted">Type a word or two so the host knows which answer you mean.</p>
        <input id="vote" maxlength="80" placeholder="e.g. the swamp one" autocomplete="off">
        <button class="btn big" id="sendvote" type="button">Send vote</button>`;
    case "reveal": {
      const r = v.result || {};
      const lines = [];
      if (r.wroteTrue) lines.push("You wrote the true answer! +1");
      if (r.guessedRight) lines.push("You picked the true answer! +1");
      else if (r.picked) lines.push(`You fell for ${esc(r.picked)}'s answer.`);
      if (r.fooled && r.fooled.length) lines.push(`You fooled ${esc(listNames(r.fooled))}! +${r.fooled.length}`);
      return `${cat}<div class="phdelta">${r.delta > 0 ? "+" + r.delta : "0"}</div><p class="muted">points this round</p>
        ${lines.map(l => `<p>${l}</p>`).join("")}${standing(v)}`;
    }
    case "scores":
      return `<p class="phbig">Scores are on the TV</p>${standing(v)}`;
    case "final":
      return `<p class="phbig">Game over!</p>${v.rank === 1 ? `<p class="phdelta">🏆</p><p>You won!</p>` : ""}${standing(v)}`;
  }
  return "";
}

function wire(v) {
  const ta = document.getElementById("ans");
  if (ta) {
    ta.value = draft || (v.answer && v.answer.text) || "";
    ta.addEventListener("input", () => { draft = ta.value; queueDraft(); });
    const send = document.getElementById("send");
    send.addEventListener("click", () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      clearTimeout(draftTimer); draftTimer = null;
      if (!net || !net.send({ t: "submit", text })) { flash("Not connected yet. Try again in a moment."); return; }
      send.disabled = true;
      setTimeout(() => { if (document.body.contains(send)) send.disabled = false; }, 5000);
    });
  }
  const vi = document.getElementById("vote");
  if (vi) {
    vi.value = voteDraft;
    vi.addEventListener("input", () => { voteDraft = vi.value; });
    const btn = document.getElementById("sendvote");
    const sendVote = () => {
      const text = vi.value.trim();
      if (!text) { vi.focus(); return; }
      if (!net || !net.send({ t: "vote", text })) { flash("Not connected yet. Try again in a moment."); return; }
      btn.disabled = true;
      setTimeout(() => { if (document.body.contains(btn)) btn.disabled = false; }, 5000);
    };
    btn.addEventListener("click", sendVote);
    vi.addEventListener("keydown", e => { if (e.key === "Enter") sendVote(); });
  }
}

function queueDraft() {
  if (draftTimer) return;
  draftTimer = setTimeout(() => { draftTimer = null; if (net) net.send({ t: "draft", text: draft }); }, 250);
}

function flash(msg) {
  const f = document.getElementById("flash");
  if (!f) return;
  f.innerHTML = `<p class="alert">${esc(msg)}</p>`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { f.innerHTML = ""; }, 3500);
}
