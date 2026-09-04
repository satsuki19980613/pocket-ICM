# -*- coding: utf-8 -*-
# 教師データ生成モニタ（ネイティブGUI）。このファイルをダブルクリックで開きます。
# .pyw は pythonw に関連付けられており、黒いウィンドウを出さずにアプリ窓が立ち上がります。
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "packages", "solver", "scripts"))

try:
    import gen_monitor_gui
    gen_monitor_gui.main()
except Exception as exc:
    # GUI 起動に失敗した場合でも、原因が分かるようダイアログを出す
    try:
        import tkinter as tk
        from tkinter import messagebox
        _r = tk.Tk()
        _r.withdraw()
        messagebox.showerror("起動エラー", f"{type(exc).__name__}: {exc}")
    except Exception:
        raise
