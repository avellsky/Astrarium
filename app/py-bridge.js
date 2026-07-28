/* Static-build bridge: runs the Python compute core in a Web Worker
 * (Pyodide/WebAssembly) and reroutes the app's fetch('/api/...') calls
 * to it — no server needed.  This file is only referenced by the
 * index.html of dist/web (scripts/build_web_dist.py); the dev server
 * setup never loads it.
 */
"use strict";
(function () {
  const worker = new Worker("pyodide-worker.js");
  let ready = false;
  let seq = 0;
  const pending = new Map();
  const queue = [];

  // boot overlay -----------------------------------------------------
  const ov = document.createElement("div");
  ov.id = "pyboot-overlay";
  ov.innerHTML = "<div class='box'><b>Astrarium</b>" +
    "<div id='pyboot-msg'>計算エンジンを起動中… / starting engine…</div>" +
    "<progress></progress></div>";
  const style = document.createElement("style");
  style.textContent =
    "#pyboot-overlay{position:fixed;inset:0;background:#0b0e1a;color:#dfe6f5;" +
    "display:flex;align-items:center;justify-content:center;z-index:99;" +
    "font-family:sans-serif}#pyboot-overlay .box{text-align:center;" +
    "line-height:2}#pyboot-overlay progress{width:240px}";
  document.addEventListener("DOMContentLoaded", () => {
    document.head.appendChild(style);
    document.body.appendChild(ov);
  });

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "status") {
      const el = document.getElementById("pyboot-msg");
      if (el) el.textContent = m.text;
      if (m.ready) {
        ready = true;
        ov.remove();
        queue.splice(0).forEach((f) => f());
      }
      if (m.failed && el) el.style.color = "#ff6060";
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.body);
    else p.reject(new Error(m.error || "worker error"));
  };

  // subpath-hosting fix: the app addresses /milkyway.png absolutely
  // (via new Image().src, which fetch patching cannot see) — rewrite it
  // to a document-relative URL so it works when dist/web is served
  // under a prefix (e.g. https://host/astrarium/).
  const MW_REL = new URL("milkyway.png", document.baseURI).href;
  const srcDesc = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(v) {
      srcDesc.set.call(this, v === "/milkyway.png" ? MW_REL : v);
    },
  });

  const origFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    const u = typeof url === "string" ? url : url.url;
    // subpath-hosting fix: the app addresses this asset absolutely
    if (u === "/milkyway.png") return origFetch(MW_REL, opts);
    const i = u.indexOf("/api/");
    if (i !== 0) return origFetch(url, opts);

    const run = () => new Promise((resolve, reject) => {
      const id = ++seq;
      const [path, query] = u.split("?");
      const qs = {};
      new URLSearchParams(query || "").forEach((v, k) => {
        (qs[k] = qs[k] || []).push(v);
      });
      pending.set(id, {
        resolve: (body) => resolve(new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })),
        reject,
      });
      // a POST carries element-set text the page downloaded (the
      // WebAssembly core cannot fetch anything itself)
      const post = opts && String(opts.method || "").toUpperCase() === "POST";
      worker.postMessage({ id, name: path.slice(5), qs,
                           body: post ? String(opts.body || "") : null });
    });
    if (ready) return run();
    return new Promise((res, rej) => queue.push(() => run().then(res, rej)));
  };
})();
