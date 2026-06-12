/* Game table client: renders state pushes and answers prompts. */
const socket = io();
const $ = (id) => document.getElementById(id);

const code = location.pathname.split("/").pop().toUpperCase();
const token = sessionStorage.getItem(`msw:token:${code}`) || localStorage.getItem(`msw:token:${code}`);

const COLOR_HEX = {
  White: "#f3ead3",
  Blue: "#54a4e6",
  Black: "#a678e0",
  Red: "#ef6651",
  Green: "#5fc278",
};

let S = null; // latest state
let sel = new Set(); // current multi-select (iids)
let overlayMode = null; // 'browse' | 'pick'

if (!token) {
  document.body.innerHTML =
    '<main style="padding:80px;text-align:center;font-family:sans-serif"><h1>Not part of this game</h1><a href="/" style="color:#54a4e6">Back to the lobby</a></main>';
} else {
  socket.emit("attach", { code, token }, (res) => {
    if (!res?.ok) {
      alert(res?.error || "Could not attach to game.");
      location.href = "/";
    }
  });
  socket.on("connect", () => socket.emit("attach", { code, token }, () => {}));
}

socket.on("gameState", (state) => {
  S = state;
  render();
});

/* ---------------- rendering ---------------- */

function render() {
  if (!S) return;
  renderTopbar();
  renderOpponents();
  renderPiles();
  renderStatus();
  renderLog();
  renderMyMoods();
  renderHand();
  renderPrompt();
  renderGameOver();
}

function renderTopbar() {
  $("round-info").textContent = S.phase === "scoring" ? `Round ${S.round} — scoring` : `Round ${S.round}`;
  const doubt = $("doubt-banner");
  if (S.doubt && S.doubt.length) {
    doubt.hidden = false;
    doubt.textContent = `Doubt: no ${S.doubt.join("/")} moods this round`;
  } else doubt.hidden = true;

  const seats = $("seats");
  seats.innerHTML = "";
  for (const p of S.players) {
    const d = document.createElement("div");
    d.className = "seat" + (p.seat === S.activeSeat ? " active" : "") + (p.seat === S.seat ? " me" : "");
    d.innerHTML = `<span class="seat-name">${esc(p.name)}${p.seat === S.seat ? " (you)" : ""}</span>
      <span class="pips">${[0, 1, 2].map((i) => `<span class="pip${i < p.roundWins ? " won" : ""}"></span>`).join("")}</span>
      <span class="score">${p.score}</span>
      ${p.hurtFeelings ? '<span class="hf">HF</span>' : ""}`;
    seats.appendChild(d);
  }
}

function cardEl(c, { width, showValue = true, suppressible = true } = {}) {
  const d = document.createElement("div");
  d.className = "cardc";
  d.dataset.iid = c.iid;
  const img = document.createElement("img");
  // copies show the copied card's face
  img.src = c.copyImage || c.image;
  img.alt = c.copyName || c.name;
  img.loading = "lazy";
  d.appendChild(img);

  if (showValue && typeof c.value === "number") {
    const v = document.createElement("span");
    v.className = "vbadge";
    const base = c.copyOf ? null : c.primary;
    if (base != null && c.value > base) v.classList.add("boosted");
    if ((base != null && c.value < base) || c.suppressed) v.classList.add("nerfed");
    v.textContent = c.value;
    d.appendChild(v);
  }
  if (suppressible && c.suppressed) d.classList.add("suppressed");
  if (c.chosenColor) {
    const t = document.createElement("span");
    t.className = "tag";
    t.style.background = COLOR_HEX[c.chosenColor];
    t.textContent = c.chosenColor;
    d.appendChild(t);
  }
  if (c.copyOf) {
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = "copy";
    d.appendChild(t);
  }
  attachZoom(d, c);
  return d;
}

