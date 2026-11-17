@echo off
rem Opens the live brain view (http://localhost:3008) in its own window.
rem Read-only: it only reads the agent's logs and vault, so it can be
rem started, stopped or restarted at any time.
start "Minecraft Mind - BRAIN" cmd /k "cd /d "%~dp0..\agent" && node src\tools\brainView.js"
