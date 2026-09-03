@echo off
chcp 65001 >nul
rem 教師データ生成モニタ（ローカルGUI）を起動します。
rem 使い方: このファイルをダブルクリック。ブラウザが自動で開きます。
rem   引数（省略可）: [人数] [samples] [axisCsv] [ckpt] [port]
rem   既定: 5人 / samples 40000 / axis 2,8,14,20,25 / ckpt 10 / port 4577
cd /d "%~dp0packages\solver"
echo.
echo   教師データ生成モニタを起動しています...
echo   （このウィンドウは開いたままにしてください。閉じると計算も止まります）
echo.
node --import tsx scripts/genDashboard.ts %*
echo.
echo   モニタが終了しました。
pause
