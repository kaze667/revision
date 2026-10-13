// Révisions espacées : logiciel de bureau (Windows et Mac).
// - L'interface est chargée depuis le site (toujours à jour), avec une copie intégrée si pas d'internet.
// - Les données restent sur le PC (dossier de l'utilisateur), sans compte ni serveur.
// - Rappels du matin et du soir en notifications, icône près de l'horloge, lancement au démarrage.
// - Mises à jour du logiciel : automatiques sur Windows, bandeau + lien de téléchargement sur Mac.
"use strict";
const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, shell, dialog, net } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { createStore, writeAtomic } = require("./store");
const { localNow, buildMessage, dueMoments } = require("./rappels");
const CFG = require("./config.json");

const APP_ID = "io.github.kaze667.revisions";
const SITE = new URL(CFG.siteUrl);
const LOCAL_INDEX = path.join(__dirname, "app", "index.html");
const ICON = path.join(__dirname, "build", "icon.png");

let win = null, tray = null, quitting = false, store = null, updateState = null;
let dataDir, filesDir, settingsFile;

/* ---------- Une seule fenêtre à la fois ---------- */
if (!app.requestSingleInstanceLock()) { app.quit(); }
else app.on("second-instance", () => showWindow());

if (process.platform === "win32") app.setAppUserModelId(APP_ID);
// Dossier des données toujours au même endroit : %APPDATA%\Revisions espacees (Windows),
// ~/Library/Application Support/Revisions espacees (Mac)
app.setPath("userData", path.join(app.getPath("appData"), "Revisions espacees"));

/* ---------- Réglages ---------- */
const DEFAULTS = { ia_provider: "gemini", heure_matin: "07:00", heure_soir: "20:00", notif_on: true };
const SETTINGS_KEYS = ["prenom", "niveau", "ia_provider", "gemini_key", "gemini_model", "claude_key", "claude_model", "notif_on", "heure_matin", "heure_soir", "tz", "last_matin", "last_soir", "premier_lancement"];
function readSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(settingsFile, "utf8"))); } catch (e) { return Object.assign({}, DEFAULTS); }
}
function writeSettings(patch) {
  const cur = readSettings();
  for (const k of Object.keys(patch || {})) if (SETTINGS_KEYS.includes(k)) cur[k] = patch[k];
  for (const k of ["heure_matin", "heure_soir"]) if (!/^[0-2]\d:[0-5]\d$/.test(cur[k] || "")) cur[k] = DEFAULTS[k];
  writeAtomic(settingsFile, JSON.stringify(cur, null, 1));
  return cur;
}

/* ---------- Fenêtre ---------- */
const allowedUrl = u => {
  try { const x = new URL(u); return (x.origin === SITE.origin && x.pathname.startsWith(SITE.pathname)) || x.protocol === "file:"; } catch (e) { return false; }
};
function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 380, minHeight: 500, show: false,
    title: "Révisions espacées", backgroundColor: "#141526", icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  win.removeMenu();
  let fellBack = false;
  const fallback = () => { if (fellBack) return; fellBack = true; win.loadFile(LOCAL_INDEX); };
  const timer = setTimeout(fallback, 12000);
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && !String(url).startsWith("file:")) { clearTimeout(timer); fallback(); }
  });
  win.webContents.on("did-navigate", (_e, url, code) => { if (!String(url).startsWith("file:") && code >= 400) { clearTimeout(timer); fallback(); } });
  win.webContents.on("did-finish-load", async () => {
    if (String(win.webContents.getURL()).startsWith("file:")) return;
    clearTimeout(timer);
    // Le site doit connaître le mode logiciel ; sinon (page d'erreur, ancienne version) : copie intégrée
    let ok = false;
    try { ok = await win.webContents.executeJavaScript("typeof bootDesktop === 'function' && typeof startApp === 'function'"); } catch (e) {}
    if (!ok) fallback();
  });
  win.loadURL(SITE.href, { extraHeaders: "pragma: no-cache\n" });

  // Liens externes (Google AI Studio, etc.) : dans le navigateur habituel
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!allowedUrl(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(["clipboard-sanitized-write", "notifications", "media"].includes(perm)));

  win.once("ready-to-show", () => { if (!hidden) win.show(); });
  win.on("close", e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    const s = readSettings();
    if (!s.premier_lancement) {
      writeSettings({ premier_lancement: true });
      notify("Toujours là pour tes rappels", "Le logiciel continue en arrière-plan (icône près de l'horloge). Clic droit dessus puis Quitter pour le fermer complètement.");
    }
  });
}
function showWindow(tab) {
  if (!win) createWindow(false);
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  if (tab) win.webContents.send("navigate", tab);
}

