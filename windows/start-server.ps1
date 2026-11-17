# Runs the terrarium's Minecraft 1.21.4 server, restarting it if it ever stops.
# This window IS the server console: you can type commands here (no slash needed).
# To stop for good: type  stop  and then press Ctrl+C during the 10-second countdown.
$Root   = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root 'server'
$host.UI.RawUI.WindowTitle = 'Minecraft Mind - SERVER'

# Keep the PC awake (but let the screen sleep) while this window is open.
Add-Type -Namespace MM -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[MM.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED

Set-Location $Server
while ($true) {
  Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting server..." -ForegroundColor Cyan
  & java -Xms1G -Xmx3G -jar server.jar nogui
  Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Server stopped (exit $LASTEXITCODE). Restarting in 10s - Ctrl+C to quit." -ForegroundColor Yellow
  Start-Sleep -Seconds 10
}
