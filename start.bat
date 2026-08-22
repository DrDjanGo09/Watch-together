@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==^> Checking for Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org (LTS version) and re-run this script.
  pause
  exit /b 1
)

echo ==^> Installing client dependencies...
cd client
call npm install --no-fund --no-audit
if errorlevel 1 goto :error

echo ==^> Building client for production...
if exist .env del .env
call npm run build
if errorlevel 1 goto :error
cd ..

echo ==^> Installing server dependencies...
cd server
call npm install --no-fund --no-audit
if errorlevel 1 goto :error
cd ..

echo ==^> Starting server on http://localhost:4000 ...
start "Watch Together Server" /min cmd /c "cd server && npm start > ..\server.log 2>&1"

echo Waiting for server to start...
timeout /t 4 /nobreak >nul

echo ==^> Checking for cloudflared...
set CLOUDFLARED_CMD=
where cloudflared >nul 2>nul
if not errorlevel 1 (
  set CLOUDFLARED_CMD=cloudflared
) else (
  if exist cloudflared.exe (
    set CLOUDFLARED_CMD=cloudflared.exe
  ) else (
    echo Downloading cloudflared...
    curl -sL -o cloudflared.exe "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    set CLOUDFLARED_CMD=cloudflared.exe
  )
)

echo.
echo ==^> Starting Cloudflare Tunnel — your public link will appear below.
echo     Send the https://....trycloudflare.com link to your relatives.
echo     Close this window (or press Ctrl+C) to stop the tunnel.
echo     Note: the server is running in a separate minimized window titled
echo     "Watch Together Server" — close that window too when you're done.
echo.
%CLOUDFLARED_CMD% tunnel --url http://localhost:4000

goto :eof

:error
echo.
echo Something went wrong. See the messages above for details.
pause
exit /b 1