function renderMoodRow(container, moods, emptyText) {
  container.innerHTML = "";
  if (!moods.length) {
    const ph = document.createElement("span");
    ph.className = "placeholder";
    ph.textContent = emptyText;
    container.appendChild(ph);
    return;
  }
  for (const m of moods) container.appendChild(cardEl(m));
}

function renderOpponents() {
  const wrap = $("opponents");
  wrap.innerHTML = "";
  for (const p of S.players) {
    if (p.seat === S.seat) continue;
    const d = document.createElement("div");
    d.className = "opp" + (p.seat === S.activeSeat ? " active" : "");
    d.dataset.seat = p.seat;
    d.innerHTML = `<div class="opp-head"><span class="nm">${esc(p.name)}</span>
      <span class="hand-count">🂠 ${p.handCount} in hand</span>
      <span class="total">${p.score}</span></div>`;
    const row = document.createElement("div");
    row.className = "moodrow";
    renderMoodRow(row, p.moods, "no moods yet");
    d.appendChild(row);
    wrap.appendChild(d);
  }
}

function renderPiles() {
  $("deck-count").textContent = S.deckCount;
  $("discard-count").textContent = S.discard.length;
  const top = $("discard-top");
  top.innerHTML = "";
  if (S.discard.length) {
    top.classList.remove("empty");
    const c = S.discard[S.discard.length - 1];
    const img = document.createElement("img");
    img.src = c.image;
    img.alt = c.name;
    top.appendChild(img);
    top.onclick = () => openBrowse("Discard pile", S.discard.slice().reverse());
  } else {
    top.classList.add("empty");
    top.onclick = null;
  }
}

function renderStatus() {
  const el = $("status-line");
  const me = S.players.find((p) => p.seat === S.seat);
  if (S.phase === "over") {
    el.textContent = "";
    return;
  }
  if (S.prompt) {
    el.textContent = "Your move!";
    return;
  }
  if (S.waitingOn != null) {
    const who = S.players.find((p) => p.seat === S.waitingOn);
    el.innerHTML = `<span class="waiting">Waiting for ${esc(who?.name ?? "...")} …</span>`;
    return;
  }
  el.innerHTML = '<span class="waiting">…</span>';
}

let lastLogLen = 0;
function renderLog() {
  const ul = $("log");
  ul.innerHTML = "";
  for (const line of S.log) {
    const li = document.createElement("li");
    li.textContent = line;
    if (line.startsWith("— Round")) li.className = "round-marker";
    ul.appendChild(li);
  }
  if (S.log.length !== lastLogLen) {
    ul.scrollTop = ul.scrollHeight;
    lastLogLen = S.log.length;
  }
}

function renderMyMoods() {
  const me = S.players.find((p) => p.seat === S.seat);
  renderMoodRow($("my-moods"), me.moods, "your moods will appear here");
}

function renderHand() {
  const wrap = $("my-hand");
  wrap.innerHTML = "";
  for (const c of S.hand) wrap.appendChild(cardEl(c, { showValue: false }));
}

function renderGameOver() {
  const go = $("gameover");
  if (S.phase !== "over" || S.gameWinner == null) {
    go.hidden = true;
    return;
  }
  const w = S.players.find((p) => p.seat === S.gameWinner);
  go.hidden = false;
  const nm = $("winner-name");
  nm.innerHTML = "";
  [...w.name].forEach((ch, i) => {
    const s = document.createElement("span");
    s.textContent = ch === " " ? " " : ch;
    const colors = Object.values(COLOR_HEX);
    s.style.color = colors[i % colors.length];
    s.style.rotate = `${((i * 7) % 9) - 4}deg`;
    s.style.animationDelay = `${i * 0.06}s`;
    nm.appendChild(s);
  });
  $("winner-sub").textContent =
    S.gameWinner === S.seat ? "You won three rounds. Excellent mood management." : `${w.name} won three rounds.`;
}

/* ---------------- prompts ---------------- */

