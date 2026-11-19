@echo off
rem Laya's day-time triage on its own (start-all.bat also starts it): flags the
rem moments worth a lesson tonight into logs\triage-<date>.jsonl. Runs on the CPU.
start "Minecraft Mind - TRIAGE" /min cmd /k "cd /d "%~dp0..\agent" && .venv-laya\Scripts\python src\cortex\triage.py"
