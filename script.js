"use strict";

// In the Electron app (see preload.js) pages load in <webview> and every site works.
// In a normal browser pages load in <iframe>, which only works for sites that allow embedding.
const IN_APP = !!(window.shell && window.shell.onOpenUrl);

const BUILTIN = [
  {id: "google",    name: "Google",     kw: "g",    url: "https://www.google.com/search?q={searchTerms}"},
  {id: "brave",     name: "Brave",      kw: "b",    url: "https://search.brave.com/search?q={searchTerms}"},
  {id: "bing",      name: "Bing",       kw: "bing", url: "https://www.bing.com/search?q={searchTerms}"},
  {id: "ddg",       name: "DuckDuckGo", kw: "ddg",  url: "https://duckduckgo.com/?q={searchTerms}"},
  {id: "ecosia",    name: "Ecosia",     kw: "eco",  url: "https://www.ecosia.org/search?q={searchTerms}"},
  {id: "startpage", name: "Startpage",  kw: "sp",   url: "https://www.startpage.com/sp/search?query={searchTerms}"},
  // Results are fetched and drawn by this page itself, so it works inside any browser, with no key.
  {id: "wikipedia", name: "Wikipedia (results shown here)", kw: "w", native: true}
];
const DOMAIN = /^(localhost|\d{1,3}(\.\d{1,3}){3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d{1,5})?([\/?#]\S*)?$/i;
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3})(?![\w.-])/i;
const $ = id => document.getElementById(id);

let custom = [], defaultId = "google", tabs = [], active = null, seq = 0, settingsOpen = false;
try {
  custom = JSON.parse(localStorage.getItem("br-custom") || "[]");
  defaultId = localStorage.getItem("br-default") || "google";
} catch (e) {}
if (!Array.isArray(custom)) custom = [];
const save = () => {
  try {
    localStorage.setItem("br-custom", JSON.stringify(custom));
    localStorage.setItem("br-default", defaultId);
  } catch (e) {}
};

const all = () => BUILTIN.concat(custom);
const current = () => all().find(e => e.id === defaultId) || BUILTIN[0];
const hostOf = u => { try { return new URL(u).host; } catch (_) { return u; } };
const shortName = e => e.name.replace(/ \(.*\)$/, "");

/* ---------- address bar rules ----------
   1. a web address            → open that site
   2. keyword + text           → search with that keyword's engine
   3. any other text           → search with the selected default engine   */
function forEngine(e, terms) {
  if (e.native) return {wiki: terms, label: shortName(e) + ": " + terms};
  return {url: e.url.replace("{searchTerms}", encodeURIComponent(terms)), label: shortName(e) + ": " + terms};
}
function resolve(raw) {
  const t = raw.trim();
  if (!t) return null;
  if (/^https?:\/\/\S+$/i.test(t)) return {url: t, label: hostOf(t)};
  const m = t.match(/^(\S+)\s+(.+)$/);
  if (m) {
    const e = all().find(x => x.kw.toLowerCase() === m[1].toLowerCase());
    if (e) return forEngine(e, m[2]);
  }
  if (DOMAIN.test(t)) {
    const u = (LOCAL.test(t) ? "http://" : "https://") + t;
    return {url: u, label: hostOf(u)};
  }
  return forEngine(current(), t);
}

/* ---------- tabs ---------- */
function makePage(t) {
  let el;
  if (IN_APP) {
    el = document.createElement("webview");
    el.setAttribute("partition", "persist:browser");
    el.addEventListener("dom-ready", () => { t.ready = true; updateNav(); });
    el.addEventListener("page-title-updated", e => { if (t.url) { t.title = e.title; renderTabs(); } });
    const moved = e => {
      if (e.isMainFrame === false) return;
      const cur = t.stack[t.idx];
      if (t.pending && cur) cur.url = e.url;          // our own navigation (maybe redirected)
      else if (!cur || cur.url !== e.url) push(t, {url: e.url, label: hostOf(e.url)}); // user clicked a link
      t.pending = false; t.url = e.url; t.error = "";
      if (t === active) { refreshBar(); renderView(); updateNav(); }
    };
    el.addEventListener("did-navigate", moved);
    el.addEventListener("did-navigate-in-page", moved);
    el.addEventListener("did-start-loading", () => { t.loading = true; renderTabs(); if (t === active) updateNav(); });
    el.addEventListener("did-stop-loading", () => { t.loading = false; renderTabs(); if (t === active) updateNav(); });
    el.addEventListener("did-fail-load", e => {
      if (!e.isMainFrame || e.errorCode === -3) return;
      t.error = e.errorDescription + " (" + e.validatedURL + ")";
      if (t === active) renderView();
    });
  } else {
    el = document.createElement("iframe");
    el.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads");
    el.title = "Page";
    el.addEventListener("load", () => {
      if (!t.url) return;
      t.loading = false; renderTabs(); if (t === active) updateNav();
    });
  }
  el.className = "page";
  return el;
}

function newTab(target) {
  const t = {id: ++seq, title: "New tab", url: "", wiki: null, stack: [], idx: -1, ready: false, loading: false, pending: false, error: ""};
  t.el = makePage(t);
  $("view").appendChild(t.el);
  tabs.push(t);
  select(t);
  if (target) open(t, target); else $("q").focus();
  return t;
}

function push(t, target) {
  t.stack = t.stack.slice(0, t.idx + 1);
  t.stack.push(target);
  t.idx = t.stack.length - 1;
}

function open(t, target, record = true) {
  if (record) push(t, target);
  show(t, target);
}

function show(t, target) {
  t.error = "";
  t.title = target.label;
  if (target.wiki !== undefined) {
    t.url = "";
    t.wiki = {terms: target.wiki, items: null, msg: "Searching…"};
    searchWiki(t);
  } else {
    t.wiki = null;
    t.url = target.url;
    t.loading = true;
    t.pending = true;
    if (IN_APP && t.ready) t.el.loadURL(target.url).catch(() => {});
    else t.el.src = target.url;
  }
  if (t === active) refreshBar();
  renderTabs(); renderView(); updateNav();
}

function select(t) {
  active = t; settingsOpen = false;
  refreshBar(); renderTabs(); renderView(); updateNav();
}

function closeTab(t) {
  const i = tabs.indexOf(t);
  t.el.remove();
  tabs.splice(i, 1);
  if (!tabs.length) { newTab(); return; }
  if (t === active) select(tabs[Math.min(i, tabs.length - 1)]); else renderTabs();
}

const refreshBar = () => { $("q").value = active.url || (active.wiki ? active.title : ""); };

function renderTabs() {
  document.querySelectorAll(".tab").forEach(n => n.remove());
  tabs.forEach(t => {
    const el = document.createElement("div");
    el.className = "tab" + (t === active ? " on" : "");
    const label = document.createElement("span");
    label.textContent = (t.loading ? "… " : "") + (t.url || t.wiki ? t.title : "New tab");
    const x = document.createElement("button");
    x.className = "x"; x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Close tab");
    x.addEventListener("click", ev => { ev.stopPropagation(); closeTab(t); });
    el.append(label, x);
    el.addEventListener("click", () => select(t));
    $("tabs").insertBefore(el, $("plus"));
  });
}

function renderView() {
  const a = active;
  tabs.forEach(t => t.el.classList.toggle("on", t === a && !t.wiki));
  $("settings").hidden = !settingsOpen;
  $("fail").hidden = settingsOpen || !a.error;
  $("failMsg").textContent = a.error;
  $("home").hidden = settingsOpen || !!a.url || !!a.wiki;
  $("homeHint").textContent = "Searches use " + shortName(current()) + ". Change it in the address bar.";
  renderResults();
  const showNote = !IN_APP && !settingsOpen && !!a.url;
  $("embedNote").hidden = !showNote;
  if (showNote) $("newTabLink").href = a.url;
}

function updateNav() {
  const a = active;
  $("back").disabled = !(a && a.idx > 0);
  $("fwd").disabled = !(a && a.idx < a.stack.length - 1);
  $("reload").textContent = IN_APP && a && a.loading && a.url ? "✕" : "⟳";
  $("reload").setAttribute("aria-label", IN_APP && a && a.loading && a.url ? "Stop" : "Reload");
}

/* ---------- Wikipedia results, drawn inside the browser ---------- */
async function searchWiki(t) {
  const w = t.wiki;
  try {
    const res = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=10&format=json&origin=*&srsearch=" + encodeURIComponent(w.terms));
    const data = await res.json();
    if (t.wiki !== w) return;
    w.items = (data.query.search || []).map(s => ({
      title: s.title,
      text: new DOMParser().parseFromString(s.snippet, "text/html").body.textContent
    }));
    w.msg = w.items.length ? "" : "No results.";
  } catch (e) {
    if (t.wiki !== w) return;
    w.items = [];
    w.msg = "Couldn’t reach Wikipedia. Check your connection and try again.";
  }
  if (t === active) renderView();
}

function renderResults() {
  const w = active.wiki, panel = $("results");
  panel.hidden = settingsOpen || !w;
  if (!w) return;
  $("rTitle").textContent = "Wikipedia: " + w.terms;
  $("rMsg").textContent = w.msg;
  const ul = $("rList");
  ul.textContent = "";
  (w.items || []).forEach(item => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button"; b.className = "t"; b.textContent = item.title;
    b.addEventListener("click", () => open(active, {
      url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(item.title.replace(/ /g, "_")),
      label: item.title
    }));
    const s = document.createElement("p");
    s.className = "s"; s.textContent = item.text;
    li.append(b, s);
    ul.appendChild(li);
  });
  ul.hidden = !(w.items && w.items.length);
}

