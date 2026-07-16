$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root ".local-logs"
$RunStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ApiOut = Join-Path $LogDir "api-$RunStamp.out.log"
$ApiErr = Join-Path $LogDir "api-$RunStamp.err.log"
$WorkerOut = Join-Path $LogDir "worker-$RunStamp.out.log"
$WorkerErr = Join-Path $LogDir "worker-$RunStamp.err.log"
$WebOut = Join-Path $LogDir "web-$RunStamp.out.log"
$WebErr = Join-Path $LogDir "web-$RunStamp.err.log"
$ApiCwd = Join-Path $Root "apps\api"
$WorkerCwd = Join-Path $Root "apps\worker"
$WebCwd = Join-Path $Root "apps\web"
$Tsx = Join-Path $Root "node_modules\.pnpm\tsx@4.23.0\node_modules\tsx\dist\cli.mjs"
$Next = Join-Path $Root "apps\web\node_modules\next\dist\bin\next"
$Node = (Get-Command node -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Some Codex-launched shells can contain both Path and PATH, which breaks
# Start-Process. Normalizing it is harmless in regular PowerShell too.
$SavedPath = $env:Path
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $SavedPath, "Process")

foreach ($Path in @($Tsx, $Next)) {
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "Missing dependency: $Path" -ForegroundColor Red
    Write-Host "Run this from the repo folder first: pnpm install"
    pause
    exit 1
  }
}

foreach ($LogPath in @($ApiOut, $ApiErr, $WorkerOut, $WorkerErr, $WebOut, $WebErr)) {
  New-Item -ItemType File -Force -Path $LogPath | Out-Null
}

Write-Host "Starting OmniResearch API..."
Start-Process -FilePath $Node `
  -ArgumentList @($Tsx, "watch", "src/index.ts") `
  -WorkingDirectory $ApiCwd `
  -RedirectStandardOutput $ApiOut `
  -RedirectStandardError $ApiErr `
  -WindowStyle Minimized

Start-Sleep -Seconds 3

Write-Host "Starting OmniResearch Worker..."
Start-Process -FilePath $Node `
  -ArgumentList @($Tsx, "watch", "src/index.ts") `
  -WorkingDirectory $WorkerCwd `
  -RedirectStandardOutput $WorkerOut `
  -RedirectStandardError $WorkerErr `
  -WindowStyle Minimized

Start-Sleep -Seconds 2

Write-Host "Starting OmniResearch Web..."
Start-Process -FilePath $Node `
  -ArgumentList @($Next, "dev", "-p", "3000") `
  -WorkingDirectory $WebCwd `
  -RedirectStandardOutput $WebOut `
  -RedirectStandardError $WebErr `
  -WindowStyle Minimized

$Url = "http://127.0.0.1:3000"
$ApiUrl = "http://127.0.0.1:4000/api/health"
$Ready = $false

Write-Host "Waiting for OmniResearch..."
for ($i = 1; $i -le 20; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
    Invoke-WebRequest -Uri $ApiUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
    $Ready = $true
    break
  } catch {
    Write-Host "." -NoNewline
  }
}

Write-Host ""
if ($Ready) {
  Write-Host "OmniResearch is running:" -ForegroundColor Green
  Write-Host $Url
  Start-Process $Url
} else {
  Write-Host "OmniResearch did not become reachable yet." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Web log:"
  Get-Content -LiteralPath $WebOut -Tail 30 -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $WebErr -Tail 30 -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "API log:"
  Get-Content -LiteralPath $ApiOut -Tail 30 -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $ApiErr -Tail 30 -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "Worker log:"
  Get-Content -LiteralPath $WorkerOut -Tail 30 -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $WorkerErr -Tail 30 -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Logs are in: $LogDir"
Write-Host "If it opened, keep using: $Url"
pause