/* ---------- Icône près de l'horloge ---------- */
function createTray() {
  let img = nativeImage.createFromPath(ICON).resize({ width: process.platform === "darwin" ? 18 : 16 });
  tray = new Tray(img);
  tray.setToolTip("Révisions espacées");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Ouvrir", click: () => showWindow() },
    { label: "Séance du jour", click: () => showWindow("jour") },
    { type: "separator" },
    { label: "Quitter", click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on("click", () => showWindow());
}

/* ---------- Notifications ---------- */
const live = new Set();
function notify(title, body, tab) {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body, icon: ICON, silent: false });
  live.add(n); // garder une référence, sinon le clic sur la notification est perdu
  n.on("click", () => { live.delete(n); showWindow(tab); });
  n.on("close", () => live.delete(n));
  setTimeout(() => live.delete(n), 6 * 3600 * 1000);
  n.show();
  return true;
}
function checkReminders() {
  try {
    const s = readSettings();
    const moments = dueMoments(s);
    if (!moments.length) return;
    const { date, dimanche } = localNow();
    const rows = store.all();
    for (const m of moments) {
      const msg = buildMessage(rows, date, m, s.prenom, dimanche);
      notify(msg.title, msg.body, "jour");
      writeSettings(m === "matin" ? { last_matin: date } : { last_soir: date });
    }
  } catch (e) { console.error("rappels", e); }
}

/* ---------- Mises à jour du logiciel ---------- */
const newer = (a, b) => { // a > b ?
  const pa = String(a).replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0), pb = String(b).replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};