/* ---------- search engine list ---------- */
function renderEngines() {
  const sel = $("engine");
  sel.textContent = "";
  all().forEach(e => {
    const o = document.createElement("option");
    o.value = e.id; o.textContent = shortName(e);
    sel.appendChild(o);
  });
  sel.value = current().id;

  const ul = $("engines");
  ul.textContent = "";
  all().forEach(e => {
    const li = document.createElement("li");
    const n = document.createElement("strong"); n.textContent = shortName(e);
    const m = document.createElement("span"); m.className = "meta";
    m.textContent = e.native ? "Results appear inside the browser" : hostOf(e.url.replace("{searchTerms}", "x"));
    const k = document.createElement("kbd"); k.textContent = e.kw;
    li.append(n, m, k);
    if (e.custom) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "rm"; b.textContent = "Remove";
      b.addEventListener("click", () => {
        custom = custom.filter(x => x.id !== e.id);
        if (defaultId === e.id) defaultId = "google";
        save(); renderEngines(); renderView();
      });
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
}

/* ---------- wiring ---------- */
$("toolbar").addEventListener("submit", ev => {
  ev.preventDefault();
  const target = resolve($("q").value);
  if (!target) return;
  settingsOpen = false;
  open(active, target);
  $("q").blur();
});
$("q").addEventListener("focus", () => $("q").select());
$("engine").addEventListener("change", ev => { defaultId = ev.target.value; save(); renderView(); });
$("plus").addEventListener("click", () => newTab());
$("back").addEventListener("click", () => { if (active.idx > 0) { active.idx--; show(active, active.stack[active.idx]); } });
$("fwd").addEventListener("click", () => { if (active.idx < active.stack.length - 1) { active.idx++; show(active, active.stack[active.idx]); } });
$("reload").addEventListener("click", () => {
  const a = active;
  if (IN_APP && a.loading && a.url && a.ready) { a.el.stop(); return; }
  if (a.idx >= 0) show(a, a.stack[a.idx]);
});
$("gear").addEventListener("click", () => { settingsOpen = !settingsOpen; renderView(); });
$("closeSettings").addEventListener("click", () => { settingsOpen = false; renderView(); });

$("add").addEventListener("submit", ev => {
  ev.preventDefault();
  const name = $("nName").value.trim(), kw = $("nKw").value.trim(), url = $("nUrl").value.trim();
  const err = $("err");
  if (!/^[a-z0-9_-]{1,12}$/i.test(kw)) { err.textContent = "Keyword: use letters, numbers, - or _ (no spaces)."; return; }
  if (all().some(e => e.kw.toLowerCase() === kw.toLowerCase())) { err.textContent = "That keyword is already in use."; return; }
  if (!/^https?:\/\/\S+$/i.test(url) || !url.includes("{searchTerms}")) { err.textContent = "The URL must start with https:// and include {searchTerms}."; return; }
  custom.push({id: "c" + Date.now(), name, kw, url, custom: true});
  err.textContent = "";
  ev.target.reset();
  save(); renderEngines();
});

if (IN_APP) {
  window.shell.onOpenUrl(url => newTab({url, label: hostOf(url)}));
  window.shell.onShortcut(key => {
    if (key === "t") newTab();
    else if (key === "w") closeTab(active);
    else if (key === "l") { $("q").focus(); $("q").select(); }
    else if (key === "r") $("reload").click();
  });
}

renderEngines();
newTab();
