# Starts Magetsi and the ngrok public link, each in its own window.
# Run by double-clicking start-public.cmd, or:  powershell -ExecutionPolicy Bypass -File start-public.ps1
# Optional secrets (AT_USERNAME, AT_API_KEY, ...) go in a file named .env next to this script,
# one KEY=VALUE per line. .env is git-ignored.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$publicUrl = 'https://yearling-amount-craving.ngrok-free.dev'

# Defaults; .env can override them.
$env:TRUST_PROXY = '1'
$env:VAPID_SUBJECT = 'mailto:john.chola.mulenga@cs.unza.zm'

$envFile = Join-Path $here '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    $line = $line.Trim()
    if ($line -eq '' -or $line.StartsWith('#') -or -not $line.Contains('=')) { continue }
    $key, $value = $line.Split('=', 2)
    Set-Item -Path "Env:$($key.Trim())" -Value $value.Trim().Trim('"')
  }
  Write-Host 'Loaded settings from .env'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not installed or not on PATH.' }
if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) { throw 'ngrok is not installed or not on PATH.' }

$port = if ($env:PORT) { $env:PORT } else { '3000' }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "Something is already using port $port (Magetsi may already be running). Not starting a second copy."
} else {
  # Child windows inherit the environment variables set above.
  Start-Process powershell -WorkingDirectory $here -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Magetsi'; npm start"
  Start-Sleep -Seconds 2
}

if (Get-Process ngrok -ErrorAction SilentlyContinue) {
  Write-Host 'ngrok is already running. Not starting a second copy.'
} else {
  Start-Process powershell -WorkingDirectory $here -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'ngrok'; ngrok http $port --url $publicUrl"
}

Write-Host "Magetsi: http://localhost:$port   Public: $publicUrl"
Write-Host 'To stop: press Ctrl+C in each window.'
