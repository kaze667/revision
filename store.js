// Stockage local : un fichier JSON par type de données dans le dossier de l'utilisateur.
// Écritures atomiques (fichier temporaire puis renommage) et regroupées, copie de secours quotidienne.
"use strict";
const fs = require("fs");
const path = require("path");

const COLLS = ["chapitres", "examens", "cartes", "exercices", "stats", "briefs", "textes", "blancs", "plan", "ateliers", "bilans"];

function writeAtomic(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function createStore(dir, { delay = 400 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const mem = new Map(), timers = new Map();
  const check = coll => { if (!COLLS.includes(coll)) throw new Error("type de données inconnu : " + coll); };
  const file = coll => path.join(dir, coll + ".json");

  function load(coll) {
    check(coll);
    if (mem.has(coll)) return mem.get(coll);
    let obj = {};
    for (const f of [file(coll), file(coll) + ".tmp"]) {
      try { obj = JSON.parse(fs.readFileSync(f, "utf8")); break; } catch (e) { /* absent ou abîmé : on essaie le suivant */ }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};
    mem.set(coll, obj);
    return obj;
  }
  function flushColl(coll) {
    clearTimeout(timers.get(coll)); timers.delete(coll);
    if (mem.has(coll)) writeAtomic(file(coll), JSON.stringify(mem.get(coll)));
  }
  function schedule(coll) {
    clearTimeout(timers.get(coll));
    timers.set(coll, setTimeout(() => { try { flushColl(coll); } catch (e) { console.error("écriture", coll, e); } }, delay));
  }
  const checkId = id => { if (typeof id !== "string" || !id || id.length > 200) throw new Error("identifiant invalide"); };

  return {
    COLLS,
    list(coll) { const o = load(coll); return Object.keys(o).map(id => ({ id, data: o[id] })); },
    set(coll, id, data) { checkId(id); if (!data || typeof data !== "object") throw new Error("données invalides"); load(coll)[id] = data; schedule(coll); },
    del(coll, id) { checkId(id); delete load(coll)[id]; schedule(coll); },
    all() { const rows = []; for (const c of COLLS) for (const r of this.list(c)) rows.push({ coll: c, id: r.id, data: r.data }); return rows; },
    bulk(rows) {
      const touched = new Set();
      for (const r of rows || []) { if (!r || !COLLS.includes(r.coll)) continue; checkId(r.id); if (!r.data || typeof r.data !== "object") continue; load(r.coll)[r.id] = r.data; touched.add(r.coll); }
      for (const c of touched) flushColl(c);
      return touched.size;
    },
    wipe() { for (const c of COLLS) { mem.set(c, {}); flushColl(c); } },
    flush() { for (const c of [...timers.keys()]) flushColl(c); },
    // Copie de secours du jour (les 7 dernières sont gardées)
    backup(backupDir, date) {
      this.flush();
      const target = path.join(backupDir, date);
      if (fs.existsSync(target)) return false;
      fs.mkdirSync(target, { recursive: true });
      for (const c of COLLS) { if (fs.existsSync(file(c))) fs.copyFileSync(file(c), path.join(target, c + ".json")); }
      const old = fs.readdirSync(backupDir).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().slice(0, -7);
      for (const n of old) fs.rmSync(path.join(backupDir, n), { recursive: true, force: true });
      return true;
    }
  };
}

module.exports = { createStore, writeAtomic, COLLS };
