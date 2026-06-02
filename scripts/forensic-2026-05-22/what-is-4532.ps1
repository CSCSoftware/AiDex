$p = Get-CimInstance Win32_Process -Filter "ProcessId=4532" -ErrorAction SilentlyContinue
if ($p) {
    Write-Host ("PID 4532: " + $p.Name)
    Write-Host ("  Cmd: " + $p.CommandLine)
    Write-Host ("  Parent: " + $p.ParentProcessId)
    $gp = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($gp) { Write-Host ("  Grandparent " + $gp.ProcessId + ": " + $gp.Name) }
} else {
    Write-Host "PID 4532 not found"
}
