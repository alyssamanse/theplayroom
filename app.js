import { SEED, SEED_VERSION, REMOVED_SEED_IDS, SKILLS, TAGS, TOYS, MILESTONES } from "./seed.js";
import * as sync from "./sync.js";

// Bump this (and version.json) with every release so phones know an update is waiting.
const APP_VERSION = "2026.10.14-12";

/* =========================================================
   Storage
   ========================================================= */
const KEY = "playroom.v1";

const DEFAULT_SETTINGS = {
  name: "Baby",
  birthdate: "",
  windowTarget: 150,   // minutes awake per window
  playMinutes: 45,     // planned activity minutes per window when filling
  windowsPerDay: 4,
  outTarget: 6,        // toys out at once
  rotateDays: 7,       // days a toy stays out before it's due for a swap
};

function freshState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    seedVersion: SEED_VERSION,
    activities: SEED.map((a) => ({ ...a, custom: false, fav: false })),
    hiddenSeedIds: [],
    toys: TOYS.map((t) => ({ ...t, custom: false, periods: [] })),
    hiddenToyIds: [],
    milestones: {},          // id -> date reached
    milestonesSetup: false,  // gating by milestones starts once she's gone through the list
    templates: { days: [], windows: [] },
    plans: {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshState();
    return migrate(JSON.parse(raw));
  } catch (e) {
    console.error("Could not read saved data", e);
    return freshState();
  }
}

// Fill in missing fields and bring older data up to the current starter content.
function migrate(s) {
  {
    s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    s.activities ||= [];
    s.hiddenSeedIds ||= [];
    s.plans ||= {};
    s.toys ||= [];
    s.milestones ||= {};
    s.milestonesSetup ??= false;
    s.templates ||= { days: [], windows: [] };
    s.templates.days ||= [];
    s.templates.windows ||= [];
    // Reactions were renamed: okay -> liked, notyet -> notready.
    const renamed = { okay: "liked", notyet: "notready" };
    for (const p of Object.values(s.plans)) for (const w of p.windows || []) for (const it of w.items || []) {
      if (renamed[it.reaction]) it.reaction = renamed[it.reaction];
    }
    s.hiddenToyIds ||= [];
    // Bring saved data up to date with the latest starter activities and toys.
    if ((s.seedVersion || 0) < SEED_VERSION) {
      const seedById = new Map(SEED.map((a) => [a.id, a]));
      s.activities = s.activities
        .filter((a) => a.custom || a.edited || !REMOVED_SEED_IDS.includes(a.id))
        .map((a) => (!a.custom && !a.edited && seedById.has(a.id) ? { ...seedById.get(a.id), custom: false, fav: !!a.fav } : a));
      const have = new Set(s.activities.map((a) => a.id));
      for (const a of SEED) {
        if (!have.has(a.id) && !s.hiddenSeedIds.includes(a.id)) s.activities.push({ ...a, custom: false, fav: false });
      }
      const haveToys = new Set(s.toys.map((t) => t.id));
      for (const t of TOYS) {
        if (!haveToys.has(t.id) && !s.hiddenToyIds.includes(t.id)) s.toys.push({ ...t, custom: false, periods: [] });
      }
      s.seedVersion = SEED_VERSION;
    }
    return s;
  }
}

let state = load();
function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { toast("Couldn't save. Storage may be full."); }
}
function save() {
  saveLocal();
  sync.schedulePush();
}
save();

const ui = {
  tab: "now",
  planDay: "today",
  lib: { q: "", age: "now", skill: null, tag: null, fav: false },
  showRetired: false,
  updateAvailable: null,
  sync: { ...sync.status },
  pendingRender: false,
  sheet: null, // { type, ...args }
  openReactions: new Set(), // item ids showing reaction chips
  addMode: "plan",           // "plan" adds to the plan; "done" logs it as already done
  clip: null,                // copied window activities { label, activities: [ids] }
  expanded: new Set(),       // finished windows the person opened on the Plan tab
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
  if (!state.settings.birthdate) return { months: -1, days: 0, decimal: -1 };
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

const milestoneById = (id) => MILESTONES.find((m) => m.id === id);
const unmetNeeds = (a) => (state.milestonesSetup ? (a.needs || []).filter((id) => !state.milestones[id]) : []);
// Right for her now: in the age range and any needed milestones reached.
// Reaching a needed milestone early lets an activity show up to 2 months sooner.
function fitsAge(a, decimal) {
  if (unmetNeeds(a).length) return false;
  const early = state.milestonesSetup && (a.needs || []).length ? 2 : 0;
  return a.minAge - early <= decimal && decimal < a.maxAge + 1;
}
function lockReason(a) {
  const un = unmetNeeds(a);
  if (un.length) return `Unlocks when she ${un.map((id) => milestoneById(id)?.label.toLowerCase()).join(" and ")}`;
  return "";
}

/* Search ------------------------------------------------ */
const SYNONYMS = {
  scarf: ["silk", "scarf"], scarves: ["silk", "scarf"], silks: ["silk"], cups: ["cup"], blocks: ["block"],
  balls: ["ball"], pillow: ["cushion", "pillow"], pillows: ["cushion", "pillow"], cushions: ["cushion"],
  sofa: ["couch"], pan: ["pot", "pan"], pans: ["pot", "pan"], pots: ["pot"], octopus: ["opus", "octopus"],
  triangle: ["pikler"], keys: ["key"], books: ["book"], boxes: ["box"], spoons: ["spoon"], toys: ["toy"],
  tiles: ["tile"], textures: ["texture", "tile"], bubbles: ["bubble"], music: ["music", "song", "piano", "tonie"],
  songs: ["song"], outside: ["outside", "walk", "nature", "stroller"], bath: ["bath", "water"],
};
function searchTerms(q) {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean).map((w) => {
    const alts = new Set([w, ...(SYNONYMS[w] || [])]);
    if (w.length > 3 && w.endsWith("s")) alts.add(w.slice(0, -1));
    return [...alts];
  });
}
function activityHaystack(a) {
  const toyNames = (a.toys || []).map((id) => toyById(id)?.name || "");
  return [a.title, a.how, ...(a.materials || []), ...toyNames].join(" ").toLowerCase();
}
const matchesSearch = (a, terms) => { const hay = activityHaystack(a); return terms.every((alts) => alts.some((t) => hay.includes(t))); };

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
const REACTIONS = { loved: "Loved it", liked: "Liked it", notinterested: "Not interested", notready: "Not ready" };
function historyFor(activityId) {
  const out = { done: 0, loved: 0, liked: 0, notinterested: 0, notready: 0, last: null, lastNotReady: null, lastNotInterested: null };
  for (const [k, p] of Object.entries(state.plans)) {
    for (const w of p.windows) for (const it of w.items) {
      if (it.activityId !== activityId || !it.done) continue;
      out.done++;
      if (it.reaction) out[it.reaction]++;
      if (!out.last || k > out.last) out.last = k;
      if (it.reaction === "notready" && (!out.lastNotReady || k > out.lastNotReady)) out.lastNotReady = k;
      if (it.reaction === "notinterested" && (!out.lastNotInterested || k > out.lastNotInterested)) out.lastNotInterested = k;
    }
  }
  return out;
}

/* Toys -------------------------------------------------- */
const toyById = (id) => state.toys.find((t) => t.id === id);
const toysOut = () => state.toys.filter((t) => t.status === "out");
const toysStored = () => state.toys.filter((t) => t.status === "stored");
const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);
function toyDaysOut(t) {
  const p = t.periods?.[t.periods.length - 1];
  return t.status === "out" && p && !p.end ? daysBetween(p.start, todayKey()) : 0;
}
function toyDaysStored(t) {
  const last = [...(t.periods || [])].reverse().find((p) => p.end);
  return last ? daysBetween(last.end, todayKey()) : null; // null = never out
}
function setToyStatus(t, next) {
  if (t.status === next) return;
  t.periods ||= [];
  const open = t.periods[t.periods.length - 1];
  if (t.status === "out" && open && !open.end) open.end = todayKey();
  if (next === "out") t.periods.push({ start: todayKey(), end: null });
  t.status = next;
}
const toyActivities = (t) => state.activities.filter((a) => (a.toys || []).includes(t.id));
function toyFitCount(t) {
  const age = ageMonths().decimal;
  return toyActivities(t).filter((a) => fitsAge(a, age)).length;
}
const activityToysOut = (a) => (a.toys || []).length > 0 && a.toys.every((id) => toyById(id)?.status === "out");
const activityToysAway = (a) => (a.toys || []).some((id) => { const t = toyById(id); return t && t.status !== "out"; });

