// Pont sécurisé entre l'interface (page web) et le logiciel : la page n'a accès qu'à ces fonctions.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const info = ipcRenderer.sendSync("app:info") || {};
const call = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld("desktop", {
  apiVersion: 1,
  version: info.version,
  platform: info.platform,
  store: {
    list: coll => call("store:list", coll),
    set: (coll, id, data) => call("store:set", coll, id, data),
    del: (coll, id) => call("store:del", coll, id),
    all: () => call("store:all"),
    bulk: rows => call("store:bulk", rows),
    wipe: () => call("store:wipe")
  },
  settings: {
    get: () => call("settings:get"),
    set: patch => call("settings:set", patch)
  },
  files: {
    save: (name, buffer) => call("files:save", name, buffer),
    open: p => call("files:open", p),
    remove: paths => call("files:remove", paths)
  },
  notif: { test: () => call("notif:test") },
  saveFile: (name, text) => call("file:saveAs", name, text),
  openExternal: url => call("app:openExternal", url),
  installUpdate: () => call("update:install"),
  onUpdate: cb => {
    ipcRenderer.on("update", (_e, st) => cb(st));
    call("update:state").then(st => { if (st) cb(st); });
  },
  onNavigate: cb => { ipcRenderer.on("navigate", (_e, tab) => cb(tab)); }
});
