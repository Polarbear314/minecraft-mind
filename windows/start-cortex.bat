@echo off
rem Starts the upper layers' models (Make 4B, Shelter 3B, Gather 2B) in their own
rem window: agent\src\cortex\layer_service.py on http://127.0.0.1:3010.
rem The agent works without it (the hand-written layers act); with it, the
rem model layers shadow or act (UPPER_LAYERS in agent\.env). Loading takes a minute.
start "Minecraft Mind - CORTEX" cmd /k "cd /d "%~dp0..\agent" && .venv-laya\Scripts\python src\cortex\layer_service.py"
