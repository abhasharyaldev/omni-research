$ErrorActionPreference = "Continue"

$Ports = @(3000, 4000, 5498)
$Ids = @()

foreach ($Port in $Ports) {
  $Lines = netstat -ano | Select-String ":$Port"
  foreach ($Line in $Lines) {
    $Parts = ($Line.ToString() -split "\s+") | Where-Object { $_ }
    $Last = $Parts[-1]
    if ($Last -match "^\d+$" -and $Last -ne "0") {
      $Ids += [int]$Last
    }
  }
}

$Ids = $Ids | Sort-Object -Unique
if ($Ids.Count -eq 0) {
  Write-Host "No OmniResearch ports are currently owned."
  exit 0
}

foreach ($Id in $Ids) {
  try {
    $Process = Get-Process -Id $Id -ErrorAction Stop
    Write-Host "Stopping PID $Id ($($Process.ProcessName))"
    Stop-Process -Id $Id -Force
  } catch {
    Write-Host "Could not stop PID ${Id}: $($_.Exception.Message)"
  }
}

Write-Host "Done."
