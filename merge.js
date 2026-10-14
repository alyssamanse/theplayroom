// Three-way merge used when two phones change the same data at nearly the same time.
// base = the last version both phones agreed on, local = this phone, remote = the server.
// Rules:
//  - Whatever changed on only one side wins.
//  - Objects merge key by key.
//  - Arrays of objects with ids merge item by item: additions from both sides are kept,
//    deletions from either side are honored (unless the other side edited that item),
//    and local order is kept with remote additions appended.
//  - Arrays of strings (like hidden ids) take the union of additions, minus removals.
//  - If both sides changed the same plain value, this phone wins.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const idArray = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && typeof x.id === "string");
const primArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number");

export function merge3(base, local, remote) {
  if (same(local, remote)) return local;
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;

  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const inL = k in local, inR = k in remote, inB = k in b;
      if (inL && inR) out[k] = merge3(b[k], local[k], remote[k]);
      else if (inL) { if (!inB || !same(local[k], b[k])) out[k] = local[k]; }   // remote removed it unless we changed it
      else if (inR) { if (!inB || !same(remote[k], b[k])) out[k] = remote[k]; } // we removed it unless they changed it
    }
    return out;
  }

  if ((idArray(local) || idArray(remote)) && Array.isArray(local) && Array.isArray(remote)) {
    const byId = (arr) => new Map((Array.isArray(arr) ? arr : []).filter(isObj).map((x) => [x.id, x]));
    const B = byId(base), L = byId(local), R = byId(remote);
    const out = [];
    for (const [id, l] of L) {
      if (R.has(id)) out.push(merge3(B.get(id), l, R.get(id)));
      else if (!B.has(id) || !same(l, B.get(id))) out.push(l);      // new here, or edited here after they deleted it
    }
    for (const [id, r] of R) {
      if (L.has(id)) continue;
      if (!B.has(id) || !same(r, B.get(id))) out.push(r);           // new there, or edited there after we deleted it
    }
    return out;
  }

  if (primArray(local) && primArray(remote)) {
    const b = new Set(Array.isArray(base) ? base : []);
    const removed = new Set([...b].filter((x) => !local.includes(x) || !remote.includes(x)));
    const out = [];
    for (const x of [...local, ...remote]) if (!out.includes(x) && !removed.has(x)) out.push(x);
    return out;
  }

  return local;
}
