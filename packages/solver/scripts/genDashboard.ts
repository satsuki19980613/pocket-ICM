/**
 * 教師データ生成の進捗ダッシュボード（ローカルGUI, dev専用・依存ゼロ）。
 *
 * バッチ（start-gen-dashboard.bat）から起動する。Node 標準 http だけでローカルの Web GUI を
 * 立て、genNwayTrainData.ts を子プロセスとして起動/制御し、進捗・推定残り時間を表示する。
 * さつきが計算機を自分で ON/OFF でき、CPU を休ませる時間も作れるようにするのが目的。
 *
 *  - 制御は file-based IPC（artifacts/nn{N}way.control.json）で子プロセスへ伝える。
 *    pause/stop は「点の切れ目」で反映される（1点≈40s なので最大その程度の遅延）。
 *  - stop は子がチェックポイント保存して正常終了＝次回スタートでレジューム。電源OFFでも同様。
 *  - CPU休憩スケジューラ: 「稼働 N 分 → 休憩 M 分」を繰り返す（休憩中は pause＝CPUアイドル）。
 *
 * 実行: node --import tsx scripts/genDashboard.ts [players] [samples] [axisCsv] [ckptEvery] [port]
 *   既定: players=5, samples=40000, axis=2,8,14,20,25, ckpt=10, port=4577
 */
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOLVER_DIR = join(HERE, '..');
const OUT_DIR = join(SOLVER_DIR, 'artifacts');

const PLAYERS = Number(process.argv[2] ?? 5);
const SAMPLES = Number(process.argv[3] ?? 40_000);
const AXIS = process.argv[4] ?? '2,8,14,20,25';
const CKPT = Number(process.argv[5] ?? 10);
const PORT = Number(process.argv[6] ?? 4577);
const TAG = `nn${PLAYERS}way`;
const CONTROL = join(OUT_DIR, `${TAG}.control.json`);
const STATUS = join(OUT_DIR, `${TAG}.status.json`);

let child: ChildProcess | null = null;
let childAlive = false;
const logs: string[] = [];
const pushLog = (s: string): void => {
  for (const line of s.split(/\r?\n/)) if (line.trim()) logs.push(line);
  while (logs.length > 200) logs.shift();
};

// CPU 休憩スケジューラ
const sched = { enabled: false, workMin: 50, restMin: 10, phase: 'work' as 'work' | 'rest', since: Date.now() };
let schedTimer: NodeJS.Timeout | null = null;

const writeControl = (action: 'run' | 'pause' | 'stop'): void => {
  try { writeFileSync(CONTROL, JSON.stringify({ action, at: new Date().toISOString() })); } catch { /* noop */ }
};

function startChild(): void {
  if (childAlive) return;
  writeControl('run');
  pushLog(`▶ 生成プロセスを起動: players=${PLAYERS} samples=${SAMPLES} axis=${AXIS} ckpt=${CKPT}`);
  const args = ['--import', 'tsx', 'scripts/genNwayTrainData.ts', String(PLAYERS), String(SAMPLES), AXIS, String(CKPT)];
  child = spawn(process.execPath, args, { cwd: SOLVER_DIR, env: process.env });
  childAlive = true;
  child.stdout?.on('data', (d: Buffer) => pushLog(d.toString()));
  child.stderr?.on('data', (d: Buffer) => pushLog(d.toString()));
  child.on('exit', (code) => {
    childAlive = false; child = null;
    pushLog(`■ 生成プロセス終了 (code=${code ?? '?'})`);
  });
}

function stopChild(): void {
  if (!childAlive) return;
  writeControl('stop'); // 子は点の切れ目でチェックポイント保存→正常終了
  pushLog('⏹ 停止要求（次の点の切れ目で保存して終了します）');
  setSchedule({ enabled: false });
}

function setSchedule(patch: Partial<typeof sched>): void {
  Object.assign(sched, patch);
  if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  if (!sched.enabled) return;
  sched.phase = 'work'; sched.since = Date.now(); writeControl('run');
  pushLog(`⏱ CPU休憩スケジュール ON: 稼働${sched.workMin}分 / 休憩${sched.restMin}分`);
  schedTimer = setInterval(() => {
    if (!childAlive) return;
    const elapsedMin = (Date.now() - sched.since) / 60000;
    if (sched.phase === 'work' && elapsedMin >= sched.workMin) {
      sched.phase = 'rest'; sched.since = Date.now(); writeControl('pause');
      pushLog('⏸ CPU休憩に入ります');
    } else if (sched.phase === 'rest' && elapsedMin >= sched.restMin) {
      sched.phase = 'work'; sched.since = Date.now(); writeControl('run');
      pushLog('▶ 稼働を再開します');
    }
  }, 5000);
}