function clearPromptUI() {
  $("prompt-sheet").hidden = true;
  $("action-bar").innerHTML = "";
  sel = new Set();
  document.querySelectorAll(".cardc.eligible, .cardc.selected").forEach((el) => {
    el.classList.remove("eligible", "selected");
    el.onclick = null;
  });
  document.querySelectorAll(".opp.eligible").forEach((el) => el.classList.remove("eligible"));
  if (overlayMode === "pick") closeOverlay();
}

function answer(a) {
  clearPromptUI();
  socket.emit("promptAnswer", a);
}

function renderPrompt() {
  clearPromptUI();
  const p = S.prompt;
  if (!p) return;
  switch (p.type) {
    case "turn":
      return promptTurn(p);
    case "confirm":
      return promptSheet(p.text, [], [btn("Yes", () => answer({ yes: true }), "primary"), btn("No", () => answer({ yes: false }))]);
    case "chooseOption":
      return promptSheet(
        p.text,
        [],
        p.options.map((o) => btn(o.label, () => answer({ id: o.id })))
      );
    case "chooseColor":
      return promptSheet(
        p.text,
        p.colors.map((c) => {
          const b = document.createElement("button");
          b.className = "swatch";
          b.style.background = COLOR_HEX[c];
          b.title = c;
          b.onclick = () => answer({ color: c });
          return b;
        }),
        []
      );
    case "chooseNumber": {
      const btns = [];
      for (let n = p.min; n <= p.max; n++) {
        const b = document.createElement("button");
        b.className = "numbtn";
        b.textContent = n;
        b.onclick = () => answer({ number: n });
        btns.push(b);
      }
      return promptSheet(p.text, btns, []);
    }
    case "choosePlayers":
      return promptPlayers(p);
    case "chooseMoods":
      return promptMoods(p);
    case "chooseCards":
      return promptCards(p);
  }
}

