@echo off
rem Double-click to build the Windows installer: dist\AI-Chat-Manager-Setup-<version>.exe
rem Needs Node.js (https://nodejs.org). The first build downloads about 150 MB.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Opening its download page: install the LTS version, then double-click this file again.
  start https://nodejs.org/
  pause
  exit /b 1
)
echo Getting what the build needs (first time only)...
call npm install --no-audit --no-fund || goto :failed
echo Building the installer...
call npm run dist:win || goto :failed
echo.
echo Done: the installer is in the dist folder.
start "" "%~dp0dist"
pause
exit /b 0
:failed
echo.
echo The build failed. The messages above say why.
pause
exit /b 1