function rotationPlan({ fresh = false } = {}) {
  const { outTarget, rotateDays } = state.settings;
  const out = toysOut().sort((a, b) => toyDaysOut(b) - toyDaysOut(a));
  let putAway = out.filter((t) => toyDaysOut(t) >= rotateDays);
  if (!putAway.length && out.length && !fresh) putAway = out.slice(0, Math.max(1, Math.ceil(out.length / 2)));
  const staying = out.filter((t) => !putAway.includes(t));
  const covered = new Set(staying.flatMap((t) => toyActivities(t).flatMap((a) => a.skills)));
  const bringCount = Math.max(0, outTarget - staying.length);
  const ranked = toysStored().map((t) => {
    const stored = toyDaysStored(t);
    const fit = toyFitCount(t);
    const linked = toyActivities(t).length;
    let score = stored === null ? 40 : Math.min(stored, 40);
    score += Math.min(fit, 3) * 4;
    if (linked && !fit) score -= 30; // nothing for her age right now
    const skills = new Set(toyActivities(t).filter((a) => fitsAge(a, ageMonths().decimal)).flatMap((a) => a.skills));
    score += [...skills].filter((k) => !covered.has(k)).length * 3;
    return { t, score };
  }).sort((a, b) => b.score - a.score);
  const bringOut = [];
  for (const { t } of ranked) {
    if (bringOut.length >= bringCount) break;
    bringOut.push(t);
    for (const a of toyActivities(t)) for (const k of a.skills) covered.add(k);
  }
  return { putAway, bringOut };
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
  const oneWeekAgo = dateKey(addDays(parseKey(k), -7));

  const picks = [];
  let budget = maxMinutes;
  for (let n = 0; n < count; n++) {
    const scored = state.activities
      .filter((a) => fitsAge(a, age) && !inDay.has(a.id) && a.minutes <= budget)
      .map((a) => {
        const h = historyFor(a.id);
        if (h.lastNotReady && h.lastNotReady >= twoWeeksAgo) return null;
        if (h.lastNotInterested && h.lastNotInterested >= oneWeekAgo) return null;
        let score = Math.random() * 2.5;
        for (const s of a.skills) score += skillCount[s] ? 1 / (1 + skillCount[s]) : 3;
        score += h.loved * 1.5 + h.liked * 0.5 - h.notinterested * 1.5 + (a.fav ? 2 : 0);
        if (activityToysOut(a)) score += 2.5;
        else if (activityToysAway(a)) score -= 3;
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
let undoSnapshot = null;
function toastUndo(msg, snapshot) {
  undoSnapshot = snapshot;
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span><button type="button" data-action="undo">Undo</button>`;
  t.classList.add("show", "has-action");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show", "has-action"); undoSnapshot = null; }, 6000);
}
let toastTimer;
function toast(msg) {
  $("#toast").classList.remove("has-action");
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
  chev: `<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`,
  grip: `<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`,
};

/* =========================================================
   Views
   ========================================================= */
function header(title, sub) {
  const banner = ui.updateAvailable
    ? `<div class="update-banner" role="status"><span>A new version of The Playroom is ready.</span><button class="btn small primary" data-action="hard-refresh">Update now</button></div>`
    : "";
  return banner + `<header class="top"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div>
    <button class="icon-btn" data-action="settings" aria-label="Settings">${I.gear}</button></header>`;
}

function itemRow(k, w, it, { reactions = false, drag = false } = {}) {
  const a = act(it.activityId);
  if (!a) return "";
  const showR = reactions && it.done && (ui.openReactions.has(it.id) || !it.reaction);
  const rLabel = REACTIONS;
  return `<li class="item ${it.done ? "done" : ""} ${drag ? "draggable" : ""}" data-item="${it.id}">
    ${drag ? `<span class="grip" data-day="${k}" data-win="${w.id}" data-item="${it.id}" aria-label="Drag to reorder" role="button" tabindex="-1">${I.grip}</span>` : ""}
    <button class="check" data-action="toggle" data-day="${k}" data-win="${w.id}" data-item="${it.id}" aria-pressed="${it.done}" aria-label="${it.done ? "Mark not done" : "Mark done"}: ${esc(a.title)}">${I.check}</button>
    <button class="item-main" data-action="item" data-day="${k}" data-win="${w.id}" data-item="${it.id}">
      <span class="item-title">${esc(a.title)}</span>
      <span class="item-meta">${skillDots(a.skills)} ${a.minutes} min${it.reaction && !showR ? ` · ${rLabel[it.reaction]}` : ""}</span>
    </button>
    <button class="more" data-action="item" data-day="${k}" data-win="${w.id}" data-item="${it.id}" aria-label="Options">${I.more}</button>
    ${showR ? `<div class="reactions" role="group" aria-label="How did it go?">
      ${Object.keys(REACTIONS).map((r) => `<button class="chip" data-action="react" data-r="${r}" data-day="${k}" data-win="${w.id}" data-item="${it.id}" aria-pressed="${it.reaction === r}">${rLabel[r]}</button>`).join("")}
    </div>` : ""}
  </li>`;
}

function stacker(k) {
  const plan = ensurePlan(k);
  const counts = {}, planned = {};
  for (const w of plan.windows) for (const it of w.items) for (const s of act(it.activityId)?.skills || []) {
    if (it.done) counts[s] = (counts[s] || 0) + 1;
    else planned[s] = (planned[s] || 0) + 1;
  }
  // Ring shade: planned only = pale; each completed activity deepens it, full color at 3.
  const shade = (sk) => (counts[sk] ? [0, 0.55, 0.78, 1][Math.min(counts[sk], 3)] : 0);
  const order = ["gross", "fine", "sensory", "language", "social", "cognitive"]; // bottom to top
  const widths = [124, 110, 96, 82, 68, 54];
  const practiced = order.filter((s) => counts[s]).length;
  const missing = order.filter((s) => !counts[s]);
  const note = practiced === 6 ? "Every skill got some play today."
    : practiced === 0 ? "Rings fill in as you check off activities. Add an activity for any skill:"
    : "Not done yet today. Tap a skill to add an activity for it:";
  return `<section class="stacker-wrap" aria-label="Skills practiced today">
    <div class="stacker" aria-hidden="true">${order.map((s, i) => `<span class="ring ${shade(s) ? "on" : planned[s] ? "planned" : ""}" style="--c:var(--${s});width:${widths[i]}px">${shade(s) ? `<i style="background:var(--${s});opacity:${shade(s)}"></i>` : ""}</span>`).join("")}</div>
    <ul class="legend">${[...order].reverse().map((s) => `<li class="${counts[s] ? "on" : planned[s] ? "planned" : ""}"><i class="dot" style="background:var(--${s})"></i>${SKILLS[s].label}<span class="n">${counts[s] ? `${counts[s]} done` : planned[s] ? `${planned[s]} planned` : ""}</span></li>`).join("")}</ul>
    <p class="stacker-note">${note}</p>
    ${missing.length ? `<div class="skill-gaps">${missing.map((sk) => `<button class="chip" data-action="skill-pick" data-skill="${sk}" data-day="${k}"><i class="dot" style="background:var(--${sk})"></i>${SKILLS[sk].label}${planned[sk] ? " · planned" : ""}</button>`).join("")}</div>` : ""}
  </section>`;
}

// A window left running past midnight gets closed at a best guess so the day can move on.
function closeStaleWindows() {
  const today = todayKey();
  let changed = false;
  for (const [k, p] of Object.entries(state.plans)) {
    if (k >= today) continue;
    for (const w of p.windows) {
      if (w.startedAt && !w.endedAt) {
        const guess = new Date(new Date(w.startedAt).getTime() + state.settings.windowTarget * 60000);
        const endOfDay = parseKey(k); endOfDay.setHours(23, 59, 0, 0);
        w.endedAt = new Date(Math.min(guess, endOfDay)).toISOString();
        w.estimatedEnd = true;
        changed = true;
      }
    }
  }
  if (changed) save();
}
function staleNotice() {
  const y = dateKey(addDays(new Date(), -1));
  const w = state.plans[y]?.windows.find((x) => x.estimatedEnd);
  if (!w) return "";
  return `<div class="notice">
    <p>Yesterday's ${esc(w.label)} window was still running, so it was closed at ${fmtTime(w.endedAt)}.</p>
    <div class="btn-row"><button class="btn small" data-action="edit-times" data-day="${y}" data-win="${w.id}">Fix the time</button><button class="btn small ghost" data-action="stale-ok" data-day="${y}" data-win="${w.id}">Looks right</button></div>
  </div>`;
}

function viewNow() {
  closeStaleWindows();
  const k = todayKey();
  const plan = ensurePlan(k);
  const name = esc(state.settings.name);
  const active = plan.windows.find((w) => w.startedAt && !w.endedAt);
  const next = plan.windows.find((w) => !w.startedAt);
  let hero;

  if (active) {
    const target = state.settings.windowTarget;
    hero = `<section class="hero">
      <div class="label">${esc(active.label)} · awake since <button class="link" data-action="edit-times" data-day="${k}" data-win="${active.id}">${fmtTime(active.startedAt)}</button></div>
      <div class="clock" data-timer="${active.startedAt}">${fmtElapsed(Date.now() - new Date(active.startedAt))}</div>
      <div class="meter" data-meter="${active.startedAt}" data-target="${target}"><i></i></div>
      <div class="hint" data-hint="${active.startedAt}" data-target="${target}"></div>
      ${active.items.length
        ? `<ul class="list">${active.items.map((it) => itemRow(k, active, it, { reactions: true })).join("")}</ul>`
        : `<div class="empty">Nothing planned for this window yet.</div>`}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn small" data-action="pick" data-day="${k}" data-win="${active.id}" data-fit="1">Add activity</button>
        <button class="btn small" data-action="suggest-one" data-day="${k}" data-win="${active.id}">Suggest one</button>
        <button class="btn small" data-action="pick" data-day="${k}" data-win="${active.id}" data-mode="done">Log what we did</button>
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
        <button class="btn primary" data-action="plan-tomorrow">Plan tomorrow for me</button>
      </div>
    </section>`;
  }

  const rows = plan.windows.map((w) => {
    const d = w.items.filter((i) => i.done).length;
    const cls = w.startedAt && !w.endedAt ? "active" : w.endedAt ? "ended" : "";
    const when = w.startedAt ? `${fmtTime(w.startedAt)}${w.endedAt ? `–${fmtTime(w.endedAt)}` : " – now"}` : "";
    return `<button class="day-row ${cls}" data-action="edit-times" data-day="${k}" data-win="${w.id}" aria-label="Edit ${esc(w.label)} times"><span class="state"></span><div><strong>${esc(w.label)}</strong><div class="status" style="font-size:13px;color:var(--muted)">${when || "Tap to log times"}</div></div><span class="count">${d}/${w.items.length}</span></button>`;
  }).join("");

  const reached = Object.keys(state.milestones).length;
  const quick = `<div class="quick-row">
    <button class="quick" data-action="recap"><strong>This week</strong><span class="item-meta">Skills, favorites, toys, naps</span></button>
    <button class="quick" data-action="milestones"><strong>Milestones</strong><span class="item-meta">${state.milestonesSetup ? `${reached} reached` : "Log what she can do"}</span></button>
  </div>`;
  return header(parseKey(k).toLocaleDateString([], { weekday: "long" }), ageLabel() ? `${name} is ${ageLabel()}` : "")
    + staleNotice()
    + hero
    + quick
    + toysSummary()
    + `<h2>Skills today</h2>` + stacker(k)
    + `<h2>Today's windows</h2>` + rows;
}

function toysSummary() {
  const out = toysOut();
  const due = out.filter((t) => toyDaysOut(t) >= state.settings.rotateDays).length;
  const names = out.slice(0, 3).map((t) => esc(t.name)).join(", ") + (out.length > 3 ? ` +${out.length - 3} more` : "");
  return `<button class="toys-strip ${due ? "due" : ""}" data-action="goto-toys">
    <span class="toys-strip-main"><strong>${out.length ? `${out.length} ${out.length === 1 ? "toy" : "toys"} out` : "No toys marked as out"}</strong>
    <span class="item-meta">${out.length ? names : "Tap to choose what's in her play space"}</span></span>
    ${due ? `<span class="badge">${due} ready to swap</span>` : ""}
  </button>`;
}

function toyRow(t) {
  const out = t.status === "out";
  const days = out ? toyDaysOut(t) : toyDaysStored(t);
  const due = out && days >= state.settings.rotateDays;
  const when = t.status === "retired" ? "Outgrown"
    : out ? (days === 0 ? "Out since today" : `Out ${days} ${days === 1 ? "day" : "days"}`)
    : days === null ? "Not out yet" : days === 0 ? "Put away today" : `Put away ${days} ${days === 1 ? "day" : "days"} ago`;
  const fit = toyFitCount(t);
  return `<li class="toy-row ${due ? "due" : ""}">
    <button class="item-main" data-action="toy" data-id="${t.id}">
      <span class="item-title">${esc(t.name)}</span>
      <span class="item-meta">${when}${fit ? ` · ${fit} ${fit === 1 ? "activity" : "activities"} for her age` : ""}${due ? ` · <span class="due-text">Time to swap</span>` : ""}</span>
    </button>
    ${t.status === "retired" ? "" : `<button class="btn small" data-action="toy-toggle" data-id="${t.id}">${out ? "Put away" : "Bring out"}</button>`}
  </li>`;
}

function viewToys() {
  const { outTarget, rotateDays } = state.settings;
  const out = toysOut().sort((a, b) => toyDaysOut(b) - toyDaysOut(a));
  const stored = toysStored().sort((a, b) => (toyDaysStored(b) ?? 9999) - (toyDaysStored(a) ?? 9999));
  const retired = state.toys.filter((t) => t.status === "retired");
  const due = out.filter((t) => toyDaysOut(t) >= rotateDays);
  const nextDue = out.length ? Math.max(0, rotateDays - toyDaysOut(out[0])) : null;

  let hero;
  if (!out.length) {
    hero = `<section class="hero">
      <div class="label">Toy rotation</div>
      <div class="resting">Keep ${outTarget} toys out at a time and swap them every ${rotateDays} days.</div>
      <button class="link" data-action="rotation-settings">Change these numbers</button>
      <p class="hint">Fewer toys out means longer, deeper play, and toys feel new again when they come back.</p>
      <button class="btn primary big" data-action="rotate" data-fresh="1">Pick a starting set for me</button>
      <button class="btn big" style="margin-top:8px" data-action="choose-out">Choose what's out myself</button>
    </section>`;
  } else {
    hero = `<section class="hero">
      <div class="label">${out.length} of ${outTarget} toys out · swap every ${rotateDays} days · <button class="link" data-action="rotation-settings">Change</button></div>
      <div class="resting">${due.length ? `${due.length} ${due.length === 1 ? "toy has" : "toys have"} been out ${rotateDays}+ days.` : nextDue === 0 ? "A swap is due today." : `Next swap in ${nextDue} ${nextDue === 1 ? "day" : "days"}.`}</div>
      <button class="btn ${due.length ? "primary" : ""} big" data-action="rotate">${due.length ? "Swap toys now" : "Swap early"}</button>
    </section>`;
  }

  return header("Toys", `${out.length} out · ${stored.length} in storage`)
    + hero
    + (out.length ? `<h2>Out now</h2><ul class="list toy-list">${out.map(toyRow).join("")}</ul>` : "")
    + `<h2>In storage</h2>${stored.length ? `<ul class="list toy-list">${stored.map(toyRow).join("")}</ul>` : `<div class="empty">Everything is out.</div>`}`
    + (retired.length ? `<button class="btn ghost small" style="margin-top:14px" data-action="toggle-retired">${ui.showRetired ? "Hide" : "Show"} outgrown toys (${retired.length})</button>${ui.showRetired ? `<ul class="list toy-list">${retired.map(toyRow).join("")}</ul>` : ""}` : "")
    + `<div class="plan-foot" style="margin-top:20px"><button class="btn" data-action="new-toy">Add a toy</button></div>`;
}

function viewPlan() {
  const isToday = ui.planDay === "today";
  const k = isToday ? todayKey() : tomorrowKey();
  const plan = ensurePlan(k);
  const cards = plan.windows.map((w) => {
    const mins = windowMinutes(w);
    const status = w.endedAt ? `Done · ${fmtTime(w.startedAt)}–${fmtTime(w.endedAt)}` : w.startedAt ? `Happening now · since ${fmtTime(w.startedAt)}` : "";
    if (w.endedAt && !ui.expanded.has(w.id)) {
      const doneCount = w.items.filter((i) => i.done).length;
      return `<section class="card collapsed" data-win="${w.id}">
        <button class="collapse-toggle" data-action="toggle-window" data-win="${w.id}" aria-expanded="false">
          <span class="grow"><span class="card-title">${esc(w.label)}</span>
          <span class="item-meta">${fmtTime(w.startedAt)}–${fmtTime(w.endedAt)} · ${doneCount} of ${w.items.length} done ${skillDots([...new Set(w.items.filter((i) => i.done).flatMap((i) => act(i.activityId)?.skills || []))])}</span></span>
          <span class="chev" aria-hidden="true">${I.chev}</span>
        </button>
      </section>`;
    }
    return `<section class="card ${w.endedAt ? "expanded" : ""}" data-win="${w.id}">
      <div class="card-head">
        <button class="rename" data-action="rename" data-day="${k}" data-win="${w.id}" aria-label="Rename ${esc(w.label)}">${esc(w.label)}</button>
        <span class="mins">${mins ? fmtMin(mins) : ""}</span>
        <button class="more" data-action="window-menu" data-day="${k}" data-win="${w.id}" aria-label="${esc(w.label)} options">${I.more}</button>
        ${w.endedAt ? `<button class="more chev up" data-action="toggle-window" data-win="${w.id}" aria-expanded="true" aria-label="Collapse ${esc(w.label)}">${I.chev}</button>` : ""}
      </div>
      <button class="status link" data-action="edit-times" data-day="${k}" data-win="${w.id}">${status || (isToday ? "Log wake and nap times" : "")}</button>
      <ul class="list drop" data-day="${k}" data-win="${w.id}">${w.items.map((it) => itemRow(k, w, it, { reactions: true, drag: true })).join("")}<li class="empty empty-li">Empty window. Drag activities here or add some.</li></ul>
      <div class="btn-row">
        <button class="btn small" data-action="pick" data-day="${k}" data-win="${w.id}">Add</button>
        <button class="btn small" data-action="fill" data-day="${k}" data-win="${w.id}">Fill with ideas</button>
        ${ui.clip ? `<button class="btn small" data-action="paste-window" data-day="${k}" data-win="${w.id}">Paste ${ui.clip.activities.length}</button>` : ""}
      </div>
    </section>`;
  }).join("");
  const emptyDay = !plan.windows.some((w) => w.items.length);
  const dayTpls = state.templates.days;

  return header(isToday ? "Plan today" : "Plan tomorrow", dayName(k))
    + `<div class="seg" role="group" aria-label="Day">
        <button data-action="plan-day" data-day="today" aria-pressed="${isToday}">Today</button>
        <button data-action="plan-day" data-day="tomorrow" aria-pressed="${!isToday}">Tomorrow</button>
      </div>`
    + `<div class="plan-actions">
        <button class="btn ${emptyDay ? "primary" : ""}" data-action="plan-day-auto" data-day="${k}">Plan ${isToday ? "today" : "tomorrow"} for me</button>
        <button class="btn" data-action="day-templates" data-day="${k}">${dayTpls.length ? "Use a template" : "Templates"}</button>
      </div>`
    + (ui.clip ? `<div class="clip-bar"><span>Copied ${ui.clip.activities.length} from ${esc(ui.clip.label)}. Tap Paste on any window.</span><button class="btn small ghost" data-action="clip-clear">Done</button></div>` : "")
    + cards
    + `<div class="plan-foot">
        <button class="btn" data-action="add-window" data-day="${k}">Add a window</button>
        ${isToday ? "" : `<button class="btn" data-action="copy-today">Copy today's plan</button>`}
        <button class="btn" data-action="save-day-template" data-day="${k}">Save this day as a template</button>
        <button class="btn ghost danger" data-action="clear-day" data-day="${k}">Clear ${isToday ? "today" : "tomorrow"}</button>
      </div>`;
}

function libraryResults() {
  const { q, age, skill, tag, fav } = ui.lib;
  const now = ageMonths().decimal;
  const terms = searchTerms(q);
  const searching = terms.length > 0;
  return state.activities
    .filter((a) => {
      // A search looks across every age so you can see what's possible.
      if (!searching && age === "now" && !fitsAge(a, now)) return false;
      if (!searching && age === "soon" && !(fitsAge(a, now) ? false : (a.minAge > now && a.minAge <= now + 3) || (unmetNeeds(a).length && a.maxAge + 1 > now))) return false;
      if (skill && !a.skills.includes(skill)) return false;
      if (tag === "out-now") { if (!activityToysOut(a)) return false; }
      else if (tag && !(a.tags || []).includes(tag)) return false;
      if (fav && !a.fav) return false;
      if (searching && !matchesSearch(a, terms)) return false;
      return true;
    })
    .sort((x, y) => (searching ? Number(fitsAge(y, now)) - Number(fitsAge(x, now)) : 0) || Number(y.fav) - Number(x.fav) || x.minAge - y.minAge || x.title.localeCompare(y.title));
}

function libraryList() {
  const list = libraryResults();
  const now = ageMonths().decimal;
  const q = ui.lib.q.trim();
  const searching = searchTerms(q).length > 0;
  const toyHits = searching ? state.toys.filter((t) => t.status !== "retired" && searchTerms(q).every((alts) => alts.some((w) => `${t.name} ${t.brand}`.toLowerCase().includes(w)))) : [];
  const toyChips = toyHits.length ? `<div class="filters">${toyHits.map((t) => `<button class="chip" data-action="toy" data-id="${t.id}">${esc(t.name)}${t.status === "out" ? " · out" : ""}</button>`).join("")}</div>` : "";
  const label = searching ? `for "${esc(q)}" (${list.filter((a) => fitsAge(a, now)).length} right for her now)` : ui.lib.age === "now" ? `right for ${esc(state.settings.name)} now` : ui.lib.age === "soon" ? "coming up" : "in the library";
  if (!list.length) return toyChips + `<p class="result-count">No activities ${searching ? `for "${esc(q)}"` : "match"}.</p><div class="empty">Try another word, or add your own with New activity.</div>`;
  return toyChips + `<p class="result-count">${list.length} ${list.length === 1 ? "idea" : "ideas"} ${label}</p>` + list.map((a) => {
    const lock = lockReason(a);
    const notNow = searching && !fitsAge(a, now);
    return `
    <button class="lib-item ${notNow ? "later" : ""}" data-action="detail" data-id="${a.id}">
      <div class="row1"><h3>${a.fav ? `<span class="star" aria-label="Favorite">★</span> ` : ""}${esc(a.title)}</h3><span class="mins">${a.minutes} min</span></div>
      <div class="item-meta">${skillDots(a.skills)} ${ageRange(a)}${a.custom ? " · Yours" : (a.tags || []).includes("her-toys") ? " · Her toys" : ""}</div>
      ${lock ? `<div class="item-meta lock">${esc(lock)}</div>` : notNow ? `<div class="item-meta lock">${a.minAge > now ? "Coming up" : "For younger babies"}</div>` : ""}
      ${a.materials?.length ? `<div class="mat">${esc(a.materials.join(", "))}</div>` : ""}
    </button>`;
  }).join("");
}

function viewLibrary() {
  const { q, age, skill, tag, fav } = ui.lib;
  return header("Library", `${state.activities.length} activities`)
    + `<input class="search" type="search" placeholder="What can I do with… (tape, cups, scarves)" value="${esc(q)}" data-input="lib-q" aria-label="Search activities">
      <div class="filters" role="group" aria-label="Filters">
        <button class="chip" data-action="lib-age" data-v="now" aria-pressed="${age === "now"}">For ${esc(state.settings.name)} now</button>
        <button class="chip" data-action="lib-age" data-v="soon" aria-pressed="${age === "soon"}">Coming up</button>
        <button class="chip" data-action="lib-age" data-v="all" aria-pressed="${age === "all"}">All ages</button>
        <button class="chip" data-action="lib-fav" aria-pressed="${fav}">★ Favorites</button>
        <button class="chip" data-action="lib-tag" data-v="out-now" aria-pressed="${tag === "out-now"}">Toys out now</button>
        ${Object.entries(TAGS).map(([key, t]) => `<button class="chip" data-action="lib-tag" data-v="${key}" aria-pressed="${tag === key}">${t.label}</button>`).join("")}
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
  if (h.liked) parts.push(`liked ${h.liked}×`);
  if (h.notinterested) parts.push(`not interested ${h.notinterested}×`);
  if (h.notready) parts.push(`not ready ${h.notready}×`);
  if (h.last) parts.push(`last on ${parseKey(h.last).toLocaleDateString([], { month: "short", day: "numeric" })}`);
  const inPlan = item ? findWindow(day, win) : null;

  const body = `
    <div class="facts">
      <span class="fact">${a.minutes} min</span>
      <span class="fact">${ageRange(a)}</span>
      ${a.skills.map((s) => `<span class="fact"><i class="dot" style="background:var(--${s})"></i>${SKILLS[s].label}</span>`).join("")}
      ${(a.tags || []).filter((t) => t !== "her-toys" || !(a.toys || []).length).map((t) => TAGS[t] ? `<span class="fact">${TAGS[t].label}</span>` : "").join("")}
      ${(a.toys || []).map((id) => toyById(id)).filter(Boolean).map((t) => `<button class="fact toy-fact ${t.status === "out" ? "out" : ""}" data-action="toy" data-id="${t.id}">${esc(t.name)}${t.status === "out" ? " · out" : " · put away"}</button>`).join("")}
    </div>
    ${parts.length ? `<p class="history">${parts.join(", ")}.</p>` : ""}
    ${lockReason(a) ? `<p class="history lock">${esc(lockReason(a))}.</p>` : ""}
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

function modeSeg() {
  return `<div class="seg" role="group" aria-label="How to add">
      <button data-action="add-mode" data-v="plan" aria-pressed="${ui.addMode === "plan"}">Add to plan</button>
      <button data-action="add-mode" data-v="done" aria-pressed="${ui.addMode === "done"}">Log as done</button>
    </div>`;
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
  const terms = searchTerms(ui.pickQ || "");
  const list = state.activities
    .filter((a) => fitsAge(a, age) && (ui.addMode === "done" || a.minutes <= remaining))
    .filter((a) => !terms.length || matchesSearch(a, terms))
    .sort((x, y) => Number(y.fav) - Number(x.fav) || x.title.localeCompare(y.title));
  const body = `
    ${modeSeg()}
    ${ui.addMode === "done" ? `<p class="history">Tap what you just did and it's checked off right away.</p>` : remaining !== Infinity ? `<p class="history">Showing activities that fit the ${remaining} min left in this window.</p>` : `<p class="history">Showing activities right for ${esc(state.settings.name)} on ${parseKey(day).toLocaleDateString([], { weekday: "long" })}.</p>`}
    <div class="field"><input class="search" type="search" placeholder="Search" value="${esc(ui.pickQ || "")}" data-input="pick-q" aria-label="Search"></div>
    <div class="pick-list" id="pick-results">${list.map((a) => `
      <button class="pick ${inWin.has(a.id) ? "added" : ""}" data-action="pick-add" data-id="${a.id}" data-day="${day}" data-win="${win}">
        <span class="grow"><strong>${a.fav ? "★ " : ""}${esc(a.title)}</strong><div class="item-meta">${skillDots(a.skills)} ${a.minutes} min${a.materials?.length ? ` · ${esc(a.materials[0])}${a.materials.length > 1 ? " +" + (a.materials.length - 1) : ""}` : ""}</div></span>
        <span class="plus">${inWin.has(a.id) ? "✓" : "+"}</span>
      </button>`).join("") || `<div class="empty">Nothing fits. Try the library for more.</div>`}
    </div>
    <div class="btn-row"><button class="btn primary" data-action="close-sheet">Done</button></div>`;
  return sheetShell(ui.addMode === "done" ? `Log in ${w.label}` : `Add to ${w.label}`, body);
}

function sheetForm({ id, toy }) {
  const a = id ? act(id) : { title: "", minAge: Math.max(0, ageMonths().months), maxAge: 18, minutes: 10, materials: [], skills: [], how: "", safety: "", toys: toy ? [toy] : [] };
  const toyChoices = state.toys.filter((t) => t.status !== "retired" || (a.toys || []).includes(t.id));
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
    <div class="field"><span class="lbl">Her toys it uses</span><div class="skill-pick">
      ${toyChoices.map((t) => `<button type="button" class="chip" data-action="form-skill" data-toy="1" data-v="${t.id}" aria-pressed="${(a.toys || []).includes(t.id)}">${esc(t.name)}</button>`).join("")}
      <button type="button" class="chip" data-action="form-skill" data-tag="1" data-v="household" aria-pressed="${(a.tags || []).includes("household")}">Household items</button>
    </div></div>
    <div class="field"><label for="f-mat">Materials</label><textarea id="f-mat" name="materials" placeholder="One per line">${esc((a.materials || []).join("\n"))}</textarea></div>
    <div class="field"><label for="f-how">How to play</label><textarea id="f-how" name="how">${esc(a.how)}</textarea></div>
    <div class="field"><label for="f-safety">Safety notes</label><textarea id="f-safety" name="safety" style="min-height:60px">${esc(a.safety)}</textarea></div>
    <div class="btn-row"><button class="btn primary" type="submit">${id ? "Save changes" : "Add to library"}</button></div>
  </form>`;
  return sheetShell(id ? "Edit activity" : "New activity", body);
}

function syncSection() {
  const st = ui.sync;
  const when = st.lastSynced ? new Date(st.lastSynced).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  if (st.state === "off") {
    return `<p class="history">Sign in so your plans, toys, and library stay the same on every family phone.</p>
      <div class="btn-row"><button class="btn small primary" data-action="signin">Sign in</button></div>`;
  }
  if (st.state === "unverified") {
    return `<p class="history">We sent a verification link to ${esc(st.email)}. Open it, then come back and tap I've verified.</p>
      <div class="btn-row">
        <button class="btn small primary" data-action="sync-recheck">I've verified</button>
        <button class="btn small" data-action="sync-resend">Send the link again</button>
        <button class="btn small ghost" data-action="signout">Sign out</button>
      </div>`;
  }
  const line = {
    connecting: "Connecting…",
    syncing: "Syncing…",
    synced: `Synced${when ? ` at ${when}` : ""}.`,
    offline: "Offline. Changes are saved on this phone and will sync when you're back online.",
    denied: st.error,
  }[st.state] || "";
  return `<p class="history">${st.email ? `Signed in as ${esc(st.email)}. ` : ""}${esc(line)}</p>
    ${st.state === "denied" ? "" : ""}
    <div class="btn-row"><button class="btn small ghost" data-action="signout">Sign out</button></div>`;
}

function sheetSignIn(s) {
  const body = `<p class="history">Use the same account on each phone. Google works best in Safari; email and password works everywhere, including the home-screen app.</p>
    <div class="btn-row"><button class="btn primary" data-action="signin-google">Continue with Google</button></div>
    <form data-form="signin" style="margin-top:8px">
      <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="username" required value="${esc(s.email || "")}"></div>
      <div class="field"><label for="a-pass">Password</label><input id="a-pass" name="password" type="password" autocomplete="current-password" minlength="6" required></div>
      ${s.error ? `<p class="safety" style="margin-top:12px">${esc(s.error)}</p>` : ""}
      <div class="btn-row">
        <button class="btn primary" type="submit" name="mode" value="signin">Sign in</button>
        <button class="btn" type="submit" name="mode" value="create">Create account</button>
      </div>
      <div class="btn-row"><button class="btn small ghost" type="submit" name="mode" value="reset" formnovalidate>Forgot password</button></div>
    </form>`;
  return sheetShell("Sign in to sync", body);
}

function sheetBackups(s) {
  const list = s.list;
  const body = s.error ? `<p class="safety">${esc(s.error)}</p>`
    : !list ? `<p class="history">Loading backups…</p>`
    : !list.length ? `<div class="empty">No backups yet. The first one saves automatically within a day of signing in.</div>`
    : `<p class="history">Restoring replaces everything on every family phone with that week's copy. You can undo right after.</p>
       <div class="pick-list">${list.map((b) => `<button class="pick" data-action="restore-backup" data-id="${b.id}">
         <span class="grow"><strong>${b.createdAt ? new Date(b.createdAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : esc(b.id)}</strong>
         <div class="item-meta">${esc(b.summary)}${b.createdBy ? ` · saved from ${esc(b.createdBy)}` : ""}</div></span></button>`).join("")}</div>`;
  return sheetShell("Weekly backups", body);
}

function sheetSettings() {
  const s = state.settings;
  const hidden = state.hiddenSeedIds.length;
  const welcome = !s.birthdate;
  const body = `${welcome ? `<p class="history">Welcome to The Playroom. Add your baby's name and birthdate so the library shows activities for her age.</p>
    <p class="history" style="margin-top:8px">Already using it on another phone? <button class="btn small" data-action="signin">Sign in to sync</button></p>` : ""}<form data-form="settings">
    <div class="field"><label for="s-name">Baby's name</label><input id="s-name" name="name" value="${esc(s.name)}"></div>
    <div class="field"><label for="s-bd">Birthdate</label><input id="s-bd" name="birthdate" type="date" required value="${esc(s.birthdate)}"></div>
    <div class="field"><label for="s-wt">Typical wake window (minutes)</label><input id="s-wt" name="windowTarget" type="number" inputmode="numeric" min="30" max="360" value="${s.windowTarget}"><span class="help">Drives the timer on the Now screen. Adjust as her windows stretch.</span></div>
    <div class="field"><label for="s-pm">Activity time per window (minutes)</label><input id="s-pm" name="playMinutes" type="number" inputmode="numeric" min="5" max="240" value="${s.playMinutes}"><span class="help">How much "Fill with ideas" plans, leaving room for feeds and diapers.</span></div>
    <div class="field"><label for="s-wpd">Windows per day</label><input id="s-wpd" name="windowsPerDay" type="number" inputmode="numeric" min="1" max="6" value="${s.windowsPerDay}"><span class="help">Applies to days you haven't planned yet.</span></div>
    <div class="row2" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="s-ot">Toys out at once</label><input id="s-ot" name="outTarget" type="number" inputmode="numeric" min="1" max="20" value="${s.outTarget}"></div>
      <div class="field"><label for="s-rd">Swap every (days)</label><input id="s-rd" name="rotateDays" type="number" inputmode="numeric" min="1" max="60" value="${s.rotateDays}"></div>
    </div>
    <div class="btn-row"><button class="btn primary" type="submit">Save settings</button></div>
  </form>
  <h4>Sync between phones</h4>
  ${syncSection()}
  <h4>Weekly backups</h4>
  ${ui.sync.state === "off" || ui.sync.state === "unverified"
    ? `<p class="history">Sign in above and a copy of everything is saved to the cloud automatically once a week.</p>`
    : `<p class="history">A copy of everything is saved automatically once a week, and the last 8 weeks are kept.${sync.lastBackupAt() ? ` Last saved ${new Date(sync.lastBackupAt()).toLocaleDateString([], { month: "short", day: "numeric" })}.` : ""}</p>
       <div class="btn-row"><button class="btn small" data-action="backups">Restore from a backup</button></div>`}
  <h4>App version</h4>
  <p class="history">You're on version ${APP_VERSION}.${ui.updateAvailable ? ` Version ${esc(ui.updateAvailable)} is ready.` : ""} Updating keeps all your plans and toys.</p>
  <div class="btn-row"><button class="btn small" data-action="hard-refresh">Refresh to latest version</button></div>
  ${hidden ? `<h4>Hidden activities</h4><div class="btn-row"><button class="btn small" data-action="unhide">Restore ${hidden} hidden starter ${hidden === 1 ? "activity" : "activities"}</button></div>` : ""}`;
  return sheetShell(welcome ? "Welcome" : "Settings", body);
}

function sheetToy({ id }) {
  const t = toyById(id);
  if (!t) return "";
  const age = ageMonths().decimal;
  const acts = toyActivities(t);
  const fit = acts.filter((a) => fitsAge(a, age));
  const later = acts.filter((a) => a.minAge > age);
  const times = (t.periods || []).length;
  const status = t.status === "out" ? `Out for ${toyDaysOut(t)} ${toyDaysOut(t) === 1 ? "day" : "days"}`
    : t.status === "retired" ? "Outgrown" : toyDaysStored(t) === null ? "Hasn't been out yet" : `In storage for ${toyDaysStored(t)} days`;
  const actRow = (a) => `<button class="pick" data-action="detail" data-id="${a.id}"><span class="grow"><strong>${esc(a.title)}</strong><div class="item-meta">${skillDots(a.skills)} ${a.minutes} min · ${ageRange(a)}</div></span></button>`;
  const body = `
    <div class="facts">${t.brand ? `<span class="fact">${esc(t.brand)}</span>` : ""}<span class="fact">${status}</span>${times ? `<span class="fact">Out ${times} ${times === 1 ? "time" : "times"}</span>` : ""}</div>
    <div class="btn-row">
      ${t.status === "retired"
        ? `<button class="btn primary" data-action="toy-status" data-id="${t.id}" data-v="stored">Back in rotation</button>`
        : `<button class="btn primary" data-action="toy-toggle" data-id="${t.id}">${t.status === "out" ? "Put away" : "Bring out"}</button>
           <button class="btn" data-action="toy-status" data-id="${t.id}" data-v="retired">Mark outgrown</button>`}
    </div>
    <h4>Activities for her age</h4>
    ${fit.length ? `<div class="pick-list">${fit.map(actRow).join("")}</div>` : `<p class="history">None in the library yet.</p>`}
    ${later.length ? `<h4>Coming up</h4><div class="pick-list">${later.map(actRow).join("")}</div>` : ""}
    <div class="btn-row">
      <button class="btn small" data-action="new-activity" data-toy="${t.id}">Add an activity with this toy</button>
      <button class="btn small" data-action="edit-toy" data-id="${t.id}">Rename</button>
      <button class="btn small danger" data-action="delete-toy" data-id="${t.id}">Remove</button>
    </div>`;
  return sheetShell(t.name, body);
}

function sheetRotate(s) {
  if (!s.putAway) {
    const plan = rotationPlan({ fresh: !!s.fresh });
    s.putAway = plan.putAway.map((t) => t.id);
    s.bringOut = plan.bringOut.map((t) => t.id);
    s.keep = new Set([...s.putAway, ...s.bringOut]);
  }
  const row = (id, verb) => {
    const t = toyById(id);
    const on = s.keep.has(id);
    const sub = verb === "away" ? `Out ${toyDaysOut(t)} days` : toyDaysStored(t) === null ? `Not out yet · ${toyFitCount(t)} activities for her age` : `Stored ${toyDaysStored(t)} days · ${toyFitCount(t)} activities for her age`;
    return `<button class="pick ${on ? "added" : ""}" data-action="rotate-toggle" data-id="${id}" aria-pressed="${on}">
      <span class="grow"><strong>${esc(t.name)}</strong><div class="item-meta">${sub}</div></span><span class="plus">${on ? "✓" : ""}</span></button>`;
  };
  const body = `
    ${s.putAway.length ? `<h4>Put away</h4><div class="pick-list">${s.putAway.map((id) => row(id, "away")).join("")}</div>` : ""}
    ${s.bringOut.length ? `<h4>Bring out</h4><div class="pick-list">${s.bringOut.map((id) => row(id, "out")).join("")}</div>` : `<p class="history">Nothing in storage to bring out.</p>`}
    <p class="history" style="margin-top:12px">Picks favor toys that have been away longest, have activities for her age, and cover skills the other toys don't.</p>
    <div class="btn-row">
      <button class="btn primary" data-action="rotate-apply">Swap ${[...s.keep].length} ${[...s.keep].length === 1 ? "toy" : "toys"}</button>
      <button class="btn" data-action="rotate-reshuffle">Different picks</button>
    </div>`;
  return sheetShell(s.fresh ? "Starting set" : "Swap toys", body);
}

function sheetChooseOut() {
  const list = state.toys.filter((t) => t.status !== "retired");
  const body = `<p class="history">Tap the toys that are in her play space right now.</p>
    <div class="pick-list">${list.map((t) => `<button class="pick ${t.status === "out" ? "added" : ""}" data-action="toy-toggle" data-id="${t.id}" data-stay="1"><span class="grow"><strong>${esc(t.name)}</strong><div class="item-meta">${esc(t.brand || "")}</div></span><span class="plus">${t.status === "out" ? "✓" : "+"}</span></button>`).join("")}</div>
    <div class="btn-row"><button class="btn primary" data-action="close-sheet">Done</button></div>`;
  return sheetShell("What's out now?", body);
}

function sheetSkillPick(s) {
  const k = s.day;
  const plan = ensurePlan(k);
  const age = ageMonths(parseKey(k)).decimal;
  const open = plan.windows.filter((w) => !w.endedAt);
  if (!s.win || !plan.windows.some((w) => w.id === s.win)) {
    s.win = (plan.windows.find((w) => w.startedAt && !w.endedAt) || open[0] || plan.windows[plan.windows.length - 1])?.id;
  }
  const w = findWindow(k, s.win);
  const inWin = new Set(w ? w.items.map((i) => i.activityId) : []);
  const planned = new Set(plan.windows.flatMap((x) => x.items.filter((i) => !i.done).map((i) => i.activityId)));
  const list = state.activities
    .filter((a) => fitsAge(a, age) && a.skills.includes(s.skill))
    .map((a) => {
      const h = historyFor(a.id);
      let score = h.loved * 2 + h.liked - h.notinterested * 2 + (a.fav ? 3 : 0) + (activityToysOut(a) ? 3 : activityToysAway(a) ? -2 : 0);
      if (h.lastNotReady && h.lastNotReady >= dateKey(addDays(parseKey(k), -14))) score -= 10;
      return { a, score };
    })
    .sort((x, y) => y.score - x.score || x.a.title.localeCompare(y.a.title))
    .map((x) => x.a);
  const body = `
    ${modeSeg()}
    <div class="field"><span class="lbl">${ui.addMode === "done" ? "Log in" : "Add to"}</span><div class="skill-pick">
      ${plan.windows.map((x) => `<button class="chip" data-action="skill-pick-win" data-win="${x.id}" aria-pressed="${x.id === s.win}">${esc(x.label)}${x.endedAt ? " (done)" : x.startedAt ? " (now)" : ""}</button>`).join("")}
    </div></div>
    <div class="pick-list">${list.map((a) => {
      const added = inWin.has(a.id);
      const note = activityToysOut(a) ? " · toys out" : activityToysAway(a) ? " · toy put away" : "";
      return `<button class="pick ${added ? "added" : ""}" data-action="skill-pick-add" data-id="${a.id}">
        <span class="grow"><strong>${a.fav ? "★ " : ""}${esc(a.title)}</strong><div class="item-meta">${skillDots(a.skills)} ${a.minutes} min${note}${planned.has(a.id) && !added ? " · planned" : ""}</div></span>
        <span class="plus">${added ? "✓" : "+"}</span></button>`;
    }).join("") || `<div class="empty">No ${SKILLS[s.skill].label.toLowerCase()} activities for her age yet.</div>`}</div>
    <div class="btn-row"><button class="btn primary" data-action="close-sheet">Done</button></div>`;
  return sheetShell(`${SKILLS[s.skill].label} ideas`, body);
}

const timeOf = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
function sheetTimes({ day, win }) {
  const w = findWindow(day, win);
  if (!w) return "";
  const body = `<form data-form="times" data-day="${day}" data-win="${win}">
    <div class="row2" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="w-start">Woke up</label><input id="w-start" name="start" type="time" value="${timeOf(w.startedAt)}"></div>
      <div class="field"><label for="w-end">Fell asleep</label><input id="w-end" name="end" type="time" value="${timeOf(w.endedAt)}"></div>
    </div>
    <p class="history" style="margin-top:10px">Leave "Fell asleep" empty if she's still awake.${w.startedAt && w.endedAt ? ` Awake ${fmtMin(Math.round((new Date(w.endedAt) - new Date(w.startedAt)) / 60000))}.` : ""}</p>
    <div class="btn-row">
      <button class="btn primary" type="submit">Save times</button>
      ${w.startedAt ? `<button class="btn ghost danger" type="button" data-action="clear-times" data-day="${day}" data-win="${win}">Clear times</button>` : ""}
    </div>
  </form>`;
  return sheetShell(`${w.label} times`, body);
}

function sheetRotationSettings() {
  const s = state.settings;
  const body = `<form data-form="rotation">
    <div class="row2" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="r-ot">Toys out at once</label><input id="r-ot" name="outTarget" type="number" inputmode="numeric" min="1" max="20" value="${s.outTarget}"></div>
      <div class="field"><label for="r-rd">Swap every (days)</label><input id="r-rd" name="rotateDays" type="number" inputmode="numeric" min="1" max="60" value="${s.rotateDays}"></div>
    </div>
    <div class="btn-row"><button class="btn primary" type="submit">Save</button></div>
  </form>`;
  return sheetShell("Rotation settings", body);
}

function sheetMilestones() {
  const groups = ["gross", "fine", "language", "social", "cognitive"];
  const age = ageMonths().decimal;
  const body = `
    <p class="history">Log what ${esc(state.settings.name)} can do. Activities that need a skill unlock when she reaches it, even if she's ahead of the usual age.</p>
    ${state.milestonesSetup ? `<p class="history" style="margin-top:8px">Tap a milestone to log it or change its date.</p>` : `<p class="history" style="margin-top:8px">Tap everything she already does, then tap Done. You can set exact dates afterward.</p>`}
    ${groups.map((g) => `<h4>${SKILLS[g].label}</h4><div class="pick-list">${MILESTONES.filter((m) => m.skill === g).map((m) => {
      const d = state.milestones[m.id];
      const unlocks = state.activities.filter((a) => (a.needs || []).includes(m.id) && a.maxAge + 1 > age).length;
      return `<button class="pick ${d ? "added" : ""}" data-action="milestone" data-id="${m.id}">
        <span class="grow"><strong>${esc(m.label)}</strong><div class="item-meta">${d ? `Reached ${parseKey(d).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}` : `Usually ${m.typical}`}${!d && unlocks ? ` · unlocks ${unlocks}` : ""}</div></span>
        <span class="plus">${d ? "✓" : "+"}</span></button>`;
    }).join("")}</div>`).join("")}
    <div class="btn-row"><button class="btn primary" data-action="milestones-done">Done</button></div>`;
  return sheetShell("Milestones", body);
}

function sheetMilestoneEdit({ id }) {
  const m = milestoneById(id);
  const d = state.milestones[id];
  const body = `<form data-form="milestone" data-id="${id}">
    <div class="field"><label for="m-date">Date she ${esc(m.label.toLowerCase())}</label><input id="m-date" name="date" type="date" max="${todayKey()}" value="${d || todayKey()}"></div>
    <div class="btn-row">
      <button class="btn primary" type="submit">${d ? "Save date" : "Log it"}</button>
      ${d ? `<button class="btn ghost danger" type="button" data-action="milestone-remove" data-id="${id}">Not yet</button>` : ""}
    </div>
  </form>`;
  return sheetShell(m.label, body);
}

function weekStats() {
  const days = Array.from({ length: 7 }, (_, i) => dateKey(addDays(new Date(), -i))).reverse();
  const out = { days, done: 0, minutes: 0, skills: {}, reactions: {}, byActivity: {}, toyPlays: {}, windows: [], naps: [], activeDays: 0 };
  for (const k of days) {
    const p = state.plans[k];
    if (!p) continue;
    let any = false;
    p.windows.forEach((w, i) => {
      if (w.startedAt && w.endedAt) out.windows.push((new Date(w.endedAt) - new Date(w.startedAt)) / 60000);
      const nextW = p.windows[i + 1];
      if (w.endedAt && nextW?.startedAt) out.naps.push((new Date(nextW.startedAt) - new Date(w.endedAt)) / 60000);
      for (const it of w.items) {
        if (!it.done) continue;
        const a = act(it.activityId);
        if (!a) continue;
        any = true;
        out.done++; out.minutes += a.minutes;
        for (const sk of a.skills) out.skills[sk] = (out.skills[sk] || 0) + 1;
        const r = (out.byActivity[a.id] ||= { a, n: 0, loved: 0, liked: 0, notinterested: 0, notready: 0 });
        r.n++; if (it.reaction) r[it.reaction]++;
        for (const t of a.toys || []) out.toyPlays[t] = (out.toyPlays[t] || 0) + 1;
      }
    });
    if (any) out.activeDays++;
  }
  out.naps = out.naps.filter((m) => m > 10 && m < 300);
  return out;
}

function sheetRecap() {
  const st = weekStats();
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : null);
  const maxSkill = Math.max(1, ...Object.values(st.skills));
  const acts = Object.values(st.byActivity);
  const favorites = acts.filter((r) => r.loved || r.liked).sort((x, y) => (y.loved * 2 + y.liked) - (x.loved * 2 + x.liked)).slice(0, 5);
  const skipped = acts.filter((r) => r.notinterested || r.notready);
  const toysPlayed = Object.entries(st.toyPlays).map(([id, n]) => ({ t: toyById(id), n })).filter((x) => x.t).sort((x, y) => y.n - x.n).slice(0, 5);
  const idle = toysOut().filter((t) => !st.toyPlays[t.id] && toyDaysOut(t) >= 3);
  const avgWake = avg(st.windows), avgNap = avg(st.naps);
  const target = state.settings.windowTarget;
  const suggestTarget = avgWake && st.windows.length >= 4 && Math.abs(avgWake - target) >= 15 ? Math.round(avgWake / 5) * 5 : null;
  const weekMs = Object.entries(state.milestones).filter(([, d]) => d >= st.days[0]).map(([id]) => milestoneById(id)?.label).filter(Boolean);

  const body = !st.done && !st.windows.length
    ? `<div class="empty">Nothing logged in the last 7 days yet. Check off activities and log wake times, and your recap fills in here.</div>`
    : `
    <div class="stats">
      <div><strong>${st.done}</strong><span>activities</span></div>
      <div><strong>${fmtMin(st.minutes)}</strong><span>of play</span></div>
      <div><strong>${st.activeDays}</strong><span>${st.activeDays === 1 ? "day" : "days"} active</span></div>
    </div>
    ${weekMs.length ? `<h4>New milestones</h4><p>${weekMs.map(esc).join(", ")}</p>` : ""}
    <h4>Skills this week</h4>
    <div class="bars">${Object.keys(SKILLS).map((k) => `<div class="bar-row"><span>${SKILLS[k].label}</span><span class="bar"><i style="width:${((st.skills[k] || 0) / maxSkill) * 100}%;background:var(--${k})"></i></span><span class="n">${st.skills[k] || 0}</span></div>`).join("")}</div>
    ${(() => { const low = Object.keys(SKILLS).filter((k) => !st.skills[k]); return low.length ? `<p class="history" style="margin-top:8px">No ${low.map((k) => SKILLS[k].label.toLowerCase()).join(" or ")} this week. <button class="link" data-action="skill-pick" data-skill="${low[0]}" data-day="${todayKey()}">Add some today</button></p>` : ""; })()}
    ${favorites.length ? `<h4>Her favorites</h4><div class="pick-list">${favorites.map((r) => `<button class="pick" data-action="detail" data-id="${r.a.id}"><span class="grow"><strong>${esc(r.a.title)}</strong><div class="item-meta">${[r.loved && `loved ${r.loved}×`, r.liked && `liked ${r.liked}×`].filter(Boolean).join(", ")}</div></span></button>`).join("")}</div>` : ""}
    ${skipped.length ? `<h4>Not her thing (yet)</h4><p class="history">${skipped.map((r) => `${esc(r.a.title)} (${r.notready ? "not ready" : "not interested"})`).join(", ")}. These stay out of suggestions for a while.</p>` : ""}
    ${toysPlayed.length ? `<h4>Most-played toys</h4><p>${toysPlayed.map((x) => `${esc(x.t.name)} (${x.n})`).join(", ")}</p>` : ""}
    ${idle.length ? `<h4>Out but not played with</h4><p class="history">${idle.map((t) => esc(t.name)).join(", ")}. <button class="link" data-action="rotate">Swap toys</button></p>` : ""}
    ${avgWake || avgNap ? `<h4>Wake windows and naps</h4>
      <p>${avgWake ? `Average wake window ${fmtMin(avgWake)} (target ${fmtMin(target)}).` : ""} ${avgNap ? `Average nap ${fmtMin(avgNap)}.` : ""}</p>
      ${suggestTarget ? `<div class="btn-row"><button class="btn small" data-action="set-target" data-v="${suggestTarget}">Change target to ${fmtMin(suggestTarget)}</button></div>` : ""}` : ""}`;
  return sheetShell("This week", body);
}

function sheetWindowMenu({ day, win }) {
  const w = findWindow(day, win);
  if (!w) return "";
  const wt = state.templates.windows;
  const body = `<div class="menu">
    <button class="pick" data-action="rename" data-day="${day}" data-win="${win}"><span class="grow">Rename</span></button>
    <button class="pick" data-action="edit-times" data-day="${day}" data-win="${win}"><span class="grow">Wake and nap times</span></button>
    <button class="pick" data-action="copy-window" data-day="${day}" data-win="${win}" ${w.items.length ? "" : "disabled"}><span class="grow">Copy activities<div class="item-meta">Then paste them into any window, today or tomorrow</div></span></button>
    ${ui.clip ? `<button class="pick" data-action="paste-window" data-day="${day}" data-win="${win}"><span class="grow">Paste ${ui.clip.activities.length} activities<div class="item-meta">From ${esc(ui.clip.label)}</div></span></button>` : ""}
    <button class="pick" data-action="save-window-template" data-day="${day}" data-win="${win}" ${w.items.length ? "" : "disabled"}><span class="grow">Save as a window template</span></button>
  </div>
  ${wt.length ? `<h4>Add from a window template</h4><div class="pick-list">${wt.map((t) => `<div class="tpl-row"><button class="pick grow" data-action="apply-window-template" data-id="${t.id}" data-day="${day}" data-win="${win}"><span class="grow"><strong>${esc(t.name)}</strong><div class="item-meta">${t.activities.length} activities</div></span><span class="plus">+</span></button><button class="close" data-action="delete-window-template" data-id="${t.id}" aria-label="Delete ${esc(t.name)}">${I.close}</button></div>`).join("")}</div>` : ""}
  <div class="btn-row">
    <button class="btn small" data-action="clear-window" data-day="${day}" data-win="${win}">Clear activities</button>
    <button class="btn small danger" data-action="remove-window" data-day="${day}" data-win="${win}">Remove window</button>
  </div>`;
  return sheetShell(w.label, body);
}

function sheetDayTemplates({ day }) {
  const list = state.templates.days;
  const body = `<p class="history">A template saves each window's name and activities. Applying one fills ${day === todayKey() ? "today" : "tomorrow"}'s windows, and keeps anything already checked off.</p>
    ${list.length ? `<div class="pick-list">${list.map((t) => `<div class="tpl-row"><button class="pick grow" data-action="apply-day-template" data-id="${t.id}" data-day="${day}"><span class="grow"><strong>${esc(t.name)}</strong><div class="item-meta">${t.windows.map((w) => `${esc(w.label)} (${w.activities.length})`).join(", ")}</div></span><span class="plus">+</span></button><button class="close" data-action="delete-day-template" data-id="${t.id}" aria-label="Delete ${esc(t.name)}">${I.close}</button></div>`).join("")}</div>`
      : `<div class="empty">No day templates yet. Plan a day you like, then tap "Save this day as a template" at the bottom of the Plan tab.</div>`}
    <div class="btn-row"><button class="btn" data-action="save-day-template" data-day="${day}">Save this day as a template</button></div>`;
  return sheetShell("Day templates", body);
}

function sheetToyForm({ id }) {
  const t = id ? toyById(id) : { name: "", brand: "" };
  const body = `<form data-form="toy" data-id="${id || ""}">
    <div class="field"><label for="t-name">Toy name</label><input id="t-name" name="name" required value="${esc(t.name)}"></div>
    <div class="field"><label for="t-brand">Brand (optional)</label><input id="t-brand" name="brand" value="${esc(t.brand)}"></div>
    <div class="btn-row"><button class="btn primary" type="submit">${id ? "Save" : "Add toy"}</button></div>
  </form>`;
  return sheetShell(id ? "Rename toy" : "Add a toy", body);
}

/* =========================================================
   Render
   ========================================================= */
let lastTab = null;
function render() {
  const app = $("#app");
  const views = { now: viewNow, plan: viewPlan, library: viewLibrary, toys: viewToys };
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
  const map = { detail: sheetDetail, addTo: sheetAddTo, picker: sheetPicker, form: sheetForm, settings: sheetSettings, signin: sheetSignIn, toy: sheetToy, rotate: sheetRotate, chooseOut: sheetChooseOut, toyForm: sheetToyForm, skillPick: sheetSkillPick, times: sheetTimes, rotationSettings: sheetRotationSettings, milestones: sheetMilestones, milestoneEdit: sheetMilestoneEdit, recap: sheetRecap, windowMenu: sheetWindowMenu, dayTemplates: sheetDayTemplates, backups: sheetBackups };
  root.innerHTML = map[s.type](s);
  document.body.style.overflow = "hidden";
  const sheet = $(".sheet", root);
  if (sheet && s._keepScroll) sheet.scrollTop = prevScroll;
  s._keepScroll = false;
}
function openSheet(sheet) { ui.sheet = sheet; ui.pickQ = ""; renderSheet(); }
function closeSheet() {
  if (!state.settings.birthdate) {
    if (ui.sheet?.type !== "settings") { ui.sheet = { type: "settings" }; renderSheet(); return; }
    toast("Add a birthdate to get started"); return;
  }
  ui.sheet = null; ui.pendingRender = false; renderSheet(); render(); }
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
function addOrToggle(day, win, activityId, announce = false) {
  const w = findWindow(day, win);
  const existing = w.items.find((i) => i.activityId === activityId && (ui.addMode === "done" ? i.done && i.doneAt && Date.now() - new Date(i.doneAt) < 5 * 60000 : !i.done));
  if (existing) { w.items = w.items.filter((i) => i !== existing); save(); return; }
  const done = ui.addMode === "done";
  const it = { id: uid(), activityId, done, doneAt: done ? new Date().toISOString() : null, reaction: null };
  w.items.push(it);
  if (done) ui.openReactions.add(it.id);
  save();
  if (announce || done) toast(done ? `Logged ${act(activityId)?.title}` : `Added to ${w.label}`);
}
function addActivities(w, ids) {
  const have = new Set(w.items.filter((i) => !i.done).map((i) => i.activityId));
  let n = 0;
  for (const id of ids) {
    if (!act(id) || have.has(id)) continue;
    w.items.push({ id: uid(), activityId: id, done: false, reaction: null });
    have.add(id); n++;
  }
  return n;
}
function planDayAuto(day) {
  let n = 0;
  for (const w of ensurePlan(day).windows) {
    if (w.endedAt) continue;
    const room = state.settings.playMinutes - windowMinutes(w);
    if (room >= 5) n += suggest(day, w.id, { maxMinutes: room, count: 4 }).length;
  }
  return n;
}

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

  pick: (d) => { ui.addMode = d.mode === "done" ? "done" : "plan"; openSheet({ type: "picker", day: d.day, win: d.win, fit: !!d.fit }); },
  "add-mode": (d) => { ui.addMode = d.v; refreshSheet(); },
  "pick-add": (d) => { addOrToggle(d.day, d.win, d.id); refreshSheet(); render(); },
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
  "plan-day-auto": (d) => {
    const n = planDayAuto(d.day);
    toast(n ? `Added ${n} ${n === 1 ? "activity" : "activities"} across the day` : "Every window is already full");
    render();
  },
  "plan-tomorrow": () => {
    const n = planDayAuto(tomorrowKey());
    ui.tab = "plan"; ui.planDay = "tomorrow"; render();
    toast(n ? `Planned ${n} activities for tomorrow` : "Tomorrow is already planned");
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
    save(); if (ui.sheet?.type === "windowMenu") closeSheet(); else render();
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
  "lib-tag": (d) => { ui.lib.tag = ui.lib.tag === d.v ? null : d.v; render(); },
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
  "new-activity": (d) => openSheet({ type: "form", toy: d.toy || null }),
  "goto-toys": () => { ui.tab = "toys"; render(); },
  toy: (d) => openSheet({ type: "toy", id: d.id }),
  "toy-toggle": (d) => {
    const t = toyById(d.id);
    setToyStatus(t, t.status === "out" ? "stored" : "out");
    save(); render(); refreshSheet();
    if (!d.stay) toast(t.status === "out" ? `${t.name} is out` : `${t.name} put away`);
  },
  "toy-status": (d) => {
    const t = toyById(d.id);
    setToyStatus(t, d.v);
    save(); render(); refreshSheet();
    toast(d.v === "retired" ? "Marked outgrown" : "Back in rotation");
  },
  "toggle-retired": () => { ui.showRetired = !ui.showRetired; render(); },
  rotate: (d) => openSheet({ type: "rotate", fresh: !!d.fresh }),
  "rotate-toggle": (d) => {
    const s = ui.sheet;
    s.keep.has(d.id) ? s.keep.delete(d.id) : s.keep.add(d.id);
    refreshSheet();
  },
  "rotate-reshuffle": () => {
    const s = ui.sheet;
    const shown = new Set(s.bringOut);
    const { putAway } = rotationPlan({ fresh: !!s.fresh });
    // Temporarily treat shown picks as unavailable to get alternatives.
    const saved = shown.size ? state.toys.filter((t) => shown.has(t.id)) : [];
    saved.forEach((t) => (t._skip = t.status, t.status = "_skip"));
    const alt = rotationPlan({ fresh: !!s.fresh }).bringOut.map((t) => t.id);
    saved.forEach((t) => { t.status = t._skip; delete t._skip; });
    if (!alt.length) { toast("No other toys to suggest"); return; }
    s.putAway = putAway.map((t) => t.id);
    s.bringOut = alt.slice(0, s.bringOut.length || alt.length);
    s.keep = new Set([...s.putAway, ...s.bringOut]);
    refreshSheet();
  },
  "rotate-apply": () => {
    const s = ui.sheet;
    let n = 0;
    for (const id of s.putAway) if (s.keep.has(id)) { setToyStatus(toyById(id), "stored"); n++; }
    for (const id of s.bringOut) if (s.keep.has(id)) { setToyStatus(toyById(id), "out"); n++; }
    save(); ui.sheet = null; render();
    toast(n ? `Swapped ${n} ${n === 1 ? "toy" : "toys"}` : "Nothing changed");
  },
  "choose-out": () => openSheet({ type: "chooseOut" }),
  "new-toy": () => openSheet({ type: "toyForm" }),
  "edit-toy": (d) => openSheet({ type: "toyForm", id: d.id }),
  "delete-toy": (d) => {
    const t = toyById(d.id);
    if (!confirm(`Remove ${t.name} from your toys? Activities that use it stay in the library.`)) return;
    state.toys = state.toys.filter((x) => x !== t);
    if (!t.custom) state.hiddenToyIds.push(t.id);
    save(); closeSheet(); toast("Toy removed");
  },
  "hard-refresh": hardRefresh,
  backups: () => {
    const sheet = { type: "backups", list: null, error: null };
    openSheet(sheet);
    sync.listBackups().then((list) => { if (ui.sheet === sheet) { sheet.list = list; refreshSheet(); } })
      .catch((e) => { if (ui.sheet === sheet) { sheet.error = e.message || "Couldn't load backups. Check your connection."; refreshSheet(); } });
  },
  "restore-backup": async (d) => {
    if (!confirm("Replace everything with this backup? This changes every family phone.")) return;
    const before = JSON.stringify(state);
    try {
      const data = await sync.loadBackup(d.id);
      state = migrate(data); save(); closeSheet();
      toastUndo("Backup restored", before);
    } catch (e) { toast(e.message || "Couldn't restore that backup"); }
  },
  undo: () => {
    if (!undoSnapshot) return;
    state = migrate(JSON.parse(undoSnapshot));
    undoSnapshot = null;
    save(); render(); renderSheet();
    toast("Undone");
  },
  "stale-ok": (d) => { const w = findWindow(d.day, d.win); delete w.estimatedEnd; save(); render(); },

  recap: () => openSheet({ type: "recap" }),
  "set-target": (d) => { state.settings.windowTarget = +d.v; save(); refreshSheet(); render(); toast(`Wake window target set to ${fmtMin(+d.v)}`); },

  milestones: () => openSheet({ type: "milestones" }),
  milestone: (d) => {
    // First pass: quick taps. After that, tapping opens the date so it can be a keepsake.
    if (!state.milestonesSetup) {
      if (state.milestones[d.id]) delete state.milestones[d.id]; else state.milestones[d.id] = todayKey();
      save(); refreshSheet(); return;
    }
    openSheet({ type: "milestoneEdit", id: d.id });
  },
  "milestone-remove": (d) => { delete state.milestones[d.id]; save(); ui.sheet = { type: "milestones" }; renderSheet(); render(); },
  "milestones-done": () => {
    const first = !state.milestonesSetup;
    state.milestonesSetup = true;
    save(); closeSheet();
    if (first) toast("Activities now match what she can do");
  },

  "toggle-window": (d) => { ui.expanded.has(d.win) ? ui.expanded.delete(d.win) : ui.expanded.add(d.win); render(); },
  "window-menu": (d) => openSheet({ type: "windowMenu", day: d.day, win: d.win }),
  "copy-window": (d) => {
    const w = findWindow(d.day, d.win);
    ui.clip = { label: w.label, activities: w.items.map((i) => i.activityId) };
    closeSheet();
    toast(`Copied ${ui.clip.activities.length}. Tap Paste on any window.`);
  },
  "paste-window": (d) => {
    const w = findWindow(d.day, d.win);
    const n = addActivities(w, ui.clip.activities);
    save(); if (ui.sheet) closeSheet(); else render();
    toast(n ? `Pasted ${n} into ${w.label}` : "Those are already in this window");
  },
  "clip-clear": () => { ui.clip = null; render(); },
  "save-window-template": (d) => {
    const w = findWindow(d.day, d.win);
    const name = prompt("Name this window template", `${w.label} favorites`);
    if (!name?.trim()) return;
    state.templates.windows.push({ id: uid(), name: name.trim(), activities: w.items.map((i) => i.activityId) });
    save(); refreshSheet(); toast("Window template saved");
  },
  "apply-window-template": (d) => {
    const t = state.templates.windows.find((x) => x.id === d.id);
    const w = findWindow(d.day, d.win);
    const n = addActivities(w, t.activities);
    save(); closeSheet(); toast(n ? `Added ${n} from ${t.name}` : "Those are already in this window");
  },
  "delete-window-template": (d) => {
    const t = state.templates.windows.find((x) => x.id === d.id);
    if (!confirm(`Delete the "${t.name}" template?`)) return;
    state.templates.windows = state.templates.windows.filter((x) => x !== t);
    save(); refreshSheet();
  },
  "clear-window": (d) => {
    const w = findWindow(d.day, d.win);
    w.items = w.items.filter((i) => i.done);
    save(); closeSheet(); toast("Cleared");
  },
  "remove-window": (d) => {
    const plan = ensurePlan(d.day);
    const w = findWindow(d.day, d.win);
    plan.windows = plan.windows.filter((x) => x !== w);
    save(); closeSheet(); toast(`${w.label} removed`);
  },
  "day-templates": (d) => openSheet({ type: "dayTemplates", day: d.day }),
  "save-day-template": (d) => {
    const plan = ensurePlan(d.day);
    if (!plan.windows.some((w) => w.items.length)) { toast("Add some activities first"); return; }
    const name = prompt("Name this day template", "Typical day");
    if (!name?.trim()) return;
    state.templates.days.push({ id: uid(), name: name.trim(), windows: plan.windows.map((w) => ({ label: w.label, activities: w.items.map((i) => i.activityId) })) });
    save(); if (ui.sheet) refreshSheet(); toast("Day template saved");
  },
  "apply-day-template": (d) => {
    const t = state.templates.days.find((x) => x.id === d.id);
    const plan = ensurePlan(d.day);
    const windows = t.windows.map((tw, i) => {
      const ex = plan.windows[i];
      const w = { id: ex?.id || uid(), label: tw.label, startedAt: ex?.startedAt || null, endedAt: ex?.endedAt || null, items: ex ? ex.items.filter((it) => it.done) : [] };
      addActivities(w, tw.activities);
      return w;
    });
    // Keep extra windows that already have times or checked-off activities.
    for (const ex of plan.windows.slice(t.windows.length)) if (ex.startedAt || ex.items.some((i) => i.done)) windows.push({ ...ex, items: ex.items.filter((i) => i.done) });
    plan.windows = windows;
    save(); closeSheet(); toast(`Applied ${t.name}`);
  },
  "delete-day-template": (d) => {
    const t = state.templates.days.find((x) => x.id === d.id);
    if (!confirm(`Delete the "${t.name}" template?`)) return;
    state.templates.days = state.templates.days.filter((x) => x !== t);
    save(); refreshSheet();
  },
  "skill-pick": (d) => openSheet({ type: "skillPick", skill: d.skill, day: d.day }),
  "skill-pick-win": (d) => { ui.sheet.win = d.win; refreshSheet(); },
  "skill-pick-add": (d) => { addOrToggle(ui.sheet.day, ui.sheet.win, d.id, true); render(); refreshSheet(); },
  "edit-times": (d) => openSheet({ type: "times", day: d.day, win: d.win }),
  "clear-times": (d) => {
    const w = findWindow(d.day, d.win);
    w.startedAt = null; w.endedAt = null;
    save(); closeSheet(); toast("Times cleared");
  },
  "rotation-settings": () => openSheet({ type: "rotationSettings" }),
  signin: () => openSheet({ type: "signin" }),
  "signin-google": async () => {
    try { await sync.signInGoogle(); if (ui.sheet?.type === "signin") { ui.sheet = { type: "settings" }; renderSheet(); } }
    catch (e) { ui.sheet = { type: "signin", error: e.message }; renderSheet(); }
  },
  signout: async () => {
    if (!confirm("Sign out? Everything stays on this phone; it just stops syncing.")) return;
    await sync.signOut(); refreshSheet(); toast("Signed out");
  },
  "sync-resend": async () => { await sync.resendVerification(); toast("Verification email sent"); },
  "sync-recheck": async () => { await sync.recheckVerification(); refreshSheet(); },
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
  const undoLabel = UNDOABLE[el.dataset.action];
  if (undoLabel) {
    const before = JSON.stringify(state);
    const r = fn({ ...el.dataset }, e);
    if (JSON.stringify(state) !== before) toastUndo(typeof undoLabel === "function" ? undoLabel(el.dataset) : undoLabel, before);
    return r;
  }
  fn({ ...el.dataset }, e);
});

// Actions that can be undone from the toast, with the message to show.
const UNDOABLE = {
  "remove-item": "Removed from plan",
  "clear-day": "Day cleared",
  "delete-activity": "Activity removed",
  "delete-toy": "Toy removed",
  "rotate-apply": "Toys swapped",
  "clear-times": "Times cleared",
  "copy-today": "Copied today's plan",
  "clear-window": "Window cleared",
  "remove-window": "Window removed",
  "apply-day-template": "Template applied",
  "paste-window": "Pasted",
  "apply-window-template": "Template added",
  "plan-day-auto": "Day planned",
  "plan-tomorrow": "Tomorrow planned",
  swap: "Swapped",
  "delete-day-template": "Template deleted",
  "delete-window-template": "Template deleted",
};

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
});

document.addEventListener("submit", (e) => {
  const form = e.target;
  e.preventDefault();
  const fd = new FormData(form);
  if (form.dataset.form === "settings") {
    const s = state.settings;
    if (!fd.get("birthdate")) { toast("Add a birthdate"); return; }
    s.name = (fd.get("name") || "").trim() || "Baby";
    s.birthdate = fd.get("birthdate") || s.birthdate;
    s.windowTarget = clampNum(fd.get("windowTarget"), 30, 360, s.windowTarget);
    s.playMinutes = clampNum(fd.get("playMinutes"), 5, 240, s.playMinutes);
    s.windowsPerDay = clampNum(fd.get("windowsPerDay"), 1, 6, s.windowsPerDay);
    s.outTarget = clampNum(fd.get("outTarget"), 1, 20, s.outTarget);
    s.rotateDays = clampNum(fd.get("rotateDays"), 1, 60, s.rotateDays);
    save(); closeSheet(); toast("Settings saved");
  }
  if (form.dataset.form === "signin") {
    const mode = e.submitter?.value || "signin";
    const email = String(fd.get("email") || "").trim();
    const password = String(fd.get("password") || "");
    const fail = (err) => { ui.sheet = { type: "signin", email, error: err.message }; renderSheet(); };
    if (mode === "reset") {
      if (!email) { fail(new Error("Enter your email first.")); return; }
      sync.resetPassword(email).then(() => toast("Password reset email sent")).catch(fail);
      return;
    }
    toast(mode === "create" ? "Creating account…" : "Signing in…");
    (mode === "create" ? sync.createAccount(email, password) : sync.signInEmail(email, password))
      .then(() => {
        ui.sheet = { type: "settings" }; renderSheet();
        if (mode === "create") toast("Check your email for a verification link");
      })
      .catch(fail);
    return;
  }
  if (form.dataset.form === "times") {
    const w = findWindow(form.dataset.day, form.dataset.win);
    const base = parseKey(form.dataset.day);
    const toIso = (t) => { if (!t) return null; const [h, m] = t.split(":").map(Number); const d = new Date(base); d.setHours(h, m, 0, 0); return d.toISOString(); };
    const start = toIso(fd.get("start")), end0 = toIso(fd.get("end"));
    if (!start && end0) { toast("Add when she woke up"); return; }
    const soon = Date.now() + 60000;
    if ((start && new Date(start) > soon) || (end0 && new Date(end0) > soon)) { toast("That time hasn't happened yet"); return; }
    let end = end0;
    if (start && end && new Date(end) <= new Date(start)) { toast("Nap time has to be after wake time"); return; }
    if (start && !end) {
      // Only one window can be running at a time.
      for (const x of ensurePlan(form.dataset.day).windows) if (x !== w && x.startedAt && !x.endedAt) x.endedAt = start;
    }
    w.startedAt = start; w.endedAt = end; delete w.estimatedEnd;
    save(); closeSheet(); toast("Times saved");
    return;
  }
  if (form.dataset.form === "milestone") {
    const id = form.dataset.id;
    const date = fd.get("date") || todayKey();
    const wasNew = !state.milestones[id];
    const before = state.activities.filter((a) => fitsAge(a, ageMonths().decimal)).length;
    state.milestones[id] = date;
    const unlocked = state.activities.filter((a) => fitsAge(a, ageMonths().decimal)).length - before;
    save();
    ui.sheet = { type: "milestones" }; renderSheet(); render();
    toast(wasNew ? `${milestoneById(id).label}! ${unlocked > 0 ? `${unlocked} new ${unlocked === 1 ? "activity" : "activities"} unlocked` : "Logged"}` : "Date saved");
    return;
  }
  if (form.dataset.form === "rotation") {
    state.settings.outTarget = clampNum(fd.get("outTarget"), 1, 20, state.settings.outTarget);
    state.settings.rotateDays = clampNum(fd.get("rotateDays"), 1, 60, state.settings.rotateDays);
    save(); closeSheet(); toast("Rotation settings saved");
    return;
  }
  if (form.dataset.form === "toy") {
    const name = (fd.get("name") || "").trim();
    if (!name) { toast("Give the toy a name"); return; }
    const brand = (fd.get("brand") || "").trim();
    const id = form.dataset.id;
    if (id) { Object.assign(toyById(id), { name, brand }); toast("Saved"); }
    else { state.toys.push({ id: "ct-" + uid(), name, brand, status: "stored", custom: true, periods: [] }); toast(`${name} added to storage`); }
    save(); closeSheet();
    return;
  }
  if (form.dataset.form === "activity") {
    const title = (fd.get("title") || "").trim();
    if (!title) { toast("Give it a name"); return; }
    const skills = [...form.querySelectorAll('[data-action="form-skill"]:not([data-tag]):not([data-toy])[aria-pressed="true"]')].map((b) => b.dataset.v);
    const toys = [...form.querySelectorAll('[data-action="form-skill"][data-toy][aria-pressed="true"]')].map((b) => b.dataset.v);
    const tags = [...form.querySelectorAll('[data-action="form-skill"][data-tag][aria-pressed="true"]')].map((b) => b.dataset.v);
    if (toys.length) tags.push("her-toys");
    if (!skills.length) { toast("Pick at least one skill"); return; }
    let minAge = clampNum(fd.get("minAge"), 0, 48, 0), maxAge = clampNum(fd.get("maxAge"), 0, 48, 18);
    if (maxAge < minAge) [minAge, maxAge] = [maxAge, minAge];
    const data = {
      title, minAge, maxAge,
      minutes: clampNum(fd.get("minutes"), 1, 120, 10),
      skills, tags, toys,
      materials: String(fd.get("materials") || "").split("\n").map((s) => s.trim()).filter(Boolean),
      how: String(fd.get("how") || "").trim(),
      safety: String(fd.get("safety") || "").trim(),
    };
    const id = form.dataset.id;
    if (id) { Object.assign(act(id), data, { edited: true }); toast("Saved"); }
    else { state.activities.push({ id: "c-" + uid(), custom: true, fav: false, ...data }); toast("Added to library"); }
    save();
    const nowAge = ageMonths().decimal;
    if (!id && ui.tab === "library" && ui.lib.age === "now" && !(minAge <= nowAge && nowAge < maxAge + 1)) ui.lib.age = "all";
    closeSheet();
  }
});
function clampNum(v, lo, hi, dflt) { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== "" ? Math.min(hi, Math.max(lo, n)) : dflt; }

/* Drag and drop (Plan tab) ------------------------------ */
let drag = null;
document.addEventListener("pointerdown", (e) => {
  const grip = e.target.closest(".grip");
  if (!grip || drag) return;
  e.preventDefault();
  const li = grip.closest(".item");
  const r = li.getBoundingClientRect();
  const ghost = li.cloneNode(true);
  ghost.classList.add("drag-ghost");
  Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
  document.body.appendChild(ghost);
  li.classList.add("drag-placeholder");
  drag = { li, ghost, dy: e.clientY - r.top, y: e.clientY, day: grip.dataset.day, from: grip.dataset.win, item: grip.dataset.item, pid: e.pointerId };
  try { grip.setPointerCapture(e.pointerId); } catch {}
  drag.scroller = setInterval(() => {
    if (!drag) return;
    if (drag.y < 90) window.scrollBy(0, -10);
    else if (drag.y > window.innerHeight - 140) window.scrollBy(0, 10);
  }, 16);
});
document.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  e.preventDefault();
  drag.y = e.clientY;
  drag.ghost.style.top = `${e.clientY - drag.dy}px`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const list = under?.closest(".card")?.querySelector("ul.drop");
  if (!list) return;
  const over = under.closest(".item");
  if (over && over !== drag.li && list.contains(over)) {
    const r = over.getBoundingClientRect();
    over.parentNode.insertBefore(drag.li, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  } else if (!over && !list.contains(drag.li)) {
    list.insertBefore(drag.li, list.querySelector(".empty-li"));
  }
}, { passive: false });
function endDrag(cancel) {
  if (!drag) return;
  const { li, ghost, day, from, item, scroller } = drag;
  clearInterval(scroller);
  ghost.remove();
  li.classList.remove("drag-placeholder");
  drag = null;
  if (cancel) { render(); return; }
  const list = li.closest("ul.drop");
  if (!list) { render(); return; }
  const to = list.dataset.win;
  const index = [...list.querySelectorAll(".item")].indexOf(li);
  const src = findWindow(day, from), dst = findWindow(day, to);
  const it = src?.items.find((i) => i.id === item);
  if (!it || !dst) { render(); return; }
  const before = JSON.stringify(src.items.map((i) => i.id)) + to;
  src.items = src.items.filter((i) => i !== it);
  dst.items.splice(Math.max(0, index), 0, it);
  const after = JSON.stringify(src.items.map((i) => i.id)) + to;
  save(); render();
  if (from !== to) toast(`Moved to ${dst.label}`);
  else if (before === after) { /* dropped in place */ }
}
document.addEventListener("pointerup", (e) => { if (drag && e.pointerId === drag.pid) endDrag(false); });
document.addEventListener("pointercancel", (e) => { if (drag && e.pointerId === drag.pid) endDrag(true); });

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.sheet) closeSheet(); });

