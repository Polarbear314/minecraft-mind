# Runs the MindBot agent forever: waits for the server, and whenever the bot
# disconnects, dies of a crash, or the server restarts, it reconnects.
# Output is shown here AND appended to logs\agent-YYYY-MM-DD.log.
$Root  = Split-Path -Parent $PSScriptRoot
$Agent = Join-Path $Root 'agent'
$Logs  = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$host.UI.RawUI.WindowTitle = 'Minecraft Mind - AGENT'

Add-Type -Namespace MM -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[MM.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null

function Wait-ForServer {
  while ($true) {
    try {
      $c = New-Object Net.Sockets.TcpClient
      $c.Connect('127.0.0.1', 25565); $c.Close(); return
    } catch {
      Write-Host 'Waiting for the server on 127.0.0.1:25565...' -ForegroundColor DarkGray
      Start-Sleep -Seconds 5
    }
  }
}

Set-Location $Agent
$delay = 15
while ($true) {
  Wait-ForServer
  $log = Join-Path $Logs ("agent-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
  $started = Get-Date
  Add-Content -Path $log -Value "[$started] --- agent start ---" -Encoding UTF8
  # cmd /c merges stderr into stdout without PowerShell 5.1 turning it into errors
  cmd /c "node src\index.js 2>&1" | ForEach-Object {
    Write-Host $_
    Add-Content -Path $log -Value $_ -Encoding UTF8
  }
  $ran = ((Get-Date) - $started).TotalSeconds
  # Back off if it keeps failing straight away (e.g. server still loading), up to 5 min
  if ($ran -lt 60) { $delay = [Math]::Min($delay * 2, 300) } else { $delay = 15 }
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Agent exited after $([int]$ran)s. Reconnecting in $delay s..." -ForegroundColor Yellow
  Start-Sleep -Seconds $delay
}
