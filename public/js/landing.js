/* Landing page: lobby (create/join) + waiting room */
const socket = io();

const $ = (id) => document.getElementById(id);
const viewLobby = $("view-lobby");
const viewWait = $("view-wait");

let myRoom = null; // {code, token}
let playerCount = 2;
let deckMode = "random45";

// remember name
const savedName = localStorage.getItem("msw:name") || "";
$("create-name").value = savedName;
$("join-name").value = savedName;
const rememberName = (n) => localStorage.setItem("msw:name", n);

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

socket.emit("enterLobby");

socket.on("lobbyList", (list) => {
  const ul = $("open-list");
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML = '<li class="empty">No one is waiting yet…</li>';
    return;
  }
  for (const g of list) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "game-row";
    btn.innerHTML = `<strong>${esc(g.hostName)}'s table</strong>
      <span class="meta">${g.joined}/${g.playerCount} players · ${g.deckMode === "full" ? "all 133" : "random 45"} · ${g.code}</span>`;
    btn.onclick = () => joinByCode(g.code);
    li.appendChild(btn);
    ul.appendChild(li);
  }
});

$("btn-create").onclick = () => {
  const name = $("create-name").value.trim() || "Player";
  rememberName(name);
  socket.emit("createGame", { name, playerCount, deckMode }, (res) => {
    if (res?.ok) enterWaitRoom(res.code, res.token);
  });
};

$("btn-join").onclick = () => joinByCode($("join-code").value.trim().toUpperCase());
$("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-join").click();
});

function joinByCode(code) {
  if (!code) return;
  const name = $("join-name").value.trim() || $("create-name").value.trim() || "Player";
  rememberName(name);
  socket.emit("joinGame", { code, name }, (res) => {
    const err = $("join-error");
    if (!res?.ok) {
      err.textContent = res?.error || "Could not join.";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    enterWaitRoom(res.code, res.token);
  });
}

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
