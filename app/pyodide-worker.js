/* Web Worker: boots Pyodide, installs the astrarium package + data,
 * imports the same server module the desktop version uses, and answers
 * {id, name, qs} messages with the JSON the HTTP API would return.
 * Assembled into dist/web by scripts/build_web_dist.py.
 */
"use strict";
importScripts("pyodide/pyodide.js");

const post = (o) => self.postMessage(o);
let handleFn = null;

async function boot() {
  post({ type: "status", text: "Python (WASM) 読み込み中… / loading Python" });
  const indexURL = new URL("pyodide/", self.location).href;
  const py = await loadPyodide({ indexURL });

  post({ type: "status", text: "numpy / pyerfa 読み込み中…" });
  // sqlite3 is unvendored from the Pyodide stdlib — load it explicitly
  await py.loadPackage(["numpy", "pyerfa", "sqlite3"],
                       { messageCallback: () => {} });

  const manifest = await (await fetch("py-manifest.json")).json();
  post({ type: "status", text: "ライブラリをインストール中…" });
  await py.loadPackage(manifest.wheels.map((w) => "wheels/" + w),
                       { messageCallback: () => {} });

  py.FS.mkdirTree("/app");
  for (const f of manifest.data) {          // create nested data dirs
    const dir = ("/data/" + f).split("/").slice(0, -1).join("/");
    py.FS.mkdirTree(dir);
  }
  let n = 0;
  for (const f of manifest.data) {
    post({ type: "status",
           text: `天文データ読み込み中… (${++n}/${manifest.data.length}) ${f}` });
    const buf = await (await fetch("data/" + f)).arrayBuffer();
    py.FS.writeFile("/data/" + f, new Uint8Array(buf));
  }
  const srv = await (await fetch("server.py.txt")).text();
  py.FS.writeFile("/app/server.py", srv);

  post({ type: "status", text: "計算コアを初期化中… / warming core" });
  py.runPython(`
import os, sys, json, warnings
os.environ['ASTRARIUM_DATA'] = '/data'
sys.path.insert(0, '/app')
warnings.filterwarnings('ignore')
import server
server.core()

def _handle(name, qs_json, body=None):
    qs = json.loads(qs_json)
    # a request with a body is a POST: those routes are kept in their own
    # table so a plain GET can never reach one
    fn = (getattr(server, 'POST_ROUTES', {}).get(name) if body is not None
          else server.ROUTES.get(name))
    if fn is None:
        return json.dumps({"error": "unknown endpoint: " + name})
    try:
        out = fn(qs, body) if body is not None else fn(qs)
        return json.dumps(out, ensure_ascii=False, allow_nan=False)
    except Exception as e:  # surfaced in the client console
        import traceback
        return json.dumps({"error": str(e),
                           "trace": traceback.format_exc()[-1000:]})
`);
  handleFn = py.globals.get("_handle");
  post({ type: "status", text: "準備完了 / ready", ready: true });
}

const inbox = [];
self.onmessage = (e) => {
  inbox.push(e.data);
  drain();
};

function drain() {
  if (!handleFn) return;
  while (inbox.length) {
    const { id, name, qs, body: reqBody } = inbox.shift();
    try {
      const body = reqBody == null
        ? handleFn(name, JSON.stringify(qs))
        : handleFn(name, JSON.stringify(qs), reqBody);
      post({ id, ok: true, body });
    } catch (err) {
      post({ id, ok: false, error: String(err) });
    }
  }
}

boot().then(drain).catch((err) => {
  post({ type: "status", failed: true,
         text: "起動失敗 / boot failed: " + err });
});
