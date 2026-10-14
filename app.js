import { SEED, SEED_VERSION, SKILLS } from "./seed.js";

/* =========================================================
   Storage
   ========================================================= */
const KEY = "playroom.v1";

const DEFAULT_SETTINGS = {
  name: "Mer",
  birthdate: "2026-02-23",
  windowTarget: 150,   // minutes awake per window
  playMinutes: 45,     // planned activity minutes per window when filling
  windowsPerDay: 4,
};

function freshState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    seedVersion: SEED_VERSION,
    activities: SEED.map((a) => ({ ...a, custom: false, fav: false })),
    hiddenSeedIds: [],
    plans: {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshState();
    const s = JSON.parse(raw);
    s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    s.activities ||= [];
    s.hiddenSeedIds ||= [];
    s.plans ||= {};
    // Merge in any new starter activities added in later versions.
    if ((s.seedVersion || 0) < SEED_VERSION) {
      const have = new Set(s.activities.map((a) => a.id));
      for (const a of SEED) {
        if (!have.has(a.id) && !s.hiddenSeedIds.includes(a.id)) s.activities.push({ ...a, custom: false, fav: false });
      }
      s.seedVersion = SEED_VERSION;
    }
    return s;
  } catch (e) {
    console.error("Could not read saved data", e);
    return freshState();
  }
}

let state = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { toast("Couldn't save. Storage may be full."); }
}
save();

const ui = {
  tab: "now",
  planDay: "today",
  lib: { q: "", age: "now", skill: null, fav: false },
  sheet: null, // { type, ...args }
  openReactions: new Set(), // item ids showing reaction chips
};

/* =========================================================
   Helpers
   ========================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const todayKey = () => dateKey();
const tomorrowKey = () => dateKey(addDays(new Date(), 1));
function parseKey(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }

function ageMonths(at = new Date()) {
  const b = parseKey(state.settings.birthdate);
  let months = (at.getFullYear() - b.getFullYear()) * 12 + (at.getMonth() - b.getMonth());
  let anchor = new Date(b); anchor.setMonth(b.getMonth() + months);
  if (anchor > at) { months -= 1; anchor = new Date(b); anchor.setMonth(b.getMonth() + months); }
  const days = Math.floor((at - anchor) / 86400000);
  return { months, days, decimal: months + days / 30.44 };
}
function ageLabel() {
  const { months, days } = ageMonths();
  const weeks = Math.floor(days / 7);
  if (months < 0) return "";
  return weeks ? `${months} months, ${weeks} week${weeks > 1 ? "s" : ""}` : `${months} months`;
}
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + "m" : ""}`.trim() : `${m} min`);
function fmtElapsed(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayName = (k) => parseKey(k).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

const act = (id) => state.activities.find((a) => a.id === id);
const skillDots = (skills = []) =>
  `<span class="dots" aria-label="${esc(skills.map((s) => SKILLS[s]?.label).join(", "))}">${skills.map((s) => `<i class="dot" style="background:var(--${s})"></i>`).join("")}</span>`;
const ageRange = (a) => (a.maxAge >= 18 && a.minAge <= 0 ? "Any age" : `${a.minAge}–${a.maxAge} mo`);

function fitsAge(a, decimal) { return a.minAge <= decimal && decimal < a.maxAge + 1; }

/* Plans ------------------------------------------------- */
function defaultLabels(n) {
  const named = ["Morning", "Midday", "Afternoon", "Evening"];
  return Array.from({ length: n }, (_, i) => (n === 4 ? named[i] : `Window ${i + 1}`));
}
function ensurePlan(k) {
  if (!state.plans[k]) {
    const n = state.settings.windowsPerDay;
    const labels = n === 3 ? ["Morning", "Midday", "Evening"] : n === 2 ? ["Morning", "Afternoon"] : defaultLabels(n);
    state.plans[k] = { windows: labels.map((label) => ({ id: uid(), label, startedAt: null, endedAt: null, items: [] })) };
    save();
  }
  return state.plans[k];
}
const findWindow = (k, wid) => ensurePlan(k).windows.find((w) => w.id === wid);
const windowMinutes = (w) => w.items.reduce((sum, it) => sum + (act(it.activityId)?.minutes || 0), 0);

/* Reaction history across all days ---------------------- */
function historyFor(activityId) {
  const out = { done: 0, loved: 0, okay: 0, notyet: 0, last: null, lastNotYet: null };
  for (const [k, p] of Object.entries(state.plans)) {
    for (const w of p.windows) for (const it of w.items) {
      if (it.activityId !== activityId || !it.done) continue;
      out.done++;
      if (it.reaction) out[it.reaction]++;
      if (!out.last || k > out.last) out.last = k;
      if (it.reaction === "notyet" && (!out.lastNotYet || k > out.lastNotYet)) out.lastNotYet = k;
    }
  }
  return out;
}