function readStatus(): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(STATUS, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

const HTML = /* html */ `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>教師データ生成モニタ</title>
<style>
  :root{--bg:#0a0a12;--panel:#12121f;--line:#26263a;--txt:#eef0ff;--dim:#8b8bb0;
    --cyan:#22e0ff;--yellow:#ffe500;--mag:#ff2e97;--green:#39ff88;}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(120% 80% at 50% -10%,#151530,#07070e 70%);color:var(--txt);
    font-family:"Segoe UI",system-ui,sans-serif;min-height:100vh;padding:22px 16px 40px}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:15px;letter-spacing:.18em;color:var(--cyan);text-transform:uppercase;margin:0 0 3px;font-weight:700}
  .sub{font-size:12px;color:var(--dim);margin-bottom:18px}
  .eta{font-size:13px;color:var(--dim);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px}
  .etabig{font-size:52px;font-weight:800;line-height:1;color:var(--yellow);
    text-shadow:0 0 18px rgba(255,229,0,.35);font-variant-numeric:tabular-nums}
  .state{display:inline-block;margin-top:10px;font-size:12px;font-weight:700;letter-spacing:.08em;
    padding:5px 13px;border-radius:100px;border:1px solid var(--line);text-transform:uppercase}
  .st-running{color:var(--green);border-color:rgba(57,255,136,.5);box-shadow:0 0 14px rgba(57,255,136,.2)}
  .st-paused{color:var(--yellow);border-color:rgba(255,229,0,.5)}
  .st-stopped,.st-off{color:var(--mag);border-color:rgba(255,46,151,.5)}
  .st-done{color:var(--cyan);border-color:rgba(34,224,255,.5)}
  .bar{height:14px;border-radius:100px;background:#1c1c2e;overflow:hidden;margin:20px 0 6px;border:1px solid var(--line)}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--mag),var(--cyan));
    box-shadow:0 0 12px rgba(34,224,255,.5);transition:width .4s;width:0}
  .pct{font-size:13px;color:var(--dim);font-variant-numeric:tabular-nums}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:20px 0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
  .card .k{font-size:11px;color:var(--dim);letter-spacing:.06em;text-transform:uppercase}
  .card .v{font-size:21px;font-weight:800;margin-top:5px;font-variant-numeric:tabular-nums}
  .btns{display:flex;gap:9px;flex-wrap:wrap;margin:8px 0 20px}
  button{font:inherit;font-size:14px;font-weight:700;padding:11px 20px;border-radius:10px;cursor:pointer;
    border:1px solid var(--line);background:var(--panel);color:var(--txt);letter-spacing:.03em}
  button:hover{border-color:var(--cyan)}
  button.go{background:var(--green);color:#042012;border-color:var(--green)}
  button.pause{background:var(--yellow);color:#251f00;border-color:var(--yellow)}
  button.stop{background:var(--mag);color:#2a0016;border-color:var(--mag)}
  button:disabled{opacity:.4;cursor:not-allowed}
  .rest{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:18px}
  .rest .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--dim)}
  .rest input{width:64px;font:inherit;background:#0d0d18;border:1px solid var(--line);color:var(--txt);
    border-radius:8px;padding:6px 9px;text-align:center;font-variant-numeric:tabular-nums}
  .log{background:#08080f;border:1px solid var(--line);border-radius:12px;padding:12px 14px;
    font-family:"Cascadia Code",Consolas,monospace;font-size:11.5px;color:#9fe6c8;height:190px;
    overflow-y:auto;white-space:pre-wrap;line-height:1.55}
  .hint{font-size:11.5px;color:var(--dim);margin-top:6px;line-height:1.6}
</style></head><body><div class="wrap">
  <h1>◢ Training Data Generator</h1>
  <div class="sub" id="cfg"></div>
  <div class="eta">推定残り時間</div>
  <div class="etabig" id="eta">—</div>
  <div><span class="state st-off" id="state">OFF</span></div>
  <div class="bar"><i id="barfill"></i></div>
  <div class="pct" id="pct">—</div>
  <div class="grid" id="grid"></div>
  <div class="btns">
    <button class="go" id="bStart">▶ 開始 / 再開</button>
    <button class="pause" id="bPause">⏸ 一時停止</button>
    <button id="bResume">▶ 再開</button>
    <button class="stop" id="bStop">⏹ 停止（保存して終了）</button>
  </div>
  <div class="rest">
    <div class="row">
      <label><input type="checkbox" id="schOn"> CPU休憩スケジュール</label>
      稼働 <input type="number" id="workMin" value="50" min="1"> 分 →
      休憩 <input type="number" id="restMin" value="10" min="1"> 分 を繰り返す
      <button id="bSched" style="padding:7px 14px;font-size:12px">適用</button>
    </div>
    <div class="hint">一時停止・停止・休憩は「次の点の切れ目」（1点あたり約40秒）で反映されます。停止すればチェックポイントに保存され、電源を切っても次回そこから再開します。</div>
  </div>
  <div class="log" id="log"></div>
</div>
<script>
const $=id=>document.getElementById(id);
function fmtDur(ms){if(!ms||ms<0)return "—";let s=Math.round(ms/1000);const d=Math.floor(s/86400);s-=d*86400;const h=Math.floor(s/3600);s-=h*3600;const m=Math.floor(s/60);return (d?d+"日":"")+(h||d?h+"時間":"")+m+"分";}
async function poll(){
  let r; try{ r=await (await fetch('/api/status')).json(); }catch{ return; }
  const st=r.status, alive=r.childAlive;
  $('cfg').textContent=\`\${r.players}人 / samples \${r.samples} / axis \${r.axis} — port \${location.port}\`;
  const state = !alive ? (st&&st.state==='done'?'done':'off') : (st?st.state:'running');
  const map={running:['稼働中','st-running'],paused:['休憩・一時停止','st-paused'],stopped:['停止','st-stopped'],done:['完了 ✓','st-done'],off:['停止中(OFF)','st-off']};
  const [lbl,cls]=map[state]||['—','st-off'];
  const se=$('state'); se.textContent=lbl; se.className='state '+cls;
  if(st){
    const pctv=st.total?st.done/st.total*100:0;
    $('barfill').style.width=pctv+'%';
    $('pct').textContent=\`\${st.done} / \${st.total} 点  (\${pctv.toFixed(1)}%)\`;
    $('eta').textContent = (alive&&state!=='done') ? fmtDur(st.etaMs) : (state==='done'?'完了':'停止中');
    const avg=st.avgMsPerPoint?(st.avgMsPerPoint/1000).toFixed(1)+'s':'—';
    const last=st.lastStacks?st.lastStacks.join(' / ')+'bb':'—';
    $('grid').innerHTML=[
      ['平均',avg+' /点'],['済み点',st.done+' / '+st.total],
      ['直近スタック',last],['セッション再開起点',st.resumeDone]
    ].map(([k,v])=>\`<div class="card"><div class="k">\${k}</div><div class="v">\${v}</div></div>\`).join('');
  }
  $('bStart').disabled=alive; $('bPause').disabled=!alive; $('bResume').disabled=!alive; $('bStop').disabled=!alive;
  $('log').textContent=(r.logs||[]).slice(-60).join('\\n'); $('log').scrollTop=$('log').scrollHeight;
  if(r.sched){$('schOn').checked=r.sched.enabled;$('workMin').value=r.sched.workMin;$('restMin').value=r.sched.restMin;}
}
const post=(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(poll);
$('bStart').onclick=()=>post('/api/start');
$('bPause').onclick=()=>post('/api/pause');
$('bResume').onclick=()=>post('/api/resume');
$('bStop').onclick=()=>{if(confirm('停止します（保存して終了・再開可）。よろしいですか？'))post('/api/stop');};
$('bSched').onclick=()=>post('/api/schedule',{enabled:$('schOn').checked,workMin:+$('workMin').value,restMin:+$('restMin').value});
poll(); setInterval(poll,2000);
</script></body></html>`;

function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML); return;
  }
  if (url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ players: PLAYERS, samples: SAMPLES, axis: AXIS, childAlive, status: readStatus(), logs, sched }));
    return;
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (url === '/api/start') startChild();
    else if (url === '/api/pause') writeControl('pause');
    else if (url === '/api/resume') writeControl('run');
    else if (url === '/api/stop') stopChild();
    else if (url === '/api/schedule') setSchedule({ enabled: !!body.enabled, workMin: Math.max(1, Number(body.workMin) || 50), restMin: Math.max(1, Number(body.restMin) || 10) });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  process.stderr.write(`\n=== 教師データ生成モニタ ===\n  ${url}\n  players=${PLAYERS} samples=${SAMPLES} axis=${AXIS}\n  ブラウザが自動で開きます。閉じてもこのウィンドウが生きていれば計算は続きます。\n\n`);
  if (existsSync(STATUS)) pushLog('前回の status を検出（レジューム可能）');
  // ブラウザ自動起動（Windows）
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
