// Cloud sync for The Playroom (Firebase Auth + Firestore).
// The app stays local-first: localStorage is the source of truth on each phone,
// and this module mirrors it to Firestore so every signed-in family phone shares one copy.
//
// Firestore layout (all under one family document):
//   playrooms/family                 { json, updatedAt, updatedBy }   settings, library, toys
//   playrooms/family/days/{date}     { date, json, updatedAt, updatedBy }   that day's windows
// Access is limited by Firestore rules to an allowlist of verified family emails.

import { merge3 } from "./merge.js";

const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";

export const firebaseConfig = {
  apiKey: "AIzaSyDiApCcoKze8ZzmOSVQMRhELBDx4aukUQQ",
  authDomain: "the-playroom-5bd48.firebaseapp.com",
  projectId: "the-playroom-5bd48",
  storageBucket: "the-playroom-5bd48.firebasestorage.app",
  messagingSenderId: "846734675399",
  appId: "1:846734675399:web:845a490cf946ad2a04dde2",
};

const FAMILY_ID = "family";
const META_KEY = "playroom.sync";

let sdk = null;
let auth = null;
let db = null;
let hooks = null;
let user = null;
let unsubs = [];
let pushTimer = null;
let lastMain = null;           // JSON last known to match the server
const lastDays = new Map();    // date -> JSON last known to match the server
let live = false;              // initial sync finished, listeners running

export const status = { state: "off", email: null, verified: true, lastSynced: null, error: null };

/* ---------- local bookkeeping ---------- */
function loadMeta() {
  try { return { uid: null, pendingMain: false, pendingDays: [], ...JSON.parse(localStorage.getItem(META_KEY) || "{}") }; }
  catch { return { uid: null, pendingMain: false, pendingDays: [] }; }
}
function saveMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch {} }
let meta = loadMeta();

function setStatus(patch) {
  Object.assign(status, patch);
  hooks?.onStatus?.({ ...status });
}

const mainPart = (s) => JSON.stringify({
  settings: s.settings,
  seedVersion: s.seedVersion,
  activities: s.activities,
  hiddenSeedIds: s.hiddenSeedIds,
  toys: s.toys,
  hiddenToyIds: s.hiddenToyIds,
  milestones: s.milestones,
  milestonesSetup: s.milestonesSetup,
  templates: s.templates,
});

/* ---------- SDK ---------- */
async function loadSdk() {
  if (sdk) return sdk;
  let app, authM, fs;
  try {
    [app, authM, fs] = await Promise.all([
      import(SDK + "firebase-app.js"),
      import(SDK + "firebase-auth.js"),
      import(SDK + "firebase-firestore.js"),
    ]);
  } catch {
    throw new Error("Couldn't load sign-in. Check your connection and try again.");
  }
  const a = app.initializeApp(firebaseConfig);
  auth = authM.getAuth(a);
  db = fs.getFirestore(a);
  sdk = { authM, fs };
  authM.onAuthStateChanged(auth, onAuth);
  return sdk;
}

const mainRef = () => sdk.fs.doc(db, "playrooms", FAMILY_ID);
const dayRef = (k) => sdk.fs.doc(db, "playrooms", FAMILY_ID, "days", k);
const daysCol = () => sdk.fs.collection(db, "playrooms", FAMILY_ID, "days");

/* ---------- public API ---------- */
export async function init(h) {
  hooks = h;
  // Only load Firebase on launch if this phone has signed in before.
  if (meta.uid) {
    setStatus({ state: "connecting" });
    try { await loadSdk(); } catch { setStatus({ state: "offline" }); }
  }
}

export async function signInGoogle() {
  await loadSdk();
  const { authM } = sdk;
  try {
    await authM.signInWithPopup(auth, new authM.GoogleAuthProvider());
  } catch (e) {
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    throw friendly(e, "Google sign-in didn't open here. Try email and password instead.");
  }
}

export async function signInEmail(email, password) {
  await loadSdk();
  try { await sdk.authM.signInWithEmailAndPassword(auth, email, password); }
  catch (e) { throw friendly(e); }
}

export async function createAccount(email, password) {
  await loadSdk();
  try {
    const cred = await sdk.authM.createUserWithEmailAndPassword(auth, email, password);
    await sdk.authM.sendEmailVerification(cred.user);
  } catch (e) { throw friendly(e); }
}

export async function resendVerification() {
  if (auth?.currentUser) await sdk.authM.sendEmailVerification(auth.currentUser);
}

export async function resetPassword(email) {
  await loadSdk();
  try { await sdk.authM.sendPasswordResetEmail(auth, email); }
  catch (e) { throw friendly(e); }
}

export async function recheckVerification() {
  if (!auth?.currentUser) return;
  await auth.currentUser.reload();
  await auth.currentUser.getIdToken(true);
  onAuth(auth.currentUser);
}

export async function signOut() {
  stopListening();
  meta = { uid: null, pendingMain: false, pendingDays: [] };
  saveMeta(meta);
  if (auth) await sdk.authM.signOut(auth);
  setStatus({ state: "off", email: null, lastSynced: null, error: null });
}