/* Suggestions ------------------------------------------- */
function suggest(k, wid, { maxMinutes = Infinity, count = 1 } = {}) {
  const plan = ensurePlan(k);
  const age = ageMonths(parseKey(k)).decimal;
  const inDay = new Set(plan.windows.flatMap((w) => w.items.map((i) => i.activityId)));
  const skillCount = {};
  for (const w of plan.windows) for (const it of w.items) for (const s of act(it.activityId)?.skills || []) skillCount[s] = (skillCount[s] || 0) + 1;
  const twoWeeksAgo = dateKey(addDays(parseKey(k), -14));
  const twoDaysAgo = dateKey(addDays(parseKey(k), -2));

  const picks = [];
  let budget = maxMinutes;
  for (let n = 0; n < count; n++) {
    const scored = state.activities
      .filter((a) => fitsAge(a, age) && !inDay.has(a.id) && a.minutes <= budget)
      .map((a) => {
        const h = historyFor(a.id);
        if (h.lastNotYet && h.lastNotYet >= twoWeeksAgo) return null;
        let score = Math.random() * 2.5;
        for (const s of a.skills) score += skillCount[s] ? 1 / (1 + skillCount[s]) : 3;
        score += h.loved * 1.5 + (a.fav ? 2 : 0);
        if (h.last && h.last >= twoDaysAgo) score -= 2;
        return { a, score };
      })
      .filter(Boolean)
      .sort((x, y) => y.score - x.score);
    if (!scored.length) break;
    const a = scored[0].a;
    picks.push(a);
    inDay.add(a.id);
    budget -= a.minutes;
    for (const s of a.skills) skillCount[s] = (skillCount[s] || 0) + 1;
  }
  const w = findWindow(k, wid);
  for (const a of picks) w.items.push({ id: uid(), activityId: a.id, done: false, reaction: null });
  save();
  return picks;
}

/* =========================================================
   Toast
   ========================================================= */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* =========================================================
   Icons
   ========================================================= */
const I = {
  gear: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  more: `<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>`,
  close: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
};

/* =========================================================
   Views
   ========================================================= */
function header(title, sub) {
  return `<header class="top"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div>
    <button class="icon-btn" data-action="settings" aria-label="Settings">${I.gear}</button></header>`;
}

function itemRow(k, w, it, { reactions = false } = {}) {
  const a = act(it.activityId);
  if (!a) return "";
  const showR = reactions && it.done && (ui.openReactions.has(it.id) || !it.reaction);
  const rLabel = { loved: "Loved it", okay: "Okay", notyet: "Not ready" };
  return `<li class="item ${it.done ? "done" : ""}">
    <button class="check" data-action="toggle" data-day="${k}" data-win="${w.id}" data-item="${it.id}" aria-pressed="${it.done}" aria-label="${it.done ? "Mark not done" : "Mark done"}: ${esc(a.title)}">${I.check}</button>
    <button class="item-main" data-action="item" data-day="${k}" data-win="${w.id}" data-item="${it.id}">
      <span class="item-title">${esc(a.title)}</span>
      <span class="item-meta">${skillDots(a.skills)} ${a.minutes} min${it.reaction && !showR ? ` · ${rLabel[it.reaction]}` : ""}</span>
    </button>
    <button class="more" data-action="item" data-day="${k}" data-win="${w.id}" data-item="${it.id}" aria-label="Options">${I.more}</button>
    ${showR ? `<div class="reactions" role="group" aria-label="How did it go?">
      ${["loved", "okay", "notyet"].map((r) => `<button class="chip" data-action="react" data-r="${r}" data-day="${k}" data-win="${w.id}" data-item="${it.id}" aria-pressed="${it.reaction === r}">${rLabel[r]}</button>`).join("")}
    </div>` : ""}
  </li>`;
}

function stacker(k) {
  const plan = ensurePlan(k);
  const counts = {};
  for (const w of plan.windows) for (const it of w.items) if (it.done) for (const s of act(it.activityId)?.skills || []) counts[s] = (counts[s] || 0) + 1;
  const order = ["gross", "fine", "sensory", "language", "social", "cognitive"]; // bottom to top
  const widths = [124, 110, 96, 82, 68, 54];
  const practiced = order.filter((s) => counts[s]).length;
  const missing = order.filter((s) => !counts[s]).map((s) => SKILLS[s].label.toLowerCase());
  const note = practiced === 6 ? "Every skill got some play today."
    : practiced === 0 ? "Rings fill in as you check off activities."
    : `Still open today: ${missing.join(", ")}.`;
  return `<section class="stacker-wrap" aria-label="Skills practiced today">
    <div class="stacker" aria-hidden="true">${order.map((s, i) => `<span class="ring ${counts[s] ? "on" : ""}" style="--c:var(--${s});width:${widths[i]}px"></span>`).join("")}</div>
    <ul class="legend">${[...order].reverse().map((s) => `<li class="${counts[s] ? "on" : ""}"><i class="dot" style="background:var(--${s})"></i>${SKILLS[s].label}<span class="n">${counts[s] || ""}</span></li>`).join("")}</ul>
    <p class="stacker-note">${note}</p>
  </section>`;
}

