# One-time setup for running Minecraft Mind unattended on Windows.
# Run from this folder:  double-click setup.bat  (or: powershell -ExecutionPolicy Bypass -File setup.ps1)
# Safe to re-run: it only creates what's missing.
$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot          # ...\minecraft-mind
$Agent  = Join-Path $Root 'agent'
$Server = Join-Path $Root 'server'
$Vault  = Join-Path $Root 'Agent Brain'
$McVersion = '1.21.4'                               # mineflayer has no 26.x support

function Say($msg, $color = 'Cyan') { Write-Host "`n== $msg" -ForegroundColor $color }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# ---------------------------------------------------------------- prerequisites
Say 'Checking prerequisites'
$missing = @()
if (-not (Have 'java'))   { $missing += '  winget install Microsoft.OpenJDK.21' }
if (-not (Have 'node'))   { $missing += '  winget install OpenJS.NodeJS.LTS' }
if (-not (Have 'git'))    { $missing += '  winget install Git.Git          (Claude Code needs Git Bash on Windows)' }
if (-not (Have 'claude')) { $missing += '  irm https://claude.ai/install.ps1 | iex   (then run: claude   once, to log in)' }
if ($missing.Count) {
  Write-Host 'Install these first (in PowerShell), then CLOSE and reopen the window and run setup again:' -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
  exit 1
}
# cmd /c: Windows PowerShell 5.1 turns redirected native stderr into errors
$javaVer = (cmd /c 'java -version 2>&1' | Select-Object -First 1)
Write-Host "java:   $javaVer"
Write-Host "node:   $(& node --version)"
Write-Host "claude: $(cmd /c 'claude --version 2>nul')"
if ($javaVer -notmatch '"(2[1-9]|[3-9]\d)') {
  Write-Host 'Minecraft 1.21.4 needs Java 21+.  Run: winget install Microsoft.OpenJDK.21' -ForegroundColor Yellow
  exit 1
}

# ---------------------------------------------------------------- server.jar
Say "Minecraft $McVersion server"
New-Item -ItemType Directory -Force -Path $Server | Out-Null
$jar = Join-Path $Server 'server.jar'
if (-not (Test-Path $jar)) {
  $manifest = Invoke-RestMethod 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
  $entry = $manifest.versions | Where-Object { $_.id -eq $McVersion }
  $meta = Invoke-RestMethod $entry.url
  Write-Host "Downloading server.jar ($McVersion)..."
  Invoke-WebRequest $meta.downloads.server.url -OutFile $jar -UseBasicParsing
} else { Write-Host 'server.jar already there.' }

$eula = Join-Path $Server 'eula.txt'
if (-not ((Test-Path $eula) -and (Select-String -Path $eula -Pattern 'eula=true' -Quiet))) {
  Write-Host 'Running a Minecraft server requires agreeing to the Minecraft EULA: https://aka.ms/MinecraftEULA'
  $ans = Read-Host 'Do you agree to the EULA? (y/n)'
  if ($ans -notmatch '^[yY]') { Write-Host 'Stopping: the server cannot run without the EULA.' -ForegroundColor Yellow; exit 1 }
  Set-Content -Path $eula -Value 'eula=true' -Encoding ASCII
}

$props = Join-Path $Server 'server.properties'
if (-not (Test-Path $props)) {
  Copy-Item (Join-Path $PSScriptRoot 'server.properties') $props
  Write-Host 'Wrote server.properties (terrarium settings).'
}

# ---------------------------------------------------------------- vault
Say 'Agent Brain vault'
if (-not (Test-Path $Vault)) {
  Copy-Item -Recurse (Join-Path $Root 'vault-template') $Vault
  Write-Host "Fresh brain created at: $Vault"
} else { Write-Host 'Vault already exists, leaving it alone.' }

# ---------------------------------------------------------------- agent
Say 'Agent dependencies (npm install)'
Push-Location $Agent
try {
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    # 'canvas' is only for prismarine-viewer's headless renderer, which the bot
    # doesn't use; if its native build fails, install without build scripts.
    Write-Host 'npm install failed; retrying without native build scripts...' -ForegroundColor Yellow
    & npm install --no-audit --no-fund --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  }

  $envFile = Join-Path $Agent '.env'
  if (-not (Test-Path $envFile)) {
    $tpl = Get-Content (Join-Path $PSScriptRoot 'agent.env.windows') -Raw
    $tpl = $tpl.Replace('__VAULT_PATH__', $Vault)
    [IO.File]::WriteAllText($envFile, $tpl)   # no BOM: dotenv must read line 1 cleanly
    Write-Host "Wrote agent\.env (VAULT_PATH = $Vault)."
  } else { Write-Host 'agent\.env already exists, leaving it alone.' }

  Say 'Mock-world check (npm run sim)'
  & npm run sim
  if ($LASTEXITCODE -ne 0) { throw 'npm run sim failed: see output above' }
} finally { Pop-Location }

Say 'Setup done.' 'Green'
Write-Host 'Next: double-click start-server.bat, set up the terrarium (see windows\README.md), then start-all.bat.'