function setUpdate(st) { updateState = st; if (win) win.webContents.send("update", st); }
let autoUpdater = null;
function setupUpdates() {
  if (!app.isPackaged) return;
  if (process.platform === "win32") {
    try { autoUpdater = require("electron-updater").autoUpdater; } catch (e) { console.error(e); return; }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // sinon, installée à la prochaine fermeture
    autoUpdater.on("update-available", i => setUpdate({ state: "downloading", version: i.version }));
    autoUpdater.on("update-downloaded", i => {
      setUpdate({ state: "ready", version: i.version });
      notify("Mise à jour prête", "La version " + i.version + " s'installera au prochain redémarrage du logiciel.");
    });
    autoUpdater.on("error", e => console.error("maj", e && e.message));
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    setTimeout(check, 15000); setInterval(check, 6 * 3600 * 1000);
  } else {
    // Mac : sans certificat Apple payant, l'installation automatique est impossible ; on prévient.
    const check = async () => {
      try {
        const r = await net.fetch(`https://api.github.com/repos/${CFG.owner}/${CFG.repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
        if (!r.ok) return;
        const j = await r.json();
        if (j && j.tag_name && newer(j.tag_name, app.getVersion())) {
          const asset = (j.assets || []).find(a => /\.dmg$/i.test(a.name) && a.name.includes(process.arch === "arm64" ? "arm64" : "x64"));
          const v = j.tag_name.replace(/^v/, "");
          if (!updateState) notify("Nouvelle version disponible", "La version " + v + " du logiciel est disponible.");
          setUpdate({ state: "available-manual", version: v, url: asset ? asset.browser_download_url : j.html_url });
        }
      } catch (e) { /* pas d'internet : on réessaiera */ }
    };
    setTimeout(check, 15000); setInterval(check, 6 * 3600 * 1000);
  }
}

/* ---------- Échanges avec l'interface ---------- */
function guard(fn) {
  return (e, ...args) => {
    const url = e.senderFrame ? e.senderFrame.url : "";
    if (!allowedUrl(url)) throw new Error("origine refusée");
    return fn(...args);
  };
}
const safeName = n => String(n || "fichier").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-80);
function inFiles(p) {
  const full = path.resolve(filesDir, String(p || ""));
  return full.startsWith(path.resolve(filesDir) + path.sep) ? full : null;
}
function registerIpc() {
  ipcMain.on("app:info", e => { e.returnValue = { version: app.getVersion(), platform: process.platform }; });
  ipcMain.handle("store:list", guard(coll => store.list(coll)));
  ipcMain.handle("store:set", guard((coll, id, data) => store.set(coll, id, data)));
  ipcMain.handle("store:del", guard((coll, id) => store.del(coll, id)));
  ipcMain.handle("store:all", guard(() => store.all()));
  ipcMain.handle("store:bulk", guard(rows => store.bulk(rows)));
  ipcMain.handle("store:wipe", guard(() => store.wipe()));
  ipcMain.handle("settings:get", guard(() => { const s = readSettings(); delete s.premier_lancement; return s; }));
  ipcMain.handle("settings:set", guard(patch => { const s = writeSettings(patch); delete s.premier_lancement; setTimeout(checkReminders, 1000); return s; }));
  ipcMain.handle("files:save", guard((name, buf) => {
    const data = Buffer.from(buf);
    if (data.length > 50 * 1024 * 1024) throw new Error("fichier trop lourd (50 Mo max)");
    const rel = localNow().date + "-" + crypto.randomBytes(4).toString("hex") + "-" + safeName(name);
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, rel), data);
    return rel;
  }));
  ipcMain.handle("files:open", guard(async p => { const f = inFiles(p); if (!f || !fs.existsSync(f)) return false; return (await shell.openPath(f)) === ""; }));
  ipcMain.handle("files:remove", guard(paths => { for (const p of paths || []) { const f = inFiles(p); if (f) fs.rmSync(f, { force: true }); } return true; }));
  ipcMain.handle("notif:test", guard(() => {
    const s = readSettings(), { date, dimanche } = localNow();
    const msg = buildMessage(store.all(), date, new Date().getHours() < 14 ? "matin" : "soir", s.prenom, dimanche);
    return notify("Test réussi : " + msg.title, msg.body, "jour");
  }));
  ipcMain.handle("file:saveAs", guard(async (name, text) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), safeName(name)) });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, String(text), "utf8");
    return true;
  }));
  ipcMain.handle("app:openExternal", guard(url => { if (/^https:\/\//i.test(url)) shell.openExternal(url); }));
  ipcMain.handle("update:state", guard(() => updateState));
  ipcMain.handle("update:install", guard(() => { if (autoUpdater && updateState && updateState.state === "ready") { quitting = true; autoUpdater.quitAndInstall(); } }));
}

/* ---------- Démarrage ---------- */
app.whenReady().then(() => {
  const ud = app.getPath("userData");
  dataDir = path.join(ud, "donnees"); filesDir = path.join(ud, "fichiers"); settingsFile = path.join(ud, "reglages.json");
  store = createStore(dataDir);
  try { store.backup(path.join(ud, "sauvegardes"), localNow().date); } catch (e) { console.error("sauvegarde", e); }

  // Lancement automatique à l'ouverture de session, discrètement (rappels)
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ["--cache"] });
  const login = app.getLoginItemSettings();
  const hidden = process.argv.includes("--cache") || !!login.wasOpenedAtLogin;

  registerIpc();
  createTray();
  createWindow(hidden);
  setupUpdates();
  checkReminders();
  setInterval(checkReminders, 60 * 1000);
  setInterval(() => { try { store.backup(path.join(ud, "sauvegardes"), localNow().date); } catch (e) {} }, 3600 * 1000);
});
app.on("activate", () => showWindow());
app.on("before-quit", () => { quitting = true; try { store && store.flush(); } catch (e) { console.error(e); } });
app.on("window-all-closed", () => { /* on reste dans la barre des tâches pour les rappels */ });