function viewNow() {
  const k = todayKey();
  const plan = ensurePlan(k);
  const name = esc(state.settings.name);
  const active = plan.windows.find((w) => w.startedAt && !w.endedAt);
  const next = plan.windows.find((w) => !w.startedAt);
  let hero;

  if (active) {
    const target = state.settings.windowTarget;
    hero = `<section class="hero">
      <div class="label">${esc(active.label)} · awake since ${fmtTime(active.startedAt)}</div>
      <div class="clock" data-timer="${active.startedAt}">${fmtElapsed(Date.now() - new Date(active.startedAt))}</div>
      <div class="meter" data-meter="${active.startedAt}" data-target="${target}"><i></i></div>
      <div class="hint" data-hint="${active.startedAt}" data-target="${target}"></div>
      ${active.items.length
        ? `<ul class="list">${active.items.map((it) => itemRow(k, active, it, { reactions: true })).join("")}</ul>`
        : `<div class="empty">Nothing planned for this window yet.</div>`}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" data-action="pick" data-day="${k}" data-win="${active.id}" data-fit="1">Add activity</button>
        <button class="btn small" data-action="suggest-one" data-day="${k}" data-win="${active.id}">Suggest one</button>
      </div>
      <button class="btn primary big" data-action="end-window" data-win="${active.id}">${name} is napping</button>
    </section>`;
  } else if (next) {
    const ended = plan.windows.filter((w) => w.endedAt).pop();
    hero = `<section class="hero">
      <div class="label">${ended ? `Napping since ${fmtTime(ended.endedAt)}` : "Up next"}</div>
      <div class="resting">${esc(next.label)}${next.items.length ? `: ${next.items.length} ${next.items.length === 1 ? "activity" : "activities"} planned` : ""}</div>
      ${next.items.length
        ? `<ul class="list">${next.items.map((it) => itemRow(k, next, it)).join("")}</ul>`
        : `<div class="empty">No activities planned yet. Add some now or after she wakes.</div>
           <div class="btn-row" style="margin-top:10px"><button class="btn small" data-action="fill" data-day="${k}" data-win="${next.id}">Fill with ideas</button><button class="btn small" data-action="pick" data-day="${k}" data-win="${next.id}">Choose from library</button></div>`}
      <button class="btn primary big" data-action="start-window" data-win="${next.id}">${name} is awake</button>
    </section>`;
  } else {
    const done = plan.windows.reduce((n, w) => n + w.items.filter((i) => i.done).length, 0);
    hero = `<section class="hero">
      <div class="label">All windows finished</div>
      <div class="resting">That's a wrap: ${done} ${done === 1 ? "activity" : "activities"} today.</div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn" data-action="add-window" data-day="${k}">Add another window</button>
        <button class="btn" data-action="goto-plan" data-day="tomorrow">Plan tomorrow</button>
      </div>
    </section>`;
  }

  const rows = plan.windows.map((w) => {
    const d = w.items.filter((i) => i.done).length;
    const cls = w.startedAt && !w.endedAt ? "active" : w.endedAt ? "ended" : "";
    const when = w.startedAt ? `${fmtTime(w.startedAt)}${w.endedAt ? `–${fmtTime(w.endedAt)}` : " – now"}` : "";
    return `<div class="day-row ${cls}"><span class="state"></span><div><strong>${esc(w.label)}</strong>${when ? `<div class="status" style="font-size:13px;color:var(--muted)">${when}</div>` : ""}</div><span class="count">${d}/${w.items.length}</span></div>`;
  }).join("");

  return header(parseKey(k).toLocaleDateString([], { weekday: "long" }), `${name} is ${ageLabel()}`)
    + hero
    + `<h2>Skills today</h2>` + stacker(k)
    + `<h2>Today's windows</h2>` + rows;
}

