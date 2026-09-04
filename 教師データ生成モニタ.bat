@echo off
chcp 65001 >nul
rem 教師データ生成モニタ（ネイティブGUI）を起動します。
rem 通常は「教師データ生成モニタ.pyw」をダブルクリックしてください（黒い窓なしでアプリが開きます）。
rem この .bat は、もし .pyw が開かない場合に「原因を表示する」ための予備の起動方法です。
cd /d "%~dp0packages\solver\scripts"
echo.
echo   教師データ生成モニタ（GUI）を起動しています...
echo.
py -3 gen_monitor_gui.py
if errorlevel 9009 python gen_monitor_gui.py
echo.
echo   ウィンドウを閉じました。（このコマンド窓は閉じて構いません）
pause
