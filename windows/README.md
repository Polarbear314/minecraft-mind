# Running the terrarium on Windows (unattended)

A Minecraft 1.21.4 dedicated server holds a 128x128 "terrarium" world around a
village, and the agent plays in it around the clock. Both run in their own
windows and restart themselves if they crash or disconnect. While either window
is open the PC won't go to sleep (the screen still can).

## 1. Install prerequisites (once)

In PowerShell:

```powershell
winget install Microsoft.OpenJDK.21
winget install OpenJS.NodeJS.LTS
winget install Git.Git
irm https://claude.ai/install.ps1 | iex
```

Close and reopen PowerShell, then run `claude` once and log in with your Claude account.

## 2. Setup (once)

Double-click `windows\setup.bat`. It downloads the 1.21.4 `server.jar`, asks you
to accept the Minecraft EULA, writes the server settings, creates a fresh
`Agent Brain` vault from `vault-template`, installs the agent's packages, writes
`agent\.env`, and runs `npm run sim` as a check.

## 3. Build the terrarium (once per new world)

Double-click `start-server.bat`. Wait for `Done (...)! For help, type "help"`,
then type these into that window, one at a time:

```
locate structure #minecraft:village
```

It replies with `The nearest #minecraft:village is at [X, ~, Z]`. Use those numbers:

```
setworldspawn X 100 Z
worldborder center X Z
worldborder set 128
gamerule doInsomnia false
```

Optional choices:

- `gamerule mobGriefing false`: creepers can't blow up the village. Side effect: farmer villagers also stop harvesting crops.
- `gamerule keepInventory true`: the bot keeps its items when it dies.

Leave the server window open.

## 4. Run it

- First time: the server is already open, so double-click `start-agent.bat`.
- Every time after: double-click `start-all.bat`, which opens both windows.

Ways to watch:

- **Everything in one tab: http://localhost:3008** — the live brain (each region
  firing), the bot's-eye view, its stream of thought, and an EEG of the last
  minute. `start-all.bat` opens it for you; `start-brain.bat` starts it alone.
- The bot's-eye view on its own at http://localhost:3007
- Your own game client: join `localhost` on 1.21.4
- The `Agent Brain` folder in Obsidian
- Logs in `logs\agent-YYYY-MM-DD.log`

To stop: close the AGENT window, then type `stop` in the SERVER window and close it.

## Before you leave it running

- Every consultation uses your Claude plan's usage. `LLM_MIN_INTERVAL_MS` in
  `agent\.env` controls how often (30s by default). When you hit a limit, the
  bot keeps going on its rules until usage resets.
- Windows Update can restart the PC overnight. Set "active hours" in Windows
  Update settings, or pause updates while it runs.
- To start over with a new world, stop the server and rename `server\terrarium`.
  To give the bot a fresh brain, rename `Agent Brain`, then rerun `setup.bat`.