function viewPlan() {
  const isToday = ui.planDay === "today";
  const k = isToday ? todayKey() : tomorrowKey();
  const plan = ensurePlan(k);
  const cards = plan.windows.map((w) => {
    const mins = windowMinutes(w);
    const status = w.endedAt ? `Done · ${fmtTime(w.startedAt)}–${fmtTime(w.endedAt)}` : w.startedAt ? `Happening now · since ${fmtTime(w.startedAt)}` : "";
    return `<section class="card">
      <div class="card-head">
        <button class="rename" data-action="rename" data-day="${k}" data-win="${w.id}" aria-label="Rename ${esc(w.label)}">${esc(w.label)}</button>
        <span class="mins">${mins ? fmtMin(mins) : ""}</span>
      </div>
      ${status ? `<div class="status">${status}</div>` : ""}
      ${w.items.length ? `<ul class="list">${w.items.map((it) => itemRow(k, w, it, { reactions: true })).join("")}</ul>` : `<div class="empty">Empty window</div>`}
      <div class="btn-row">
        <button class="btn small" data-action="pick" data-day="${k}" data-win="${w.id}">Add</button>
        <button class="btn small" data-action="fill" data-day="${k}" data-win="${w.id}">Fill with ideas</button>
      </div>
    </section>`;
  }).join("");

  return header(isToday ? "Plan today" : "Plan tomorrow", dayName(k))
    + `<div class="seg" role="group" aria-label="Day">
        <button data-action="plan-day" data-day="today" aria-pressed="${isToday}">Today</button>
        <button data-action="plan-day" data-day="tomorrow" aria-pressed="${!isToday}">Tomorrow</button>
      </div>`
    + cards
    + `<div class="plan-foot">
        <button class="btn" data-action="add-window" data-day="${k}">Add a window</button>
        ${isToday ? "" : `<button class="btn" data-action="copy-today">Copy today's plan</button>`}
        <button class="btn" data-action="fill-day" data-day="${k}">Fill empty windows with ideas</button>
        <button class="btn ghost danger" data-action="clear-day" data-day="${k}">Clear ${isToday ? "today" : "tomorrow"}</button>
      </div>`;
}

function libraryResults() {
  const { q, age, skill, fav } = ui.lib;
  const now = ageMonths().decimal;
  const needle = q.trim().toLowerCase();
  return state.activities
    .filter((a) => {
      if (age === "now" && !fitsAge(a, now)) return false;
      if (age === "soon" && !(a.minAge > now && a.minAge <= now + 3)) return false;
      if (skill && !a.skills.includes(skill)) return false;
      if (fav && !a.fav) return false;
      if (needle) {
        const hay = [a.title, a.how, ...(a.materials || [])].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    })
    .sort((x, y) => Number(y.fav) - Number(x.fav) || x.minAge - y.minAge || x.title.localeCompare(y.title));
}

function libraryList() {
  const list = libraryResults();
  const label = ui.lib.age === "now" ? `right for ${esc(state.settings.name)} now` : ui.lib.age === "soon" ? "coming up in the next 3 months" : "in the library";
  if (!list.length) return `<p class="result-count">No activities match.</p><div class="empty">Try a different filter, or add your own with New activity.</div>`;
  return `<p class="result-count">${list.length} ${list.length === 1 ? "activity" : "activities"} ${label}</p>` + list.map((a) => `
    <button class="lib-item" data-action="detail" data-id="${a.id}">
      <div class="row1"><h3>${a.fav ? `<span class="star" aria-label="Favorite">★</span> ` : ""}${esc(a.title)}</h3><span class="mins">${a.minutes} min</span></div>
      <div class="item-meta">${skillDots(a.skills)} ${ageRange(a)}${a.custom ? " · Yours" : ""}</div>
      ${a.materials?.length ? `<div class="mat">${esc(a.materials.join(", "))}</div>` : ""}
    </button>`).join("");
}

function viewLibrary() {
  const { q, age, skill, fav } = ui.lib;
  return header("Library", `${state.activities.length} activities`)
    + `<input class="search" type="search" placeholder="Search activities or materials" value="${esc(q)}" data-input="lib-q" aria-label="Search activities">
      <div class="filters" role="group" aria-label="Filters">
        <button class="chip" data-action="lib-age" data-v="now" aria-pressed="${age === "now"}">For ${esc(state.settings.name)} now</button>
        <button class="chip" data-action="lib-age" data-v="soon" aria-pressed="${age === "soon"}">Coming up</button>
        <button class="chip" data-action="lib-age" data-v="all" aria-pressed="${age === "all"}">All ages</button>
        <button class="chip" data-action="lib-fav" aria-pressed="${fav}">★ Favorites</button>
      </div>
      <div class="filters" role="group" aria-label="Skill">
        ${Object.entries(SKILLS).map(([key, s]) => `<button class="chip" data-action="lib-skill" data-v="${key}" aria-pressed="${skill === key}"><i class="dot" style="background:var(--${key})"></i>${s.label}</button>`).join("")}
      </div>
      <div id="lib-results">${libraryList()}</div>
      <button class="btn primary fab" data-action="new-activity">New activity</button>`;
}

/* =========================================================
   Sheets
   ========================================================= */
function sheetShell(title, body) {
  return `<div class="scrim" data-action="close-sheet-scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="grabber"></div>
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="close" data-action="close-sheet" aria-label="Close">${I.close}</button></div>
    ${body}</div></div>`;
}

function sheetDetail({ id, day, win, item }) {
  const a = act(id);
  if (!a) return "";
  const h = historyFor(a.id);
  const parts = [];
  if (h.done) parts.push(`Done ${h.done} ${h.done === 1 ? "time" : "times"}`);
  if (h.loved) parts.push(`loved ${h.loved}×`);
  if (h.notyet) parts.push(`not ready ${h.notyet}×`);
  if (h.last) parts.push(`last on ${parseKey(h.last).toLocaleDateString([], { month: "short", day: "numeric" })}`);
  const inPlan = item ? findWindow(day, win) : null;

  const body = `
    <div class="facts">
      <span class="fact">${a.minutes} min</span>
      <span class="fact">${ageRange(a)}</span>
      ${a.skills.map((s) => `<span class="fact"><i class="dot" style="background:var(--${s})"></i>${SKILLS[s].label}</span>`).join("")}
    </div>
    ${parts.length ? `<p class="history">${parts.join(", ")}.</p>` : ""}
    ${a.materials?.length ? `<h4>Materials</h4><ul class="mats">${a.materials.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : `<h4>Materials</h4><p>Nothing needed.</p>`}
    ${a.how ? `<h4>How to play</h4><p>${esc(a.how)}</p>` : ""}
    ${a.safety ? `<h4>Safety</h4><p class="safety">${esc(a.safety)}</p>` : ""}
    ${inPlan ? `
      <h4>In this plan</h4>
      <div class="field"><label for="move-to">Move to window</label>
        <select id="move-to" data-change="move-item" data-day="${day}" data-win="${win}" data-item="${item}">
          ${ensurePlan(day).windows.map((w) => `<option value="${w.id}" ${w.id === win ? "selected" : ""}>${esc(w.label)}</option>`).join("")}
        </select></div>
      <div class="btn-row">
        <button class="btn small" data-action="move-up" data-day="${day}" data-win="${win}" data-item="${item}">Move up</button>
        <button class="btn small" data-action="move-down" data-day="${day}" data-win="${win}" data-item="${item}">Move down</button>
        <button class="btn small" data-action="swap" data-day="${day}" data-win="${win}" data-item="${item}">Swap for another idea</button>
        <button class="btn small danger" data-action="remove-item" data-day="${day}" data-win="${win}" data-item="${item}">Remove from plan</button>
      </div>` : `
      <div class="btn-row"><button class="btn primary" data-action="add-to" data-id="${a.id}">Add to a window</button></div>`}
    <div class="btn-row">
      <button class="btn small" data-action="fav" data-id="${a.id}">${a.fav ? "★ Favorited" : "☆ Favorite"}</button>
      <button class="btn small" data-action="edit" data-id="${a.id}">Edit</button>
      <button class="btn small danger" data-action="delete-activity" data-id="${a.id}">${a.custom ? "Delete" : "Hide"}</button>
    </div>`;
  return sheetShell(a.title, body);
}

function sheetAddTo({ id }) {
  const a = act(id);
  const block = (k, title) => {
    const plan = ensurePlan(k);
    return `<h4>${title}</h4><div class="pick-list">${plan.windows.map((w) => `
      <button class="pick" data-action="add-to-window" data-id="${id}" data-day="${k}" data-win="${w.id}">
        <span class="grow"><strong>${esc(w.label)}</strong><div class="item-meta">${w.items.length} planned${w.endedAt ? " · done" : ""}</div></span><span class="plus">+</span>
      </button>`).join("")}</div>`;
  };
  return sheetShell(`Add "${a.title}"`, block(todayKey(), "Today") + block(tomorrowKey(), "Tomorrow"));
}

function sheetPicker({ day, win, fit }) {
  const w = findWindow(day, win);
  if (!w) return "";
  const age = ageMonths(parseKey(day)).decimal;
  let remaining = Infinity;
  if (fit && w.startedAt && !w.endedAt) {
    const elapsed = (Date.now() - new Date(w.startedAt)) / 60000;
    remaining = Math.max(0, Math.round(state.settings.windowTarget - elapsed));
  }
  const inWin = new Set(w.items.map((i) => i.activityId));
  const q = (ui.pickQ || "").toLowerCase();
  const list = state.activities
    .filter((a) => fitsAge(a, age) && a.minutes <= remaining)
    .filter((a) => !q || [a.title, ...(a.materials || [])].join(" ").toLowerCase().includes(q))
    .sort((x, y) => Number(y.fav) - Number(x.fav) || x.title.localeCompare(y.title));
  const body = `
    ${remaining !== Infinity ? `<p class="history">Showing activities that fit the ${remaining} min left in this window.</p>` : `<p class="history">Showing activities right for ${esc(state.settings.name)} on ${parseKey(day).toLocaleDateString([], { weekday: "long" })}.</p>`}
    <div class="field"><input class="search" type="search" placeholder="Search" value="${esc(ui.pickQ || "")}" data-input="pick-q" aria-label="Search"></div>
    <div class="pick-list" id="pick-results">${list.map((a) => `
      <button class="pick ${inWin.has(a.id) ? "added" : ""}" data-action="pick-add" data-id="${a.id}" data-day="${day}" data-win="${win}">
        <span class="grow"><strong>${a.fav ? "★ " : ""}${esc(a.title)}</strong><div class="item-meta">${skillDots(a.skills)} ${a.minutes} min${a.materials?.length ? ` · ${esc(a.materials[0])}${a.materials.length > 1 ? " +" + (a.materials.length - 1) : ""}` : ""}</div></span>
        <span class="plus">${inWin.has(a.id) ? "✓" : "+"}</span>
      </button>`).join("") || `<div class="empty">Nothing fits. Try the library for more.</div>`}
    </div>
    <div class="btn-row"><button class="btn primary" data-action="close-sheet">Done</button></div>`;
  return sheetShell(`Add to ${w.label}`, body);
}

function sheetForm({ id }) {
  const a = id ? act(id) : { title: "", minAge: Math.max(0, ageMonths().months), maxAge: 18, minutes: 10, materials: [], skills: [], how: "", safety: "" };
  const body = `<form data-form="activity" data-id="${id || ""}">
    <div class="field"><label for="f-title">Name</label><input id="f-title" name="title" required value="${esc(a.title)}" placeholder="e.g. Kitchen spoon drumming"></div>
    <div class="row2">
      <div class="field"><label for="f-min">From (mo)</label><input id="f-min" name="minAge" type="number" inputmode="numeric" min="0" max="48" value="${a.minAge}"></div>
      <div class="field"><label for="f-max">To (mo)</label><input id="f-max" name="maxAge" type="number" inputmode="numeric" min="0" max="48" value="${a.maxAge}"></div>
      <div class="field"><label for="f-mins">Minutes</label><input id="f-mins" name="minutes" type="number" inputmode="numeric" min="1" max="120" value="${a.minutes}"></div>
    </div>
    <div class="field"><span class="lbl">Skills it builds</span><div class="skill-pick">
      ${Object.entries(SKILLS).map(([k, s]) => `<button type="button" class="chip" data-action="form-skill" data-v="${k}" aria-pressed="${a.skills.includes(k)}"><i class="dot" style="background:var(--${k})"></i>${s.label}</button>`).join("")}
    </div></div>
    <div class="field"><label for="f-mat">Materials</label><textarea id="f-mat" name="materials" placeholder="One per line">${esc((a.materials || []).join("\n"))}</textarea></div>
    <div class="field"><label for="f-how">How to play</label><textarea id="f-how" name="how">${esc(a.how)}</textarea></div>
    <div class="field"><label for="f-safety">Safety notes</label><textarea id="f-safety" name="safety" style="min-height:60px">${esc(a.safety)}</textarea></div>
    <div class="btn-row"><button class="btn primary" type="submit">${id ? "Save changes" : "Add to library"}</button></div>
  </form>`;
  return sheetShell(id ? "Edit activity" : "New activity", body);
}

function sheetSettings() {
  const s = state.settings;
  const hidden = state.hiddenSeedIds.length;
  const body = `<form data-form="settings">
    <div class="field"><label for="s-name">Baby's name</label><input id="s-name" name="name" value="${esc(s.name)}"></div>
    <div class="field"><label for="s-bd">Birthdate</label><input id="s-bd" name="birthdate" type="date" value="${esc(s.birthdate)}"></div>
    <div class="field"><label for="s-wt">Typical wake window (minutes)</label><input id="s-wt" name="windowTarget" type="number" inputmode="numeric" min="30" max="360" value="${s.windowTarget}"><span class="help">Drives the timer on the Now screen. Adjust as her windows stretch.</span></div>
    <div class="field"><label for="s-pm">Activity time per window (minutes)</label><input id="s-pm" name="playMinutes" type="number" inputmode="numeric" min="5" max="240" value="${s.playMinutes}"><span class="help">How much "Fill with ideas" plans, leaving room for feeds and diapers.</span></div>
    <div class="field"><label for="s-wpd">Windows per day</label><input id="s-wpd" name="windowsPerDay" type="number" inputmode="numeric" min="1" max="6" value="${s.windowsPerDay}"><span class="help">Applies to days you haven't planned yet.</span></div>
    <div class="btn-row"><button class="btn primary" type="submit">Save settings</button></div>
  </form>
  <h4>Backup</h4>
  <p class="history">Your data lives on this phone. Save a backup now and then so nothing is lost.</p>
  <div class="btn-row">
    <button class="btn small" data-action="export">Save backup</button>
    <label class="btn small" for="import-file">Restore backup</label>
    <input id="import-file" type="file" accept="application/json,.json" class="visually-hidden" data-change="import">
  </div>
  ${hidden ? `<h4>Hidden activities</h4><div class="btn-row"><button class="btn small" data-action="unhide">Restore ${hidden} hidden starter ${hidden === 1 ? "activity" : "activities"}</button></div>` : ""}`;
  return sheetShell("Settings", body);
}

/* =========================================================
   Render
   ========================================================= */
let lastTab = null;
function render() {
  const app = $("#app");
  const views = { now: viewNow, plan: viewPlan, library: viewLibrary };
  const scroll = window.scrollY;
  app.innerHTML = views[ui.tab]();
  if (lastTab === ui.tab) window.scrollTo(0, scroll); else window.scrollTo(0, 0);
  lastTab = ui.tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === ui.tab ? "page" : "false"));
  renderSheet();
  tick();
}

