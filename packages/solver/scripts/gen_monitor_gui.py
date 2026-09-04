# -*- coding: utf-8 -*-
"""
教師データ生成モニタ（ネイティブGUI / Python 標準 Tkinter・依存ゼロ）。

ブラウザを使わず、ダブルクリックで開くローカルアプリ窓。
生成本体（Node: packages/solver/scripts/genNwayTrainData.ts）を子プロセスで起動し、
file-based IPC（artifacts/nn{N}way.control.json / status.json）で制御・進捗表示する。

  - control.json {"action":"run"|"pause"|"stop"} を書く → 本体が点の切れ目で反映。
      pause 中は本体が sleep（＝CPUアイドル）。stop は checkpoint 保存して正常終了。
  - status.json（本体が点ごとに書く）を読んで 進捗 / 推定残り時間(ETA) を表示。
  - stop / ウィンドウを閉じる → 次回スタートで自動レジューム。
  - CPU 休憩スケジューラ: 稼働N分 → 休憩M分 を繰り返す。

起動: 教師データ生成モニタ.pyw をダブルクリック（or  pythonw gen_monitor_gui.py）
"""

import json
import os
import shutil
import subprocess
import threading
import time

import tkinter as tk
from tkinter import ttk, messagebox

# ---- パス ------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
SOLVER_DIR = os.path.dirname(HERE)                 # packages/solver
OUT_DIR = os.path.join(SOLVER_DIR, "artifacts")
GEN_SCRIPT = os.path.join("scripts", "genNwayTrainData.ts")  # cwd=SOLVER_DIR 相対

# ---- 既定設定 --------------------------------------------------------------
DEFAULTS = {"players": 5, "samples": 40000, "axis": "2,8,14,20,25", "ckpt": 10}

# ---- 配色（CP2077 調） -----------------------------------------------------
C = {
    "bg": "#0c0f15", "panel": "#141822", "panel2": "#1b2130", "line": "#2a3243",
    "yellow": "#fcee0a", "red": "#ff5964", "cyan": "#3ae6ff", "ink": "#eef2f0",
    "dim": "#8b94a3", "steel": "#9aa08a",
}

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


