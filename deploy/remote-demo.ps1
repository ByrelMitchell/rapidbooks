# Share a RapidBooks demo over the internet from a Windows PC (see docs/REMOTE-DEMO.md).
#
#   powershell -ExecutionPolicy Bypass -File deploy\remote-demo.ps1 [-DataDir D:\rapidbooks-demo] [-Port 3002]
#
# Runs the server on 127.0.0.1 with the database in -DataDir, opens a Cloudflare quick
# tunnel to it, and prints the public https://….trycloudflare.com address. Keeps the PC
# awake while it runs. Ctrl+C stops the server and the tunnel.

param(
  [string]$DataDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'rapidbooks-demo'),
  [int]$Port = 3002
)

$ErrorActionPreference = 'Stop'
$app = Split-Path $PSScriptRoot -Parent
$db = Join-Path $DataDir 'rapidbooks.db'

# Refuse to expose anything unless the pieces are in place.
if (-not (Test-Path $db)) { throw "No database at $db. Copy the demo database there first (see docs/REMOTE-DEMO.md)." }
if (-not (Test-Path (Join-Path $DataDir 'auth.json'))) { throw "No password set for $DataDir (auth.json missing). The demo would be open to anyone; set one first." }
if (-not (Test-Path (Join-Path $app 'packages\web\dist\index.html'))) { throw 'The web app is not built. Run: npm run build' }

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) {
  $cloudflared = @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $cloudflared) { throw 'cloudflared not found. Install it: winget install Cloudflare.cloudflared' }

$env:RAPIDBOOKS_DB = $db
$env:HOST = '127.0.0.1'
$env:PORT = "$Port"
$env:RAPIDBOOKS_BACKUP_TIME = 'off'

# Keep the PC awake while this runs (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED).
Add-Type -Namespace RapidBooksDemo -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][RapidBooksDemo.Power]::SetThreadExecutionState([uint32]2147483651)

$log = Join-Path $DataDir 'tunnel.log'
Remove-Item $log -ErrorAction SilentlyContinue
$server = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $app -NoNewWindow -PassThru
$tunnel = Start-Process -FilePath $cloudflared -ArgumentList "tunnel --no-autoupdate --url http://127.0.0.1:$Port" -NoNewWindow -PassThru -RedirectStandardError $log

try {
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep 1
    if (Test-Path $log) {
      $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value }
    }
  }
  if (-not $url) { throw "The tunnel did not report an address; see $log" }
  Write-Host ''
  Write-Host "  Demo URL:  $url" -ForegroundColor Green
  $pwFile = Join-Path $DataDir 'PASSWORD.txt'
  if (Test-Path $pwFile) { Write-Host "  Password:  $(Get-Content $pwFile -TotalCount 1)" -ForegroundColor Green }
  Write-Host '  Keep this window open. Ctrl+C stops the demo.'
  Write-Host ''
  Wait-Process -Id $tunnel.Id
} finally {
  foreach ($p in $tunnel, $server) { if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F | Out-Null } }
  [void][RapidBooksDemo.Power]::SetThreadExecutionState([uint32]2147483648)
}