function renderSheet() {
  const root = $("#sheet-root");
  const s = ui.sheet;
  if (!s) { root.innerHTML = ""; document.body.style.overflow = ""; return; }
  const prevScroll = $(".sheet", root)?.scrollTop || 0;
  const map = { detail: sheetDetail, addTo: sheetAddTo, picker: sheetPicker, form: sheetForm, settings: sheetSettings };
  root.innerHTML = map[s.type](s);
  document.body.style.overflow = "hidden";
  const sheet = $(".sheet", root);
  if (sheet && s._keepScroll) sheet.scrollTop = prevScroll;
  s._keepScroll = false;
}
function openSheet(sheet) { ui.sheet = sheet; ui.pickQ = ""; renderSheet(); }
function closeSheet() { ui.sheet = null; renderSheet(); render(); }
function refreshSheet() { if (ui.sheet) { ui.sheet._keepScroll = true; renderSheet(); } }

function tick() {
  const now = Date.now();
  document.querySelectorAll("[data-timer]").forEach((el) => { el.textContent = fmtElapsed(now - new Date(el.dataset.timer)); });
  document.querySelectorAll("[data-meter]").forEach((el) => {
    const mins = (now - new Date(el.dataset.meter)) / 60000;
    const t = +el.dataset.target;
    el.firstElementChild.style.width = `${Math.min(100, (mins / t) * 100)}%`;
    el.classList.toggle("over", mins > t);
  });
  document.querySelectorAll("[data-hint]").forEach((el) => {
    const mins = Math.round((now - new Date(el.dataset.hint)) / 60000);
    const left = +el.dataset.target - mins;
    el.classList.toggle("over", left < 0);
    el.textContent = left > 10 ? `About ${fmtMin(left)} until nap time` : left >= 0 ? "Nap time is close. Start winding down." : `${fmtMin(-left)} past her usual window`;
  });
}
setInterval(tick, 15000);