function btn(label, onclick, cls = "") {
  const b = document.createElement("button");
  b.className = "pbtn " + cls;
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

function promptSheet(text, bodyEls, actionEls) {
  $("prompt-text").textContent = text;
  const body = $("prompt-body");
  const actions = $("prompt-actions");
  body.innerHTML = "";
  actions.innerHTML = "";
  bodyEls.forEach((e) => body.appendChild(e));
  actionEls.forEach((e) => actions.appendChild(e));
  $("prompt-sheet").hidden = false;
}

/* turn: highlight playable cards (hand + discard), pass button */
function promptTurn(p) {
  const playable = new Map(p.plays.map((pl) => [pl.iid, pl]));
  // hand cards
  markEligible(playable, $("my-hand"));
  // discard plays: badge on the discard pile + open browser
  const discardPlays = p.plays.filter((pl) => pl.zone === "discard");
  if (discardPlays.length) {
    const browseBtn = btn(`Play from discard (${discardPlays.length})`, () => {
      openPick(
        "Play a card from the discard pile",
        S.discard.filter((c) => playable.has(c.iid)),
        { min: 1, max: 1 },
        (iids) => sendPlay(playable.get(iids[0]))
      );
    });
    $("action-bar").appendChild(browseBtn);
  }
  const pass = btn(p.playedAnything ? "Done" : "Pass", () => answer({ action: "pass" }), "danger");
  pass.classList.add("cta-pass");
  const bar = $("action-bar");
  bar.appendChild(pass);
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = p.playedAnything ? "You may stop or keep playing extras." : "Play a card or pass.";
  bar.appendChild(hint);

  function markEligible(map, container) {
    container.querySelectorAll(".cardc").forEach((el) => {
      const iid = Number(el.dataset.iid);
      if (!map.has(iid)) return;
      el.classList.add("eligible");
      el.onclick = () => sendPlay(map.get(iid));
    });
  }

  function sendPlay(pl) {
    // the server picks the play slot, and prompts only when the choice
    // actually matters (e.g. Gluttony/Insecurity riders)
    answer({ action: "play", iid: pl.iid, grantId: null });
  }
}

/* choose moods on the table */
function promptMoods(p) {
  const eligible = new Set(p.eligible);
  document.querySelectorAll(".moodrow .cardc, .my-moods .cardc").forEach((el) => {
    const iid = Number(el.dataset.iid);
    if (!eligible.has(iid)) return;
    el.classList.add("eligible");
    el.onclick = () => {
      if (sel.has(iid)) sel.delete(iid);
      else if (sel.size < p.max) sel.add(iid);
      el.classList.toggle("selected", sel.has(iid));
      syncConfirm();
    };
  });
  const confirm = btn(p.max === 1 ? "Confirm" : `Confirm (0/${p.max})`, () => answer({ iids: [...sel] }), "primary");
  confirm.disabled = p.min > 0;
  const acts = [confirm];
  if (p.min === 0) acts.push(btn("Skip", () => answer({ iids: [] })));
  promptSheet(p.text + (p.maxTotal != null ? ` (total value ≤ ${p.maxTotal})` : ""), [], acts);

  function syncConfirm() {
    let total = 0;
    if (p.maxTotal != null) {
      for (const iid of sel) {
        const card = findCard(iid);
        total += card?.value ?? 0;
      }
    }
    const okTotal = p.maxTotal == null || total <= p.maxTotal;
    confirm.disabled = sel.size < p.min || !okTotal;
    confirm.textContent =
      (p.max === 1 ? "Confirm" : `Confirm (${sel.size}/${p.max})`) + (p.maxTotal != null ? ` — total ${total}` : "");
  }
}

/* choose cards from hand or discard */
function promptCards(p) {
  const eligible = new Set(p.eligible);
  if (p.zone === "hand") {
    document.querySelectorAll("#my-hand .cardc").forEach((el) => {
      const iid = Number(el.dataset.iid);
      if (!eligible.has(iid)) return;
      el.classList.add("eligible");
      el.onclick = () => {
        if (sel.has(iid)) sel.delete(iid);
        else if (sel.size < p.max) sel.add(iid);
        el.classList.toggle("selected", sel.has(iid));
        syncConfirm();
      };
    });
    const confirm = btn("Confirm", () => answer({ iids: [...sel] }), "primary");
    confirm.disabled = p.min > 0;
    const acts = [confirm];
    if (p.min === 0) acts.push(btn("Skip", () => answer({ iids: [] })));
    promptSheet(p.text, [], acts);
    var syncConfirm = () => {
      confirm.disabled = sel.size < p.min;
      confirm.textContent = p.max === 1 ? "Confirm" : `Confirm (${sel.size}/${p.max})`;
    };
    syncConfirm();
  } else {
    // discard zone: open the overlay picker
    const cardsInZone = S.discard.filter((c) => eligible.has(c.iid));
    openPick(p.text, cardsInZone, p, (iids) => answer({ iids }));
    if (p.min === 0) {
      promptSheet(p.text, [], [btn("Skip", () => answer({ iids: [] })), btn("Browse discard", () => openPick(p.text, cardsInZone, p, (iids) => answer({ iids })))]);
    }
  }
}

function promptPlayers(p) {
  const eligible = new Set(p.eligible);
  const picked = new Set();
  const btns = [];
  for (const pl of S.players) {
    if (!eligible.has(pl.seat)) continue;
    const b = btn(pl.seat === S.seat ? `${pl.name} (you)` : pl.name, () => {
      if (picked.has(pl.seat)) picked.delete(pl.seat);
      else if (picked.size < p.max) picked.add(pl.seat);
      b.classList.toggle("primary", picked.has(pl.seat));
      confirm.disabled = picked.size < p.min;
      if (p.max === 1 && picked.size === 1) answer({ seats: [...picked] });
    });
    b.classList.add("playerbtn");
    btns.push(b);
  }
  const confirm = btn("Confirm", () => answer({ seats: [...picked] }), "primary");
  confirm.disabled = p.min > 0;
  const acts = p.max === 1 ? [] : [confirm];
  if (p.min === 0) acts.push(btn(p.max === 1 ? "Skip" : "Choose none", () => answer({ seats: [] })));
  promptSheet(p.text, btns, acts);
}

/* ---------------- overlay (browse & pick) ---------------- */

function openBrowse(title, cardsList) {
  overlayMode = "browse";
  $("overlay-title").textContent = title;
  const grid = $("overlay-grid");
  grid.innerHTML = "";
  $("overlay-actions").innerHTML = "";
  for (const c of cardsList) grid.appendChild(cardEl(c, { showValue: false, suppressible: false }));
  $("overlay").hidden = false;
}

function openPick(title, cardsList, { min = 1, max = 1 }, onDone) {
  overlayMode = "pick";
  $("overlay-title").textContent = title;
  const grid = $("overlay-grid");
  grid.innerHTML = "";
  const picked = new Set();
  const acts = $("overlay-actions");
  acts.innerHTML = "";
  const confirm = btn("Confirm", () => {
    closeOverlay();
    onDone([...picked]);
  }, "primary");
  confirm.disabled = min > 0;

  for (const c of cardsList) {
    const el = cardEl(c, { showValue: false, suppressible: false });
    el.classList.add("eligible");
    el.onclick = () => {
      if (picked.has(c.iid)) picked.delete(c.iid);
      else if (picked.size < max) picked.add(c.iid);
      el.classList.toggle("selected", picked.has(c.iid));
      confirm.disabled = picked.size < min;
      if (max === 1 && picked.size === 1) confirm.click();
    };
    grid.appendChild(el);
  }
  if (min === 0) acts.appendChild(btn("Skip", () => { closeOverlay(); onDone([]); }));
  acts.appendChild(confirm);
  $("overlay").hidden = false;
}

function closeOverlay() {
  $("overlay").hidden = true;
  overlayMode = null;
}
$("overlay-close").onclick = () => {
  // closing a pick overlay just hides it; the prompt sheet (if any) can reopen it
  $("overlay").hidden = true;
  if (overlayMode === "pick" && S?.prompt?.type === "chooseCards" && S.prompt.min === 0) {
    // leave the skip sheet visible
  }
  overlayMode = null;
};

/* ---------------- zoom ---------------- */

function attachZoom(el, c) {
  el.addEventListener("mouseenter", (e) => {
    const z = $("zoom");
    $("zoom-img").src = c.copyImage || c.image;
    const meta = [];
    if (c.copyOf) meta.push(`Copy of ${c.copyName}`);
    if (typeof c.value === "number") meta.push(`Current value: ${c.value}`);
    if (c.suppressed) meta.push("SUPPRESSED (value 0)");
    if (c.chosenColor) meta.push(`Chosen color: ${c.chosenColor}`);
    $("zoom-meta").textContent = meta.join(" · ");
    $("zoom-meta").style.display = meta.length ? "block" : "none";
    z.hidden = false;
    positionZoom(e);
  });
  el.addEventListener("mousemove", positionZoom);
  el.addEventListener("mouseleave", () => ($("zoom").hidden = true));
}

function positionZoom(e) {
  const z = $("zoom");
  const pad = 18;
  let x = e.clientX + pad;
  let y = Math.min(e.clientY - 120, window.innerHeight - 420);
  if (x + 290 > window.innerWidth) x = e.clientX - 290 - pad;
  z.style.left = `${x}px`;
  z.style.top = `${Math.max(10, y)}px`;
}

/* ---------------- util ---------------- */

function findCard(iid) {
  for (const p of S.players) {
    const m = p.moods.find((c) => c.iid === iid);
    if (m) return m;
  }
  return S.hand.find((c) => c.iid === iid) || S.discard.find((c) => c.iid === iid) || null;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
