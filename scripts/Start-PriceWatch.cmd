@echo off
cd /d "%~dp0.."
set "PRICE_WATCH_NODE=%~dp0..\runtime\node.exe"
if not exist "%PRICE_WATCH_NODE%" (
  echo Setting up the Price Watch runtime. This requires an internet connection.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-NodeRuntime.ps1" -TargetDirectory "%~dp0..\runtime"
  if errorlevel 1 goto finish
)
if /I "%~1"=="--setup" (
  "%PRICE_WATCH_NODE%" "src\setup.js"
  goto finish
)
if not exist "config.json" (
  "%PRICE_WATCH_NODE%" "src\setup.js"
  if errorlevel 1 goto finish
  if not exist "config.json" goto finish
)
"%PRICE_WATCH_NODE%" "src\runner.js"
:finish
echo.
echo Price Watch has stopped. Press any key to close this window.
pause >nul