/* =========================================================
   Actions
   ========================================================= */
function getItem(d) {
  const w = findWindow(d.day, d.win);
  return { w, it: w?.items.find((i) => i.id === d.item) };
}

const actions = {
  settings: () => openSheet({ type: "settings" }),
  "close-sheet": closeSheet,
  "close-sheet-scrim": (d, e) => { if (e.target.classList.contains("scrim")) closeSheet(); },

  "start-window": (d) => {
    const w = findWindow(todayKey(), d.win);
    // End any window still running.
    ensurePlan(todayKey()).windows.forEach((x) => { if (x.startedAt && !x.endedAt) x.endedAt = new Date().toISOString(); });
    w.startedAt = new Date().toISOString();
    save(); render();
  },
  "end-window": (d) => {
    const w = findWindow(todayKey(), d.win);
    w.endedAt = new Date().toISOString();
    save(); render();
    toast("Sweet dreams");
  },
  toggle: (d) => {
    const { it } = getItem(d);
    it.done = !it.done;
    it.doneAt = it.done ? new Date().toISOString() : null;
    if (!it.done) { it.reaction = null; ui.openReactions.delete(it.id); }
    save(); render(); refreshSheet();
  },
  react: (d) => {
    const { it } = getItem(d);
    it.reaction = it.reaction === d.r ? null : d.r;
    ui.openReactions.delete(it.id);
    save(); render();
  },
  item: (d) => {
    const { it } = getItem(d);
    if (it.done && it.reaction && ui.tab !== "library" && !ui.openReactions.has(it.id) && d.fromMeta) return;
    openSheet({ type: "detail", id: it.activityId, day: d.day, win: d.win, item: d.item });
  },
  "goto-plan": (d) => { ui.tab = "plan"; ui.planDay = d.day; render(); },
  "plan-day": (d) => { ui.planDay = d.day; render(); },

  pick: (d) => openSheet({ type: "picker", day: d.day, win: d.win, fit: !!d.fit }),
  "pick-add": (d) => {
    const w = findWindow(d.day, d.win);
    const existing = w.items.find((i) => i.activityId === d.id && !i.done);
    if (existing) w.items = w.items.filter((i) => i !== existing);
    else w.items.push({ id: uid(), activityId: d.id, done: false, reaction: null });
    save(); refreshSheet();
  },
  "suggest-one": (d) => {
    const w = findWindow(d.day, d.win);
    let max = Infinity;
    if (w.startedAt && !w.endedAt) max = Math.max(5, state.settings.windowTarget - (Date.now() - new Date(w.startedAt)) / 60000);
    const got = suggest(d.day, d.win, { maxMinutes: max, count: 1 });
    toast(got.length ? `Added ${got[0].title}` : "No more ideas fit right now");
    render();
  },
  fill: (d) => {
    const w = findWindow(d.day, d.win);
    const room = state.settings.playMinutes - windowMinutes(w);
    const got = room > 0 ? suggest(d.day, d.win, { maxMinutes: room, count: 4 }) : [];
    toast(got.length ? `Added ${got.length} ${got.length === 1 ? "idea" : "ideas"}` : "This window is already full");
    render();
  },
  "fill-day": (d) => {
    let n = 0;
    for (const w of ensurePlan(d.day).windows) if (!w.items.length && !w.endedAt) n += suggest(d.day, w.id, { maxMinutes: state.settings.playMinutes, count: 4 }).length;
    toast(n ? `Added ${n} ideas` : "No empty windows to fill");
    render();
  },
  "add-window": (d) => {
    const plan = ensurePlan(d.day);
    plan.windows.push({ id: uid(), label: `Window ${plan.windows.length + 1}`, startedAt: null, endedAt: null, items: [] });
    save(); render();
  },
  rename: (d) => {
    const w = findWindow(d.day, d.win);
    const name = prompt("Window name", w.label);
    if (name === null) return;
    if (name.trim() === "") {
      if (w.items.length && !confirm(`Remove ${w.label} and its ${w.items.length} planned activities?`)) return;
      const plan = ensurePlan(d.day);
      plan.windows = plan.windows.filter((x) => x !== w);
      toast("Window removed");
    } else w.label = name.trim();
    save(); render();
  },
  "copy-today": () => {
    const from = ensurePlan(todayKey());
    const to = ensurePlan(tomorrowKey());
    const hasItems = to.windows.some((w) => w.items.length);
    if (hasItems && !confirm("Replace tomorrow's plan with a copy of today's?")) return;
    state.plans[tomorrowKey()] = { windows: from.windows.map((w) => ({ id: uid(), label: w.label, startedAt: null, endedAt: null, items: w.items.map((i) => ({ id: uid(), activityId: i.activityId, done: false, reaction: null })) })) };
    save(); render(); toast("Copied today's plan");
  },
  "clear-day": (d) => {
    if (!confirm("Clear every planned activity for this day?")) return;
    delete state.plans[d.day];
    ensurePlan(d.day);
    render(); toast("Cleared");
  },
  "move-item": (d, e) => {
    const { w, it } = getItem(d);
    const to = findWindow(d.day, e.target.value);
    w.items = w.items.filter((i) => i !== it);
    to.items.push(it);
    save();
    ui.sheet.win = to.id;
    render(); toast(`Moved to ${to.label}`);
  },
  "move-up": (d) => moveBy(d, -1),
  "move-down": (d) => moveBy(d, 1),
  "remove-item": (d) => {
    const { w, it } = getItem(d);
    w.items = w.items.filter((i) => i !== it);
    save(); closeSheet(); toast("Removed from plan");
  },
  swap: (d) => {
    const { w, it } = getItem(d);
    const old = act(it.activityId);
    const idx = w.items.indexOf(it);
    w.items.splice(idx, 1);
    const got = suggest(d.day, d.win, { maxMinutes: Math.max(old.minutes, 10), count: 1 });
    if (!got.length) { w.items.splice(idx, 0, it); save(); toast("No other ideas fit"); return; }
    const added = w.items.pop();
    w.items.splice(idx, 0, added);
    save();
    ui.sheet = { type: "detail", id: added.activityId, day: d.day, win: d.win, item: added.id };
    render(); toast(`Swapped in ${got[0].title}`);
  },

  "lib-age": (d) => { ui.lib.age = d.v; render(); },
  "lib-skill": (d) => { ui.lib.skill = ui.lib.skill === d.v ? null : d.v; render(); },
  "lib-fav": () => { ui.lib.fav = !ui.lib.fav; render(); },
  detail: (d) => openSheet({ type: "detail", id: d.id }),
  "add-to": (d) => openSheet({ type: "addTo", id: d.id }),
  "add-to-window": (d) => {
    const w = findWindow(d.day, d.win);
    w.items.push({ id: uid(), activityId: d.id, done: false, reaction: null });
    save(); closeSheet();
    toast(`Added to ${d.day === todayKey() ? "today" : "tomorrow"}, ${w.label}`);
  },
  fav: (d) => { const a = act(d.id); a.fav = !a.fav; save(); refreshSheet(); render(); },
  edit: (d) => openSheet({ type: "form", id: d.id }),
  "new-activity": () => openSheet({ type: "form" }),
  "form-skill": (d, e) => {
    const b = e.target.closest("button");
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
  },
  "delete-activity": (d) => {
    const a = act(d.id);
    const msg = a.custom ? `Delete "${a.title}"? It will also be removed from any plans.` : `Hide "${a.title}" from the library? You can restore it in Settings.`;
    if (!confirm(msg)) return;
    state.activities = state.activities.filter((x) => x.id !== a.id);
    if (!a.custom) state.hiddenSeedIds.push(a.id);
    for (const p of Object.values(state.plans)) for (const w of p.windows) w.items = w.items.filter((i) => i.activityId !== a.id || i.done);
    save(); closeSheet(); toast(a.custom ? "Deleted" : "Hidden");
  },
  unhide: () => {
    for (const a of SEED) if (state.hiddenSeedIds.includes(a.id)) state.activities.push({ ...a, custom: false, fav: false });
    state.hiddenSeedIds = [];
    save(); refreshSheet(); render(); toast("Restored");
  },
  export: async () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const file = new File([blob], `playroom-backup-${todayKey()}.json`, { type: "application/json" });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: "Playroom backup" }); return; }
    } catch (e) { if (e.name === "AbortError") return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  },
};