class Monitor:
    def __init__(self, root):
        self.root = root
        self.node = find_node()
        self.child = None
        self.cfg = dict(DEFAULTS)
        self.tag = f"nn{self.cfg['players']}way"
        self._recompute_paths()
        # scheduler
        self.sched_enabled = False
        self.sched_phase = "-"        # run|rest|-
        self.sched_until = 0.0
        self._build_ui()
        self._sched_thread = threading.Thread(target=self._scheduler_loop, daemon=True)
        self._sched_thread.start()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._tick()

    # ---- IPC -------------------------------------------------------------
    def _recompute_paths(self):
        self.tag = f"nn{self.cfg['players']}way"
        self.control = os.path.join(OUT_DIR, f"{self.tag}.control.json")
        self.status = os.path.join(OUT_DIR, f"{self.tag}.status.json")

    def _write_control(self, action):
        try:
            os.makedirs(OUT_DIR, exist_ok=True)
            with open(self.control, "w", encoding="utf-8") as f:
                json.dump({"action": action}, f)
        except Exception:
            pass

    def _read_status(self):
        try:
            with open(self.status, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def _child_alive(self):
        return self.child is not None and self.child.poll() is None

    # ---- 操作 ------------------------------------------------------------
    def start(self):
        # 設定欄を読み取り（人数変更でパスも変わる）
        try:
            self.cfg["players"] = int(self.e_players.get())
            self.cfg["samples"] = int(self.e_samples.get())
            self.cfg["axis"] = self.e_axis.get().strip() or DEFAULTS["axis"]
            self.cfg["ckpt"] = int(self.e_ckpt.get())
        except ValueError:
            messagebox.showwarning("入力エラー", "人数・samples・ckpt は数値で入力してください。")
            return
        self._recompute_paths()
        self._write_control("run")
        if self._child_alive():
            return
        if self.node is None:
            messagebox.showerror("Node が見つかりません",
                                 "Node.js が見つかりませんでした。\nNode.js をインストールしてください。")
            return
        args = [self.node, "--import", "tsx", GEN_SCRIPT,
                str(self.cfg["players"]), str(self.cfg["samples"]),
                self.cfg["axis"], str(self.cfg["ckpt"])]
        try:
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            self.child = subprocess.Popen(
                args, cwd=SOLVER_DIR,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=flags,
            )
            self._set_msg("生成を開始しました。")
        except Exception as e:
            messagebox.showerror("起動に失敗", str(e))

    def pause(self):
        self._write_control("pause")
        self._set_msg("一時停止を要求しました（次の点の切れ目で反映）。")

    def stop(self):
        self._write_control("stop")
        self._set_msg("停止を要求しました（checkpoint 保存後に終了）。")

    def apply_schedule(self):
        self.sched_enabled = bool(self.v_sched.get())
        if not self.sched_enabled:
            self.sched_phase = "-"
        self._set_msg("CPU休憩スケジュールを更新しました。" if self.sched_enabled
                      else "CPU休憩スケジュールを解除しました。")

    def _scheduler_loop(self):
        while True:
            time.sleep(1)
            if not self.sched_enabled or not self._child_alive():
                if self.sched_phase != "-":
                    self.sched_phase = "-"
                continue
            try:
                run_s = max(1, int(self.e_run.get())) * 60
                rest_s = max(1, int(self.e_rest.get())) * 60
            except (ValueError, tk.TclError):
                run_s, rest_s = 3000, 600
            now = time.time()
            if self.sched_phase == "-" or now >= self.sched_until:
                if self.sched_phase == "run":
                    self._write_control("pause")
                    self.sched_phase = "rest"
                    self.sched_until = now + rest_s
                else:
                    self._write_control("run")
                    self.sched_phase = "run"
                    self.sched_until = now + run_s

    # ---- 表示更新 --------------------------------------------------------
    def _ui_state(self, st):
        if not st:
            return "idle"
        raw = st.get("state")
        if raw == "done":
            return "done"
        if self._child_alive():
            return raw or "running"
        return "stopped" if raw in ("stopped", "paused", "running") else (raw or "idle")

    def _tick(self):
        st = self._read_status() or {}
        state = self._ui_state(st)
        done = st.get("done", 0)
        total = st.get("total", 0)
        avg = st.get("avgMsPerPoint", 0) or 0
        eta = st.get("etaMs", 0) or 0
        solved = st.get("solved", 0) or 0
        last = st.get("lastStacks")
        pct = (done / total * 100) if total else 0

        self.lbl_cfg.config(text=f"{self.cfg['players']}人  /  samples {self.cfg['samples']}  /  axis {self.cfg['axis']}")
        self.lbl_eta.config(text=("完了" if state == "done" else self._fmt_eta(eta)))
        self._draw_bar(pct)
        self.lbl_bar.config(text=f"{done} / {total} 点  ({pct:.1f}%)")
        self.val_avg.config(text=(f"{avg/1000:.1f} s/点" if avg else "— s/点"))
        self.val_done.config(text=f"{done} / {total}")
        self.val_last.config(text=(",".join(str(x) for x in last) if last else "—"))
        elapsed = avg * solved if (avg and solved) else 0
        self.val_elapsed.config(text=(self._fmt_eta(elapsed) if elapsed else "—"))

        labels = {"running": "稼働中", "paused": "一時停止", "stopped": "停止（再開可）",
                  "done": "完了", "idle": "未開始"}
        colors = {"running": C["yellow"], "paused": C["cyan"], "stopped": C["steel"],
                  "done": C["cyan"], "idle": C["dim"]}
        self.lbl_state.config(text=labels.get(state, state), fg=colors.get(state, C["ink"]))

        self.b_start.config(state=("disabled" if state in ("running", "done") else "normal"))
        self.b_pause.config(state=("normal" if state == "running" else "disabled"))
        self.b_stop.config(state=("normal" if state in ("running", "paused") else "disabled"))

        # scheduler status
        if self.sched_enabled and self.sched_phase in ("run", "rest"):
            remain = max(0, int(self.sched_until - time.time()))
            ph = "稼働中" if self.sched_phase == "run" else "休憩中"
            self.lbl_sched.config(text=f"{ph} 残り約{ (remain + 59)//60 }分")
        else:
            self.lbl_sched.config(text="")

        if self.node is None:
            self._set_msg("⚠ Node が見つかりません。Node.js のインストールを確認してください。", C["red"])

        self.root.after(1500, self._tick)

    @staticmethod
    def _fmt_eta(ms):
        if not ms or ms <= 0:
            return "—"
        s = round(ms / 1000)
        h, s = divmod(s, 3600)
        m, s = divmod(s, 60)
        if h > 0:
            return f"{h}時間{m}分"
        if m > 0:
            return f"{m}分{s}秒"
        return f"{s}秒"

    def _draw_bar(self, pct):
        cv = self.bar
        cv.delete("all")
        w = cv.winfo_width() or 720
        h = int(cv["height"])
        cv.create_rectangle(0, 0, w, h, fill="#0a0d13", outline=C["line"])
        fw = int(w * min(100, max(0, pct)) / 100)
        if fw > 0:
            # 左=シアン → 右=イエロー の帯（区切りで擬似グラデ）
            steps = max(1, fw // 3)
            for i in range(steps):
                t = i / steps
                r = int(0x3a + (0xfc - 0x3a) * t)
                g = int(0xe6 + (0xee - 0xe6) * t)
                b = int(0xff + (0x0a - 0xff) * t)
                x0 = int(i / steps * fw)
                x1 = int((i + 1) / steps * fw)
                cv.create_rectangle(x0, 0, x1, h, fill=f"#{r:02x}{g:02x}{b:02x}", outline="")

    def _set_msg(self, text, color=None):
        self.lbl_msg.config(text=text, fg=(color or C["dim"]))

    # ---- UI 構築 ---------------------------------------------------------
    def _build_ui(self):
        r = self.root
        r.title("教師データ生成モニタ")
        r.configure(bg=C["bg"])
        r.geometry("760x620")
        r.minsize(680, 560)

        f_head = tk.Frame(r, bg=C["bg"])
        f_head.pack(fill="x", padx=22, pady=(20, 4))
        tk.Label(f_head, text="◤ TRAINING DATA GENERATOR", bg=C["bg"], fg=C["cyan"],
                 font=("Segoe UI Semibold", 14)).pack(anchor="w")
        self.lbl_cfg = tk.Label(r, text="", bg=C["bg"], fg=C["dim"], font=("Consolas", 10))
        self.lbl_cfg.pack(anchor="w", padx=22)

        # ETA
        tk.Label(r, text="推定残り時間 / ETA", bg=C["bg"], fg=C["dim"],
                 font=("Segoe UI", 9)).pack(anchor="w", padx=22, pady=(16, 0))
        row_eta = tk.Frame(r, bg=C["bg"])
        row_eta.pack(fill="x", padx=22)
        self.lbl_eta = tk.Label(row_eta, text="—", bg=C["bg"], fg=C["yellow"],
                                font=("Segoe UI", 40, "bold"))
        self.lbl_eta.pack(side="left")
        self.lbl_state = tk.Label(row_eta, text="—", bg=C["bg"], fg=C["dim"],
                                  font=("Segoe UI Semibold", 12))
        self.lbl_state.pack(side="right", pady=18)

        # progress bar (canvas)
        self.bar = tk.Canvas(r, height=14, bg="#0a0d13", highlightthickness=0)
        self.bar.pack(fill="x", padx=22, pady=(10, 2))
        self.lbl_bar = tk.Label(r, text="0 / 0 点 (0%)", bg=C["bg"], fg=C["dim"],
                                font=("Consolas", 10))
        self.lbl_bar.pack(anchor="w", padx=22)

        # metric cards
        f_cards = tk.Frame(r, bg=C["bg"])
        f_cards.pack(fill="x", padx=18, pady=14)
        self.val_avg = self._card(f_cards, 0, "平均")
        self.val_done = self._card(f_cards, 1, "済み点")
        self.val_last = self._card(f_cards, 2, "直近スタック")
        self.val_elapsed = self._card(f_cards, 3, "経過")
        for i in range(4):
            f_cards.columnconfigure(i, weight=1)

        # buttons
        f_btn = tk.Frame(r, bg=C["bg"])
        f_btn.pack(fill="x", padx=22, pady=(2, 10))
        self.b_start = self._btn(f_btn, "▶  開始 / 再開", self.start, C["yellow"], C["bg"])
        self.b_start.pack(side="left")
        self.b_pause = self._btn(f_btn, "Ⅱ  一時停止", self.pause, C["panel2"], C["cyan"])
        self.b_pause.pack(side="left", padx=8)
        self.b_stop = self._btn(f_btn, "■  停止（保存して終了）", self.stop, C["panel2"], C["red"])
        self.b_stop.pack(side="left")

        # settings
        f_set = tk.LabelFrame(r, text=" 設定 ", bg=C["panel"], fg=C["dim"],
                              font=("Segoe UI", 9), bd=1, relief="solid")
        f_set.pack(fill="x", padx=22, pady=(4, 8))
        f_set.configure(highlightbackground=C["line"])
        row = tk.Frame(f_set, bg=C["panel"])
        row.pack(fill="x", padx=10, pady=8)
        self.e_players = self._field(row, "人数", str(DEFAULTS["players"]), 4)
        self.e_samples = self._field(row, "samples", str(DEFAULTS["samples"]), 8)
        self.e_axis = self._field(row, "axis(bb, カンマ区切り)", DEFAULTS["axis"], 14)
        self.e_ckpt = self._field(row, "ckpt", str(DEFAULTS["ckpt"]), 4)

        # scheduler
        f_sc = tk.LabelFrame(r, text=" CPU休憩スケジュール ", bg=C["panel"], fg=C["dim"],
                             font=("Segoe UI", 9), bd=1, relief="solid")
        f_sc.pack(fill="x", padx=22, pady=(0, 8))
        row2 = tk.Frame(f_sc, bg=C["panel"])
        row2.pack(fill="x", padx=10, pady=8)
        self.v_sched = tk.IntVar(value=0)
        tk.Checkbutton(row2, text="有効", variable=self.v_sched, bg=C["panel"], fg=C["ink"],
                       selectcolor=C["panel2"], activebackground=C["panel"],
                       activeforeground=C["ink"], font=("Segoe UI", 10)).pack(side="left")
        tk.Label(row2, text=" 稼働", bg=C["panel"], fg=C["dim"]).pack(side="left")
        self.e_run = self._spin(row2, "50")
        tk.Label(row2, text="分 → 休憩", bg=C["panel"], fg=C["dim"]).pack(side="left")
        self.e_rest = self._spin(row2, "10")
        tk.Label(row2, text="分を繰り返す", bg=C["panel"], fg=C["dim"]).pack(side="left")
        tk.Button(row2, text="適用", command=self.apply_schedule, bg=C["panel2"], fg=C["ink"],
                  activebackground=C["line"], relief="flat", padx=12,
                  font=("Segoe UI", 9)).pack(side="left", padx=10)
        self.lbl_sched = tk.Label(row2, text="", bg=C["panel"], fg=C["cyan"],
                                  font=("Consolas", 9))
        self.lbl_sched.pack(side="left", padx=6)

        # message / note
        self.lbl_msg = tk.Label(r, text="", bg=C["bg"], fg=C["dim"], font=("Segoe UI", 9),
                                anchor="w", justify="left", wraplength=700)
        self.lbl_msg.pack(fill="x", padx=22, pady=(2, 0))
        tk.Label(r, text="一時停止・停止・休憩は「次の点の切れ目」（1点あたり数十秒）で反映されます。"
                         "停止すれば checkpoint に保存され、電源を切っても次回ここから再開します。",
                 bg=C["bg"], fg=C["steel"], font=("Segoe UI", 8), anchor="w",
                 justify="left", wraplength=700).pack(fill="x", padx=22, pady=(6, 12))

        self._set_msg(f"Node: {self.node or '未検出'}",
                      C["dim"] if self.node else C["red"])

    def _card(self, parent, col, label):
        cell = tk.Frame(parent, bg=C["panel"], bd=1, relief="solid",
                        highlightbackground=C["line"])
        cell.grid(row=0, column=col, sticky="nsew", padx=4)
        tk.Label(cell, text=label, bg=C["panel"], fg=C["dim"],
                 font=("Segoe UI", 8)).pack(anchor="w", padx=10, pady=(8, 0))
        val = tk.Label(cell, text="—", bg=C["panel"], fg=C["ink"],
                       font=("Segoe UI Semibold", 15))
        val.pack(anchor="w", padx=10, pady=(0, 8))
        return val

    def _btn(self, parent, text, cmd, bg, fg):
        return tk.Button(parent, text=text, command=cmd, bg=bg, fg=fg,
                         activebackground=bg, activeforeground=fg, relief="flat",
                         font=("Segoe UI Semibold", 11), padx=14, pady=8, bd=0,
                         cursor="hand2")

    def _field(self, parent, label, default, width):
        box = tk.Frame(parent, bg=C["panel"])
        box.pack(side="left", padx=(0, 14))
        tk.Label(box, text=label, bg=C["panel"], fg=C["dim"],
                 font=("Segoe UI", 8)).pack(anchor="w")
        e = tk.Entry(box, width=width, bg=C["panel2"], fg=C["ink"], insertbackground=C["ink"],
                     relief="flat", font=("Consolas", 10))
        e.insert(0, default)
        e.pack()
        return e

    def _spin(self, parent, default):
        e = tk.Entry(parent, width=5, bg=C["panel2"], fg=C["ink"], insertbackground=C["ink"],
                     relief="flat", font=("Consolas", 10), justify="center")
        e.insert(0, default)
        e.pack(side="left", padx=6)
        return e

    def _on_close(self):
        if self._child_alive():
            if not messagebox.askokcancel(
                "終了確認",
                "生成を停止して閉じますか？\n（checkpoint に保存され、次回ここから再開できます）"):
                return
            self._write_control("stop")
            time.sleep(0.3)
        self.root.destroy()


def main():
    root = tk.Tk()
    try:
        Monitor(root)
    except Exception as e:
        messagebox.showerror("起動エラー", str(e))
        raise
    root.mainloop()


if __name__ == "__main__":
    main()
