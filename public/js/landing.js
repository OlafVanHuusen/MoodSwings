/* Landing page: account bar, lobby (create/join), waiting room */
const socket = io();

const $ = (id) => document.getElementById(id);
const viewLobby = $("view-lobby");
const viewWait = $("view-wait");

let myRoom = null; // {code, token}
let me = null; // {id, username} | null
let myDecks = []; // [{id, name, cards}]
let mode = "classic";
let playerCount = 2;
let deckMode = "random45";
let lastLobby = [];

const MODE_INFO = {
  classic: { players: [2, 3, 4], deckmode: true, needsDeck: false, auth: false,
    note: "The base game — one shared deck, 2–4 players." },
  structure: { players: [2], needsDeck: true, auth: true,
    note: "Bring your own deck of 45+ cards (build one under “My decks”). Both players need an account and a legal deck." },
  power: { players: [2], needsDeck: true, auth: true,
    note: "Bring your own deck: 12+ cards, max one copy of each. The most competitive way to play." },
  quickdraft: { players: [2], auth: true,
    note: "Start with nothing: draft 16 cards by picking and passing, then play best of three with sideboarding." },
  winston: { players: [2], auth: true,
    note: "Draft from three hidden piles (or gamble on the deck), then play best of three with sideboarding." },
  "team-open": { players: [4], deckmode: true, auth: true,
    note: "2 vs 2 with open hands between teammates. Join order decides teams: seats 1 & 2 vs seats 3 & 4." },
  "team-closed": { players: [4], deckmode: true, auth: true,
    note: "2 vs 2, hands hidden — you pass two cards to your teammate at the start. Join order alternates teams: seats 1 & 3 vs seats 2 & 4." },
};

// remember name
const savedName = localStorage.getItem("msw:name") || "";
$("create-name").value = savedName;
$("join-name").value = savedName;
const rememberName = (n) => localStorage.setItem("msw:name", n);

/* ---------------- account ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Request failed.");
  return body;
}

async function refreshAuth() {
  try {
    me = (await api("/me")).user;
  } catch {
    me = null;
  }
  $("auth-out").hidden = !!me;
  $("auth-in").hidden = !me;
  if (me) $("auth-name").textContent = me.username;
  myDecks = [];
  if (me) {
    try {
      myDecks = (await api("/decks")).decks;
    } catch {}
  }
  renderDeckSelects();
  renderModeAvailability();
  renderLobbyList(lastLobby);
}

async function doAuth(path) {
  const username = $("auth-user").value.trim();
  const password = $("auth-pass").value;
  const err = $("auth-error");
  err.hidden = true;
  try {
    await api(path, { method: "POST", body: JSON.stringify({ username, password }) });
    $("auth-pass").value = "";
    // reconnect so the socket picks up the fresh session cookie
    socket.disconnect().connect();
    await refreshAuth();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

$("btn-login").onclick = () => doAuth("/login");
$("btn-register").onclick = () => doAuth("/register");
$("auth-pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doAuth("/login");
});
$("btn-logout").onclick = async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  socket.disconnect().connect();
  await refreshAuth();
};

/* ---------------- decks in selects ---------------- */

function deckLegal(deck, m) {
  if (m === "structure") return deck.cards.length >= 45;
  if (m === "power") return deck.cards.length >= 12 && new Set(deck.cards).size === deck.cards.length;
  return true;
}

function deckLabel(deck, m) {
  let tag = "";
  if (m === "structure" && deck.cards.length < 45) tag = " — too small (45 needed)";
  if (m === "power") {
    if (deck.cards.length < 12) tag = " — too small (12 needed)";
    else if (new Set(deck.cards).size !== deck.cards.length) tag = " — has duplicates";
  }
  return `${deck.name} (${deck.cards.length} cards)${tag}`;
}

function renderDeckSelects() {
  for (const [selId, m] of [
    ["create-deck", null],
    ["join-deck", null],
  ]) {
    const sel = $(selId);
    sel.innerHTML = "";
    if (!myDecks.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "no decks yet — build one under “My decks”";
      sel.appendChild(o);
      continue;
    }
    for (const d of myDecks) {
      const o = document.createElement("option");
      o.value = d.id;
      o.textContent = deckLabel(d, selId === "create-deck" ? mode : null);
      sel.appendChild(o);
    }
  }
  $("field-join-deck").hidden = !me || !myDecks.length || !lastLobby.some((g) => g.needsDeck);
}

/* ---------------- mode picker ---------------- */

function renderModeAvailability() {
  document.querySelectorAll("#mode-grid button").forEach((b) => {
    const locked = b.dataset.auth && !me;
    b.classList.toggle("locked", !!locked);
    b.title = locked ? "Log in to play this mode" : "";
  });
  if (MODE_INFO[mode].auth && !me) pickMode("classic");
}

function pickMode(m) {
  mode = m;
  document.querySelectorAll("#mode-grid button").forEach((b) => b.classList.toggle("on", b.dataset.v === m));
  const info = MODE_INFO[m];
  $("mode-note").textContent = info.note;
  $("field-players").hidden = info.players.length === 1;
  if (!info.players.includes(playerCount)) {
    playerCount = info.players[0];
    document.querySelectorAll("#seg-players button").forEach((b) =>
      b.classList.toggle("on", Number(b.dataset.v) === playerCount)
    );
  }
  $("field-deckmode").hidden = !info.deckmode;
  $("field-deck").hidden = !info.needsDeck;
  if (info.needsDeck) {
    renderDeckSelects();
    $("create-deck-hint").textContent =
      m === "structure" ? "Structure Duel needs 45+ cards." : "Power Duel needs 12+ cards, max one of each.";
  }
}