function moveBy(d, delta) {
  const { w, it } = getItem(d);
  const i = w.items.indexOf(it), j = i + delta;
  if (j < 0 || j >= w.items.length) return;
  [w.items[i], w.items[j]] = [w.items[j], w.items[i]];
  save(); render(); toast(delta < 0 ? "Moved up" : "Moved down");
}

/* Events ------------------------------------------------ */
document.addEventListener("click", (e) => {
  const tab = e.target.closest("#tabs button");
  if (tab) { ui.tab = tab.dataset.tab; ui.sheet = null; render(); return; }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.dataset.action === "close-sheet-scrim" && el !== e.target) return;
  e.preventDefault();
  if (el.dataset.action === "toggle") {
    const { it } = getItem(el.dataset);
    if (it && !it.done) ui.openReactions.add(it.id);
  }
  fn({ ...el.dataset }, e);
});

document.addEventListener("input", (e) => {
  const k = e.target.dataset.input;
  if (k === "lib-q") { ui.lib.q = e.target.value; $("#lib-results").innerHTML = libraryList(); }
  if (k === "pick-q") {
    ui.pickQ = e.target.value;
    const tmp = document.createElement("div");
    tmp.innerHTML = sheetPicker(ui.sheet);
    $("#pick-results").innerHTML = $("#pick-results", tmp).innerHTML;
  }
});