// Called by the app after every local save.
if (typeof window !== "undefined") window.addEventListener("online", () => schedulePush());

export function schedulePush() {
  if (!live) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 500);
}

/* ---------- auth and initial sync ---------- */
async function onAuth(u) {
  stopListening();
  user = u;
  if (!u) {
    if (meta.uid) setStatus({ state: "off", email: null });
    return;
  }
  if (!u.emailVerified) {
    setStatus({ state: "unverified", email: u.email, verified: false });
    return;
  }
  setStatus({ state: "syncing", email: u.email, verified: true, error: null });
  try {
    await initialSync(u);
    setStatus({ state: "synced", lastSynced: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    if (e.code === "permission-denied") setStatus({ state: "denied", error: "This account doesn't have access yet. Add its email to the Firestore rules." });
    else setStatus({ state: "offline", error: "Couldn't reach the cloud. Changes are saved on this phone and will sync later." });
  }
}

async function initialSync(u) {
  const { fs } = sdk;
  const state = hooks.getState();
  const firstTimeHere = meta.uid !== u.uid;
  const mainSnap = await fs.getDoc(mainRef());
  const daySnaps = await fs.getDocs(daysCol());
  const remoteDays = new Map(daySnaps.docs.map((d) => [d.id, d.data().json]));
  const writes = [];

  if (!mainSnap.exists()) {
    // Brand-new family space: upload everything from this phone.
    writes.push(["main", mainPart(state)]);
    for (const [k, p] of Object.entries(state.plans)) writes.push(["day", k, JSON.stringify(p)]);
  } else {
    const remoteMain = JSON.parse(mainSnap.data().json);
    let main;
    if (firstTimeHere) {
      // Take the shared copy, but keep anything custom this phone made before signing in.
      main = remoteMain;
      const actIds = new Set(main.activities.map((a) => a.id));
      for (const a of state.activities) if (a.custom && !actIds.has(a.id)) main.activities.push(a);
      const toyIds = new Set(main.toys.map((t) => t.id));
      for (const t of state.toys) if (t.custom && !toyIds.has(t.id)) main.toys.push(t);
    } else {
      main = meta.pendingMain ? JSON.parse(mainPart(state)) : remoteMain;
    }
    hooks.applyMain(main);
    const merged = mainPart(hooks.getState());
    lastMain = mainSnap.data().json; // the server copy is the shared starting point
    if (merged !== lastMain) writes.push(["main", merged]);

    // Days: remote wins unless this phone has unsent changes for that day.
    const pending = new Set(meta.pendingDays);
    const localPlans = hooks.getState().plans;
    for (const [k, json] of remoteDays) {
      const local = localPlans[k];
      const keepLocal = local && (pending.has(k) || (firstTimeHere && itemCount(local) > itemCount(JSON.parse(json))));
      if (keepLocal) writes.push(["day", k, JSON.stringify(local)]);
      else { hooks.applyDay(k, JSON.parse(json)); lastDays.set(k, json); }
    }
    for (const [k, p] of Object.entries(localPlans)) if (!remoteDays.has(k)) writes.push(["day", k, JSON.stringify(p)]);
  }

  meta.uid = u.uid;
  saveMeta(meta);
  hooks.afterRemote();
  await Promise.all(writes.map((w) => (w[0] === "main" ? writeMain(w[1]) : writeDay(w[1], w[2]))));
  listen();
  live = true;
}

const itemCount = (p) => (p?.windows || []).reduce((n, w) => n + w.items.length + (w.startedAt ? 1 : 0), 0);

/* ---------- writes ---------- */
// Writes run in a transaction: if the server copy changed since we last saw it
// (another phone saved in the meantime), both sets of changes are merged.
const inflight = new Set();

function writeMain(json) {
  if (inflight.has("main")) return;
  inflight.add("main");
  meta.pendingMain = true; saveMeta(meta);
  const base = lastMain;
  return sdk.fs.runTransaction(db, async (tx) => {
    const snap = await tx.get(mainRef());
    const remote = snap.exists() ? snap.data().json : null;
    let out = json;
    if (remote && remote !== base && remote !== json) {
      out = JSON.stringify(merge3(base ? JSON.parse(base) : undefined, JSON.parse(json), JSON.parse(remote)));
    }
    tx.set(mainRef(), { json: out, updatedAt: sdk.fs.serverTimestamp(), updatedBy: user?.email || "" });
    return out;
  }).then((out) => {
    lastMain = out;
    const now = mainPart(hooks.getState());
    if (out !== json) {
      // The merge brought in another phone's changes; fold in anything typed since.
      const merged = now === json ? JSON.parse(out) : merge3(JSON.parse(json), JSON.parse(now), JSON.parse(out));
      hooks.applyMain(merged);
      hooks.afterRemote();
    }
    if (mainPart(hooks.getState()) === out) { meta.pendingMain = false; saveMeta(meta); }
    setStatus({ state: "synced", lastSynced: new Date().toISOString(), error: null });
  }).catch(onWriteError).finally(() => { inflight.delete("main"); schedulePush(); });
}

function writeDay(k, json) {
  if (inflight.has(k)) return;
  inflight.add(k);
  if (!meta.pendingDays.includes(k)) { meta.pendingDays.push(k); saveMeta(meta); }
  const base = lastDays.get(k);
  return sdk.fs.runTransaction(db, async (tx) => {
    const snap = await tx.get(dayRef(k));
    const remote = snap.exists() ? snap.data().json : null;
    let out = json;
    if (remote && remote !== base && remote !== json) {
      out = JSON.stringify(merge3(base ? JSON.parse(base) : undefined, JSON.parse(json), JSON.parse(remote)));
    }
    tx.set(dayRef(k), { date: k, json: out, updatedAt: sdk.fs.serverTimestamp(), updatedBy: user?.email || "" });
    return out;
  }).then((out) => {
    lastDays.set(k, out);
    const plan = hooks.getState().plans[k];
    const now = plan ? JSON.stringify(plan) : json;
    if (out !== json) {
      const merged = now === json ? JSON.parse(out) : merge3(JSON.parse(json), JSON.parse(now), JSON.parse(out));
      hooks.applyDay(k, merged);
      hooks.afterRemote();
    }
    if (JSON.stringify(hooks.getState().plans[k]) === out) { meta.pendingDays = meta.pendingDays.filter((d) => d !== k); saveMeta(meta); }
    setStatus({ state: "synced", lastSynced: new Date().toISOString(), error: null });
  }).catch(onWriteError).finally(() => { inflight.delete(k); schedulePush(); });
}

function onWriteError(e) {
  console.error(e);
  if (e.code === "permission-denied") setStatus({ state: "denied", error: "This account doesn't have access. Add its email to the Firestore rules." });
  else setStatus({ state: "offline" });
}

function push() {
  if (!live || !user) return;
  const state = hooks.getState();
  const main = mainPart(state);
  if (main !== lastMain) writeMain(main);
  for (const [k, p] of Object.entries(state.plans)) {
    const json = JSON.stringify(p);
    if (json !== lastDays.get(k)) writeDay(k, json);
  }
}

/* ---------- live updates from other phones ---------- */
function listen() {
  const { fs } = sdk;
  unsubs.push(fs.onSnapshot(mainRef(), (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    const json = snap.data().json;
    if (json === lastMain || inflight.has("main")) return;
    const base = lastMain;
    const local = mainPart(hooks.getState());
    lastMain = json;
    // Keep any edits made here that haven't gone up yet.
    hooks.applyMain(local === base || !base ? JSON.parse(json) : merge3(JSON.parse(base), JSON.parse(local), JSON.parse(json)));
    hooks.afterRemote();
    if (mainPart(hooks.getState()) !== json) schedulePush();
    setStatus({ state: "synced", lastSynced: new Date().toISOString() });
  }, onWriteError));
  unsubs.push(fs.onSnapshot(daysCol(), (snap) => {
    if (snap.metadata.hasPendingWrites) return;
    let changed = false;
    for (const ch of snap.docChanges()) {
      if (ch.type === "removed") continue;
      const k = ch.doc.id, json = ch.doc.data().json;
      if (json === lastDays.get(k) || inflight.has(k)) continue;
      const base = lastDays.get(k);
      const plan = hooks.getState().plans[k];
      const local = plan ? JSON.stringify(plan) : null;
      lastDays.set(k, json);
      hooks.applyDay(k, !local || local === base || !base ? JSON.parse(json) : merge3(JSON.parse(base), JSON.parse(local), JSON.parse(json)));
      if (JSON.stringify(hooks.getState().plans[k]) !== json) schedulePush();
      changed = true;
    }
    if (changed) { hooks.afterRemote(); setStatus({ state: "synced", lastSynced: new Date().toISOString() }); }
  }, onWriteError));
}

function stopListening() {
  unsubs.forEach((u) => u());
  unsubs = [];
  live = false;
  lastMain = null;
  lastDays.clear();
}

/* ---------- messages ---------- */
function friendly(e, fallback) {
  const map = {
    "auth/invalid-credential": "That email and password don't match.",
    "auth/wrong-password": "That email and password don't match.",
    "auth/user-not-found": "No account with that email yet. Tap Create account.",
    "auth/email-already-in-use": "That email already has an account. Tap Sign in instead.",
    "auth/weak-password": "Use a password with at least 6 characters.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
    "auth/network-request-failed": "No connection. Try again when you're online.",
    "auth/operation-not-allowed": "This sign-in method isn't turned on in Firebase yet.",
    "auth/unauthorized-domain": "This web address isn't on Firebase's authorized domains list yet.",
  };
  const err = new Error(map[e.code] || fallback || "Sign-in didn't work. Try again.");
  err.code = e.code;
  return err;
}
