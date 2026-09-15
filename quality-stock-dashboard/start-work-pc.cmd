@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js first. See WORK-PC-SETUP.md.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Run the installation command in WORK-PC-SETUP.md first.
  pause
  exit /b 1
)
call npx --yes pnpm@11.19.0 run dev:pc
pause
