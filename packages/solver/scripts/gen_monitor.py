# -*- coding: utf-8 -*-
"""
教師データ生成モニタ（Python ローカルアプリ / 依存ゼロ・標準ライブラリのみ）。

描画は HTML + CSS（ブラウザ）。Python は「GUI サーバ」と「Node 生成本体のプロセス制御」を担う。
生成本体（packages/solver/scripts/genNwayTrainData.ts, Node+tsx）はそのまま使い、
file-based IPC（artifacts/nn{N}way.control.json / status.json）で連携する。

  - control.json {"action":"run"|"pause"|"stop"} を書く → 本体が点の切れ目で反映。
      pause 中は本体が 1 秒 sleep（＝CPU アイドル）。stop はチェックポイント保存して正常終了。
  - status.json（本体が点ごとに書く）を読んで 進捗 / 推定残り時間(ETA) を表示。
  - stop / 電源OFF / ウィンドウを閉じる → 次回スタートで自動レジューム（本体が checkpoint 復元）。
  - CPU 休憩スケジューラ: 「稼働 N 分 → 休憩 M 分」を繰り返す（休憩中は pause）。

起動: gen_monitor.bat をダブルクリック（or  py gen_monitor.py [players] [samples] [axisCsv] [ckpt] [port]）
既定: players=5 / samples=40000 / axis=2,8,14,20,25 / ckpt=10 / port=4577
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---- 設定（引数 or 既定） -------------------------------------------------
def arg(i, default):
    return sys.argv[i] if len(sys.argv) > i else default

PLAYERS = int(arg(1, "5"))
SAMPLES = int(arg(2, "40000"))
AXIS = arg(3, "2,8,14,20,25")
CKPT = int(arg(4, "10"))
PORT = int(arg(5, "4577"))
PORT_TRIES = 20

HERE = os.path.dirname(os.path.abspath(__file__))
SOLVER_DIR = os.path.dirname(HERE)                 # packages/solver
OUT_DIR = os.path.join(SOLVER_DIR, "artifacts")
TAG = f"nn{PLAYERS}way"
CONTROL = os.path.join(OUT_DIR, f"{TAG}.control.json")
STATUS = os.path.join(OUT_DIR, f"{TAG}.status.json")
GEN_SCRIPT = os.path.join("scripts", "genNwayTrainData.ts")  # cwd=SOLVER_DIR からの相対

# ---- Node の場所を探す（PATH に無くても動くように） -----------------------
def find_node():
    p = shutil.which("node")
    if p:
        return p
    for cand in (
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\nodejs\node.exe"),
        os.path.expandvars(r"%APPDATA%\npm\node.exe"),
    ):
        if os.path.isfile(cand):
            return cand
    return None

NODE = find_node()

# ---- 子プロセス（Node 生成本体）の管理 ------------------------------------
_child = None            # subprocess.Popen | None
_child_lock = threading.Lock()

def child_alive():
    with _child_lock:
        return _child is not None and _child.poll() is None

def write_control(action):
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(CONTROL, "w", encoding="utf-8") as f:
            json.dump({"action": action}, f)
    except Exception:
        pass

def read_status():
    try:
        with open(STATUS, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def start_child():
    """control=run を書き、本体が動いていなければ起動（あれば checkpoint から自動レジューム）。"""
    global _child
    write_control("run")
    with _child_lock:
        if _child is not None and _child.poll() is None:
            return {"ok": True, "note": "既に稼働中"}
        if NODE is None:
            return {"ok": False, "error": "Node が見つかりません。Node.js をインストールしてください。"}
        args = [NODE, "--import", "tsx", GEN_SCRIPT, str(PLAYERS), str(SAMPLES), AXIS, str(CKPT)]
        try:
            creationflags = 0
            if os.name == "nt":
                creationflags = subprocess.CREATE_NO_WINDOW  # 子の別窓を出さない
            _child = subprocess.Popen(
                args, cwd=SOLVER_DIR,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=creationflags,
            )
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": f"起動に失敗: {e}"}

def pause_child():
    write_control("pause")
    return {"ok": True}

def stop_child():
    """control=stop を書く。本体が checkpoint 保存して自分で終了（次回レジューム可）。"""
    write_control("stop")
    return {"ok": True}

# ---- CPU 休憩スケジューラ --------------------------------------------------
_sched = {"enabled": False, "run_min": 50, "rest_min": 10, "phase": "-", "phase_until": 0.0}
_sched_lock = threading.Lock()

def scheduler_loop():
    """enabled かつ子が稼働中のとき、稼働N分→休憩M分 を繰り返す（control を切替）。"""
    while True:
        time.sleep(1)
        with _sched_lock:
            en = _sched["enabled"]
            run_s = max(1, _sched["run_min"]) * 60
            rest_s = max(1, _sched["rest_min"]) * 60
            phase = _sched["phase"]
            until = _sched["phase_until"]
        if not en or not child_alive():
            if phase != "-":
                with _sched_lock:
                    _sched["phase"] = "-"
            continue
        now = time.time()
        if phase == "-" or now >= until:
            # フェーズ切替
            if phase == "run":
                write_control("pause")
                with _sched_lock:
                    _sched["phase"] = "rest"
                    _sched["phase_until"] = now + rest_s
            else:
                write_control("run")
                with _sched_lock:
                    _sched["phase"] = "run"
                    _sched["phase_until"] = now + run_s

def combined_status():
    st = read_status() or {}
    alive = child_alive()
    raw_state = st.get("state")  # running|paused|stopped|done|None
    if not st:
        ui_state = "idle"
    elif raw_state == "done":
        ui_state = "done"
    elif alive:
        ui_state = raw_state or "running"
    else:
        # 子が居ない → stopped(=レジューム可) か、以前 done か
        ui_state = "stopped" if raw_state in ("stopped", "paused", "running") else (raw_state or "idle")
    with _sched_lock:
        sched = dict(_sched)
        if sched["enabled"] and sched["phase"] in ("run", "rest"):
            sched["remain_s"] = max(0, int(sched["phase_until"] - time.time()))
        else:
            sched["remain_s"] = 0
    return {
        "tag": TAG, "players": PLAYERS, "samples": SAMPLES, "axis": AXIS,
        "done": st.get("done", 0), "total": st.get("total", 0),
        "solved": st.get("solved", 0), "resumeDone": st.get("resumeDone", 0),
        "avgMsPerPoint": st.get("avgMsPerPoint", 0), "etaMs": st.get("etaMs", 0),
        "lastStacks": st.get("lastStacks"), "updatedAt": st.get("updatedAt"),
        "childAlive": alive, "state": ui_state,
        "node": NODE, "scheduler": sched,
    }

# ---- HTML（描画は HTML + CSS。CP2077 調） ---------------------------------
HTML = r"""<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>教師データ生成モニタ</title>
<style>
  :root{
    --bg:#0a0c10; --panel:#12151c; --panel2:#161a22; --line:#232a36;
    --yellow:#fcee0a; --red:#ff3b3b; --cyan:#3ae6ff; --steel:#9aa08a;
    --ink:#eef2f0; --dim:#8b94a3;
    --grad:linear-gradient(90deg,var(--red),#c026d3,var(--cyan));
  }
  *{box-sizing:border-box}
  body{margin:0;background:
      radial-gradient(1200px 400px at 80% -10%,rgba(58,230,255,.06),transparent),
      var(--bg);
    color:var(--ink);font-family:"Rajdhani","Zen Kaku Gothic New",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;padding:26px 20px 40px;max-width:820px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:10px;color:var(--cyan);
    font-weight:800;letter-spacing:.14em;font-size:15px}
  .brand b{color:var(--yellow)}
  .sub{color:var(--dim);font-size:12px;letter-spacing:.06em;margin:4px 0 22px;
    font-family:"Share Tech Mono",ui-monospace,monospace}
  .lab{color:var(--dim);font-size:11px;letter-spacing:.18em;text-transform:uppercase;
    margin-bottom:4px}
  .eta{font-family:"Rajdhani",sans-serif;font-weight:800;font-size:54px;line-height:1;
    color:var(--yellow);letter-spacing:.02em}
  .pill{display:inline-block;margin-top:10px;padding:5px 12px;border:1px solid var(--line);
    border-radius:2px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;
    font-family:"Share Tech Mono",monospace}
  .pill.running{color:#0a0c10;background:var(--yellow);border-color:var(--yellow)}
  .pill.paused{color:var(--cyan);border-color:var(--cyan)}
  .pill.stopped,.pill.idle{color:var(--steel)}
  .pill.done{color:#0a0c10;background:var(--cyan);border-color:var(--cyan)}
  .bar{height:12px;background:#0e1118;border:1px solid var(--line);border-radius:2px;
    overflow:hidden;margin:18px 0 6px;position:relative}
  .bar > i{display:block;height:100%;width:0;background:var(--grad);transition:width .4s}
  .barnum{color:var(--dim);font-size:12px;font-family:"Share Tech Mono",monospace}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}
  .card{background:var(--panel);border:1px solid var(--line);
    clip-path:polygon(0 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%);
    padding:12px 13px}
  .card .lab{margin-bottom:6px}
  .card .val{font-family:"Rajdhani",sans-serif;font-weight:700;font-size:22px}
  .card .val small{font-size:12px;color:var(--dim);font-weight:600}
  .btns{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 22px}
  button{font-family:"Rajdhani",sans-serif;font-weight:700;font-size:15px;letter-spacing:.06em;
    padding:11px 18px;border-radius:2px;border:1px solid var(--line);background:var(--panel2);
    color:var(--ink);cursor:pointer;transition:.15s}
  button:hover{border-color:var(--steel)}
  button:disabled{opacity:.4;cursor:not-allowed}
  .b-start{background:var(--yellow);color:#0a0c10;border-color:var(--yellow)}
  .b-pause{color:var(--cyan);border-color:var(--cyan)}
  .b-stop{color:var(--red);border-color:var(--red)}
  .sched{background:var(--panel);border:1px solid var(--line);border-radius:2px;
    padding:14px 15px;margin-bottom:18px}
  .sched .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:14px}
  .sched input[type=number]{width:64px;background:#0e1118;border:1px solid var(--line);
    color:var(--ink);border-radius:2px;padding:6px 8px;font-family:"Share Tech Mono",monospace}
  .sched .apply{padding:7px 14px;font-size:13px}
  .note{color:var(--dim);font-size:12px;line-height:1.7;margin-top:8px}
  .warn{color:var(--red);font-size:13px;margin-top:6px;min-height:18px}
  .hz{height:8px;margin:22px 0 6px;background:repeating-linear-gradient(
      -45deg,var(--yellow) 0 10px,#0a0c10 10px 20px);opacity:.5}
</style></head>
<body>
  <div class="brand">◤ <b>TRAINING DATA</b> GENERATOR</div>
  <div class="sub" id="cfg">loading...</div>

  <div class="lab">推定残り時間 / ETA</div>
  <div class="eta" id="eta">—</div>
  <span class="pill idle" id="pill">—</span>

  <div class="bar"><i id="fill"></i></div>
  <div class="barnum" id="barnum">0 / 0 点 (0%)</div>

  <div class="grid">
    <div class="card"><div class="lab">平均</div><div class="val" id="avg">— <small>/点</small></div></div>
    <div class="card"><div class="lab">済み点</div><div class="val" id="done">0 / 0</div></div>
    <div class="card"><div class="lab">直近スタック</div><div class="val" id="last">—</div></div>
    <div class="card"><div class="lab">経過</div><div class="val" id="elapsed">—</div></div>
  </div>

  <div class="btns">
    <button class="b-start" id="bStart">▶ 開始 / 再開</button>
    <button class="b-pause" id="bPause">Ⅱ 一時停止</button>
    <button class="b-stop"  id="bStop">■ 停止（保存して終了）</button>
  </div>

  <div class="sched">
    <div class="row">
      <label><input type="checkbox" id="scEn"> CPU休憩スケジュール</label>
      稼働 <input type="number" id="scRun" min="1" value="50"> 分 →
      休憩 <input type="number" id="scRest" min="1" value="10"> 分 を繰り返す
      <button class="apply" id="scApply">適用</button>
      <span class="barnum" id="scState"></span>
    </div>
    <div class="note">一時停止・停止・休憩は「次の点の切れ目」（1点あたり数十秒）で反映されます。
      停止すればチェックポイントに保存され、電源を切っても次回ここから再開します。</div>
    <div class="warn" id="warn"></div>
  </div>
  <div class="hz"></div>
  <div class="note" id="foot"></div>

<script>
const $=id=>document.getElementById(id);
function fmtEta(ms){
  if(!ms||ms<=0) return "—";
  let s=Math.round(ms/1000), h=Math.floor(s/3600); s-=h*3600;
  let m=Math.floor(s/60); s-=m*60;
  if(h>0) return h+"時間"+m+"分";
  if(m>0) return m+"分"+s+"秒";
  return s+"秒";
}
async function post(path,body){
  try{const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},
    body:body?JSON.stringify(body):null}); return await r.json();}catch(e){return {ok:false};}
}
let startedAt=null;
async function tick(){
  let s; try{ s=await (await fetch("/api/status")).json(); }catch(e){ return; }
  $("cfg").textContent=`${s.players}人 / samples ${s.samples} / axis ${s.axis}`;
  const pct = s.total>0 ? (s.done/s.total*100) : 0;
  $("fill").style.width=pct.toFixed(1)+"%";
  $("barnum").textContent=`${s.done} / ${s.total} 点 (${pct.toFixed(1)}%)`;
  $("eta").textContent = s.state==="done" ? "完了" : fmtEta(s.etaMs);
  $("avg").innerHTML = s.avgMsPerPoint>0 ? (s.avgMsPerPoint/1000).toFixed(1)+" <small>/点</small>" : "— <small>/点</small>";
  $("done").textContent=`${s.done} / ${s.total}`;
  $("last").textContent = s.lastStacks ? s.lastStacks.join(",") : "—";
  const label={running:"稼働中",paused:"一時停止",stopped:"停止（再開可）",done:"完了",idle:"未開始"}[s.state]||s.state;
  const p=$("pill"); p.className="pill "+s.state; p.textContent=label;
  $("bStart").disabled = (s.state==="running"||s.state==="done");
  $("bPause").disabled = (s.state!=="running");
  $("bStop").disabled  = !(s.state==="running"||s.state==="paused");
  // 経過（このモニタが開いてからの目安ではなく avg×solved）
  const elapsed = s.avgMsPerPoint>0 && s.solved>0 ? s.avgMsPerPoint*s.solved : 0;
  $("elapsed").textContent = elapsed>0 ? fmtEta(elapsed) : "—";
  // scheduler
  const sc=s.scheduler||{};
  if(document.activeElement!==$("scEn")) $("scEn").checked=!!sc.enabled;
  $("scState").textContent = sc.enabled ? (sc.phase==="run"?`稼働中 残り${Math.ceil((sc.remain_s||0)/60)}分`
    : sc.phase==="rest"?`休憩中 残り${Math.ceil((sc.remain_s||0)/60)}分`:"待機") : "";
  $("warn").textContent = s.node ? "" : "⚠ Node が見つかりません。Node.js のインストールを確認してください。";
  $("foot").textContent = "モニタURL は起動したウィンドウにも表示されています。ブラウザを閉じても、ウィンドウが生きていれば計算は続きます。";
}
$("bStart").onclick=async()=>{ $("bStart").disabled=true; const r=await post("/api/start"); if(r&&r.error)$("warn").textContent=r.error; tick(); };
$("bPause").onclick=async()=>{ await post("/api/pause"); tick(); };
$("bStop").onclick =async()=>{ await post("/api/stop");  tick(); };
$("scApply").onclick=async()=>{
  await post("/api/schedule",{enabled:$("scEn").checked,
    run_min:parseInt($("scRun").value||"50"),rest_min:parseInt($("scRest").value||"10")});
  tick();
};
$("scEn").onchange=()=>$("scApply").click();
tick(); setInterval(tick,1500);
</script>
</body></html>"""

# ---- HTTP ハンドラ ---------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # コンソールを静かに
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0:
                return {}
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            body = HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/api/status"):
            self._json(combined_status())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path.startswith("/api/start"):
            self._json(start_child())
        elif self.path.startswith("/api/pause"):
            self._json(pause_child())
        elif self.path.startswith("/api/stop"):
            self._json(stop_child())
        elif self.path.startswith("/api/schedule"):
            b = self._read_body()
            with _sched_lock:
                _sched["enabled"] = bool(b.get("enabled", False))
                _sched["run_min"] = max(1, int(b.get("run_min", 50)))
                _sched["rest_min"] = max(1, int(b.get("rest_min", 10)))
                if not _sched["enabled"]:
                    _sched["phase"] = "-"
            self._json({"ok": True})
        else:
            self.send_response(404)
            self.end_headers()

# ---- 起動 ------------------------------------------------------------------
def serve():
    global PORT
    last_err = None
    for _ in range(PORT_TRIES):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
            return httpd
        except OSError as e:
            last_err = e
            print(f"  ポート {PORT} は使用中でした。{PORT + 1} で再試行します...")
            PORT += 1
    print(f"  空きポートが見つかりませんでした: {last_err}")
    return None

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    httpd = serve()
    if httpd is None:
        input("Enter で終了...")
        return
    url = f"http://127.0.0.1:{PORT}"
    print("")
    print("  ============================================================")
    print("       教師データ生成モニタ（Python）が起動しました")
    print("  ------------------------------------------------------------")
    print("       ブラウザで下のURLを開いてください（自動でも開きます）:")
    print("")
    print(f"         {url}")
    print("")
    print(f"       players={PLAYERS} samples={SAMPLES} axis={AXIS}")
    if NODE is None:
        print("       ⚠ Node が見つかりません。Node.js をインストールしてください。")
    print("       ※このウィンドウは開いたままにしてください。")
    print("  ============================================================")
    print("")
    threading.Thread(target=scheduler_loop, daemon=True).start()
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # ウィンドウを閉じる時は checkpoint 保存を促す（best effort）
        write_control("stop")

if __name__ == "__main__":
    main()