// Re-render when the day rolls over or the app returns to the foreground.
let lastDay = todayKey();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (todayKey() !== lastDay) { lastDay = todayKey(); }
  render();
  checkForUpdate();
});

/* Updates ----------------------------------------------- */
async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const { version } = await res.json();
    const next = version && version !== APP_VERSION ? version : null;
    if (next !== ui.updateAvailable) { ui.updateAvailable = next; render(); }
  } catch { /* offline */ }
}

async function hardRefresh() {
  toast("Updating…");
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* keep going */ }
  location.replace(`${location.pathname}?v=${Date.now()}`);
}

sync.init({
  getState: () => state,
  applyMain: (main) => {
    const plans = state.plans;
    state = migrate({ ...main, plans });
  },
  applyDay: (k, plan) => { state.plans[k] = plan; },
  afterRemote: () => {
    saveLocal();
    // Don't wipe a form someone is typing in; re-render when the sheet closes.
    const typing = ["form", "toyForm", "signin"].includes(ui.sheet?.type) || (ui.sheet?.type === "settings" && document.activeElement?.closest?.("form"));
    if (typing) ui.pendingRender = true; else render();
  },
  onStatus: (st) => {
    ui.sync = st;
    if (ui.sheet?.type === "settings") refreshSheet();
    if (st.state === "denied") toast("This account doesn't have access yet");
  },
});

render();
if (!state.settings.birthdate) openSheet({ type: "settings" });
if (location.search.includes("v=")) history.replaceState(null, "", location.pathname);

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
checkForUpdate();