$("mode-grid").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.auth && !me) {
    $("create-error").textContent = "Log in (top of the page) to unlock this mode.";
    $("create-error").hidden = false;
    return;
  }
  $("create-error").hidden = true;
  pickMode(b.dataset.v);
});

// segmented controls
function seg(el, onPick) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onPick(b.dataset.v);
  });
}
seg($("seg-players"), (v) => (playerCount = Number(v)));
seg($("seg-deck"), (v) => (deckMode = v));

/* ---------------- lobby ---------------- */

socket.emit("enterLobby");
socket.on("connect", () => {
  if (!myRoom) socket.emit("enterLobby");
});

socket.on("lobbyList", (list) => {
  lastLobby = list;
  renderLobbyList(list);
});

function renderLobbyList(list) {
  const ul = $("open-list");
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML = '<li class="empty">No one is waiting yet…</li>';
    $("field-join-deck").hidden = true;
    return;
  }
  for (const g of list) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "game-row";
    const locked = g.needsAuth && !me;
    const detail = g.mode === "classic" ? (g.deckMode === "full" ? "all 133" : "random 45") : g.modeLabel.toLowerCase();
    btn.innerHTML = `<strong>${esc(g.hostName)}'s table${locked ? " 🔒" : ""}</strong>
      <span class="meta">${esc(g.modeLabel)} · ${g.joined}/${g.playerCount} players · ${detail} · ${g.code}</span>`;
    btn.onclick = () => {
      if (locked) {
        showJoinError("Log in (top of the page) to join this mode.");
        return;
      }
      joinByCode(g.code, g.needsDeck);
    };
    li.appendChild(btn);
    ul.appendChild(li);
  }
  $("field-join-deck").hidden = !me || !myDecks.length || !list.some((g) => g.needsDeck && g.joined < g.playerCount);
}

$("btn-create").onclick = () => {
  const name = $("create-name").value.trim() || me?.username || "Player";
  rememberName(name);
  const payload = { name, mode, playerCount, deckMode };
  if (MODE_INFO[mode].needsDeck) {
    const deckId = Number($("create-deck").value);
    const deck = myDecks.find((d) => d.id === deckId);
    if (!deck || !deckLegal(deck, mode)) {
      $("create-error").textContent = deck
        ? "That deck isn't legal for this format."
        : "Build a deck first (My decks, top of the page).";
      $("create-error").hidden = false;
      return;
    }
    payload.deckId = deckId;
  }
  $("create-error").hidden = true;
  socket.emit("createGame", payload, (res) => {
    if (res?.ok) return enterWaitRoom(res.code, res.token);
    $("create-error").textContent = res?.error || "Could not create the game.";
    $("create-error").hidden = false;
  });
};

$("btn-join").onclick = () => joinByCode($("join-code").value.trim().toUpperCase(), null);
$("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-join").click();
});

function showJoinError(msg) {
  const err = $("join-error");
  err.textContent = msg;
  err.hidden = false;
}

function joinByCode(code, needsDeck) {
  if (!code) return;
  const name = $("join-name").value.trim() || $("create-name").value.trim() || me?.username || "Player";
  rememberName(name);
  const payload = { code, name };
  // a deck is sent along whenever we have one selected; the server only uses
  // (and validates) it for duel tables
  if (needsDeck !== false && myDecks.length) payload.deckId = Number($("join-deck").value);
  socket.emit("joinGame", payload, (res) => {
    if (!res?.ok) return showJoinError(res?.error || "Could not join.");
    $("join-error").hidden = true;
    enterWaitRoom(res.code, res.token);
  });
}

/* ---------------- waiting room ---------------- */

function enterWaitRoom(code, token) {
  myRoom = { code, token };
  // sessionStorage is per-tab: lets two players share one browser
  sessionStorage.setItem(`msw:token:${code}`, token);
  viewLobby.hidden = true;
  viewWait.hidden = false;
  $("wait-code").textContent = code;
}

socket.on("roomState", (rs) => {
  if (!myRoom || rs.code !== myRoom.code) return;
  $("wait-mode").textContent =
    rs.modeLabel +
    (rs.teamPattern === "adjacent"
      ? " — seats 1 & 2 vs seats 3 & 4"
      : rs.teamPattern === "across"
        ? " — seats 1 & 3 vs seats 2 & 4"
        : "");
  const ul = $("wait-players");
  ul.innerHTML = "";
  for (let i = 0; i < rs.playerCount; i++) {
    const li = document.createElement("li");
    const p = rs.players[i];
    if (p) {
      li.textContent = p.name;
      li.style.animationDelay = `${i * 0.08}s`;
    } else {
      li.textContent = "empty seat";
      li.className = "empty-seat";
    }
    if (rs.teams) {
      const team = rs.teamPattern === "adjacent" ? (i < 2 ? 0 : 1) : i % 2;
      li.classList.add(`team-${team}`);
    }
    ul.appendChild(li);
  }
});

socket.on("gameStarted", ({ code, token }) => {
  if (!myRoom || code !== myRoom.code) return;
  sessionStorage.setItem(`msw:token:${code}`, token);
  location.href = `/game/${code}`;
});

$("btn-leave").onclick = () => {
  socket.emit("leaveRoom");
  myRoom = null;
  viewWait.hidden = true;
  viewLobby.hidden = false;
  socket.emit("enterLobby");
};

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

refreshAuth();
pickMode("classic");
