@echo off
cd /d "%~dp0.."
if not exist "config.json" (
  node "src\setup.js"
  if errorlevel 1 goto finish
  if not exist "config.json" goto finish
)
node "src\runner.js"
:finish
echo.
echo Price Watch has stopped. Press any key to close this window.
pause >nul
