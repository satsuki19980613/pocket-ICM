@echo off
chcp 65001 >nul
rem 教師データ生成モニタ（Python ローカルアプリ）を起動します。
rem 使い方: このファイルをダブルクリック。ブラウザが自動で開きます。
rem   引数（省略可）: [人数] [samples] [axisCsv] [ckpt] [port]
rem   既定: 5人 / samples 40000 / axis 2,8,14,20,25 / ckpt 10 / port 4577
cd /d "%~dp0packages\solver"
echo.
echo   教師データ生成モニタ（Python）を起動しています...
echo   （このウィンドウは開いたままにしてください）
echo.
py -3 scripts\gen_monitor.py %*
if errorlevel 9009 python scripts\gen_monitor.py %*
echo.
echo   モニタが終了しました。
pause
