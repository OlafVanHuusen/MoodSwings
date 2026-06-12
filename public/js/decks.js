/* Deck builder: list, edit, save decks (no construction restrictions). */
const $ = (id) => document.getElementById(id);

let me = null;
let catalog = []; // all 133 cards
let decks = [];
let current = null; // {id|null, name, cards: [num,...]}
let dirty = false;
let colorFilter = "";

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Request failed.");
  return body;
}

async function init() {
  me = (await api("/me").catch(() => ({ user: null }))).user;
  if (!me) {
    location.href = "/";
    return;
  }
  $("deck-user").textContent = me.username;
  catalog = (await api("/cards")).cards;
  decks = (await api("/decks")).decks;
  renderDeckList();
  renderPool();
  if (decks.length) openDeck(decks[0]);
}

/* ---------------- deck list ---------------- */

function renderDeckList() {
  const ul = $("deck-list");
  ul.innerHTML = "";
  if (!decks.length) {
    ul.innerHTML = '<li class="empty">No decks yet.</li>';
  }
  for (const d of decks) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "deck-row" + (current && current.id === d.id ? " on" : "");
    btn.innerHTML = `<strong>${esc(d.name)}</strong><span class="meta">${d.cards.length} cards${formatTags(d.cards)}</span>`;
    btn.onclick = () => confirmDiscard(() => openDeck(d));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function formatTags(cardNums) {
  const tags = [];
  if (cardNums.length >= 45) tags.push("Structure ✓");
  if (cardNums.length >= 12 && new Set(cardNums).size === cardNums.length) tags.push("Power ✓");
  return tags.length ? " · " + tags.join(" · ") : "";
}

function confirmDiscard(fn) {
  if (dirty && !confirm("Discard unsaved changes to this deck?")) return;
  fn();
}

$("btn-new-deck").onclick = () =>
  confirmDiscard(() => {
    current = { id: null, name: "", cards: [] };
    dirty = true;
    renderEditor();
    renderDeckList();
    $("deck-name").focus();
  });

function openDeck(d) {
  current = { id: d.id, name: d.name, cards: [...d.cards] };
  dirty = false;
  renderEditor();
  renderDeckList();
}

/* ---------------- editor ---------------- */

function renderEditor() {
  const has = !!current;
  $("deck-editor").hidden = !has;
  $("deck-empty").hidden = has;
  if (!has) return;
  $("deck-name").value = current.name;
  renderCurrentCards();
  renderStats();
}

function renderStats() {
  const n = current.cards.length;
  const rarities = { Common: 0, Uncommon: 0, Rare: 0, Mythic: 0 };
  for (const num of current.cards) {
    const c = catalog.find((x) => x.num === num);
    if (c) rarities[c.rarity]++;
  }
  $("deck-count").textContent =
    `${n} card${n === 1 ? "" : "s"} — ${rarities.Common}C / ${rarities.Uncommon}U / ${rarities.Rare}R / ${rarities.Mythic}M`;
  const tags = [];
  tags.push(n >= 45 ? "Structure ✓" : `Structure needs ${45 - n} more`);
  if (n >= 12 && new Set(current.cards).size === current.cards.length) tags.push("Power ✓");
  else if (n < 12) tags.push(`Power needs ${12 - n} more`);
  else tags.push("Power ✗ (duplicates)");
  $("deck-formats").textContent = tags.join(" · ");
}

function cardTile(c, count, onclick) {
  const d = document.createElement("div");
  d.className = "cardc pool-card";
  d.dataset.num = c.num;
  const img = document.createElement("img");
  img.src = c.image;
  img.alt = c.name;
  img.loading = "lazy";
  d.appendChild(img);
  if (count > 0) {
    const b = document.createElement("span");
    b.className = "vbadge boosted";
    b.textContent = count > 1 ? `×${count}` : "✓";
    d.appendChild(b);
  }
  d.onclick = onclick;
  attachZoom(d, c);
  return d;
}

function renderCurrentCards() {
  const wrap = $("deck-cards");
  wrap.innerHTML = "";
  if (!current.cards.length) {
    wrap.innerHTML = '<span class="placeholder">empty — add cards from the pool below</span>';
    return;
  }
  // group duplicates, keep catalog order
  const counts = new Map();
  for (const num of current.cards) counts.set(num, (counts.get(num) || 0) + 1);
  for (const c of catalog) {
    if (!counts.has(c.num)) continue;
    wrap.appendChild(
      cardTile(c, counts.get(c.num), () => {
        current.cards.splice(current.cards.indexOf(c.num), 1);
        dirty = true;
        renderCurrentCards();
        renderStats();
        syncPoolBadges();
      })
    );
  }
}

function renderPool() {
  const wrap = $("card-pool");
  wrap.innerHTML = "";
  const q = $("card-search").value.trim().toLowerCase();
  for (const c of catalog) {
    if (colorFilter && c.color !== colorFilter) continue;
    if (q && !c.name.toLowerCase().includes(q) && !(c.effect || "").toLowerCase().includes(q)) continue;
    const count = current ? current.cards.filter((n) => n === c.num).length : 0;
    wrap.appendChild(
      cardTile(c, count, () => {
        if (!current) return;
        current.cards.push(c.num);
        dirty = true;
        renderCurrentCards();
        renderStats();
        syncPoolBadges();
      })
    );
  }
}

/** Update count badges in the pool without rebuilding (keeps scroll position). */
function syncPoolBadges() {
  document.querySelectorAll("#card-pool .pool-card").forEach((el) => {
    const num = Number(el.dataset.num);
    const count = current ? current.cards.filter((n) => n === num).length : 0;
    el.querySelector(".vbadge")?.remove();
    if (count > 0) {
      const b = document.createElement("span");
      b.className = "vbadge boosted";
      b.textContent = count > 1 ? `×${count}` : "✓";
      el.appendChild(b);
    }
  });
}

$("card-search").addEventListener("input", renderPool);
$("seg-color").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  document.querySelectorAll("#seg-color button").forEach((x) => x.classList.toggle("on", x === b));
  colorFilter = b.dataset.v;
  renderPool();
});

$("deck-name").addEventListener("input", () => {
  if (current) {
    current.name = $("deck-name").value;
    dirty = true;
  }
});

$("btn-save-deck").onclick = async () => {
  if (!current) return;
  const err = $("deck-error");
  err.hidden = true;
  const payload = { name: current.name.trim() || "Untitled deck", cards: current.cards };
  try {
    const saved =
      current.id == null
        ? (await api("/decks", { method: "POST", body: JSON.stringify(payload) })).deck
        : (await api(`/decks/${current.id}`, { method: "PUT", body: JSON.stringify(payload) })).deck;
    decks = (await api("/decks")).decks;
    dirty = false;
    openDeck(decks.find((d) => d.id === saved.id) ?? saved);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
};

$("btn-delete-deck").onclick = async () => {
  if (!current) return;
  if (current.id != null) {
    if (!confirm(`Delete deck “${current.name || "Untitled deck"}”?`)) return;
    await api(`/decks/${current.id}`, { method: "DELETE" }).catch(() => {});
    decks = (await api("/decks")).decks;
  }
  current = null;
  dirty = false;
  renderEditor();
  renderDeckList();
}

/* ---------------- zoom (same pattern as the table) ---------------- */

function attachZoom(el, c) {
  el.addEventListener("mouseenter", (e) => {
    $("zoom-img").src = c.image;
    $("zoom-meta").textContent = `${c.name} · ${c.color} · ${c.rarity} · value ${c.primary}${c.secondary != null ? `/${c.secondary}` : ""}`;
    $("zoom").hidden = false;
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

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

init();
