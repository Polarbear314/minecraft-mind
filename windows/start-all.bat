@echo off
rem Starts everything with as few windows in the way as possible:
rem   - SERVER window, visible: type terrarium commands here (stop, worldborder ...)
rem   - AGENT window, minimized: its thoughts already show in the brain page
rem   - BRAIN view, minimized: the page's small read-only server
rem   - your browser on http://localhost:3008: the brain, the bot's-eye view,
rem     its thoughts and the live firing, all in one tab
rem The agent waits for the server by itself.
call "%~dp0start-server.bat"
rem The upper layers' models (Make/Shelter/Gather), minimized; the agent works without them.
start "Minecraft Mind - CORTEX" /min cmd /k "cd /d "%~dp0..\agent" && .venv-laya\Scripts\python src\cortex\layer_service.py"
start "Minecraft Mind - AGENT" /min powershell -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-agent.ps1"
start "Minecraft Mind - BRAIN" /min cmd /k "cd /d "%~dp0..\agent" && node src\tools\brainView.js"
timeout /t 5 /nobreak >nul
start "" http://localhost:3008