document.addEventListener("change", (e) => {
  const k = e.target.dataset.change;
  if (k === "move-item") actions["move-item"]({ ...e.target.dataset }, e);
  if (k === "import") {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then((txt) => {
      const data = JSON.parse(txt);
      if (!data.activities || !data.plans) throw new Error("bad file");
      if (!confirm("Replace everything in the app with this backup?")) return;
      localStorage.setItem(KEY, JSON.stringify(data));
      state = load(); save(); closeSheet(); toast("Backup restored");
    }).catch(() => toast("That file isn't a Playroom backup"));
  }
});

document.addEventListener("submit", (e) => {
  const form = e.target;
  e.preventDefault();
  const fd = new FormData(form);
  if (form.dataset.form === "settings") {
    const s = state.settings;
    s.name = (fd.get("name") || "").trim() || "Baby";
    s.birthdate = fd.get("birthdate") || s.birthdate;
    s.windowTarget = clampNum(fd.get("windowTarget"), 30, 360, s.windowTarget);
    s.playMinutes = clampNum(fd.get("playMinutes"), 5, 240, s.playMinutes);
    s.windowsPerDay = clampNum(fd.get("windowsPerDay"), 1, 6, s.windowsPerDay);
    save(); closeSheet(); toast("Settings saved");
  }
  if (form.dataset.form === "activity") {
    const title = (fd.get("title") || "").trim();
    if (!title) { toast("Give it a name"); return; }
    const skills = [...form.querySelectorAll('[data-action="form-skill"][aria-pressed="true"]')].map((b) => b.dataset.v);
    if (!skills.length) { toast("Pick at least one skill"); return; }
    let minAge = clampNum(fd.get("minAge"), 0, 48, 0), maxAge = clampNum(fd.get("maxAge"), 0, 48, 18);
    if (maxAge < minAge) [minAge, maxAge] = [maxAge, minAge];
    const data = {
      title, minAge, maxAge,
      minutes: clampNum(fd.get("minutes"), 1, 120, 10),
      skills,
      materials: String(fd.get("materials") || "").split("\n").map((s) => s.trim()).filter(Boolean),
      how: String(fd.get("how") || "").trim(),
      safety: String(fd.get("safety") || "").trim(),
    };
    const id = form.dataset.id;
    if (id) { Object.assign(act(id), data); toast("Saved"); }
    else { state.activities.push({ id: "c-" + uid(), custom: true, fav: false, ...data }); toast("Added to library"); }
    save();
    const nowAge = ageMonths().decimal;
    if (!id && ui.tab === "library" && ui.lib.age === "now" && !(minAge <= nowAge && nowAge < maxAge + 1)) ui.lib.age = "all";
    closeSheet();
  }
});
function clampNum(v, lo, hi, dflt) { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== "" ? Math.min(hi, Math.max(lo, n)) : dflt; }

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.sheet) closeSheet(); });

// Re-render when the day rolls over or the app returns to the foreground.
let lastDay = todayKey();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (todayKey() !== lastDay) { lastDay = todayKey(); }
  render();
});

render();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
