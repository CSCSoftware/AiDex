$c = Get-NetTCPConnection -LocalPort 3335 -State Listen -ErrorAction SilentlyContinue
if ($c) {
    $owner = $c.OwningProcess
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
    Write-Host "Port 3335 LISTEN by PID $owner"
    if ($p) {
        Write-Host ("  Cmd: " + $p.CommandLine)
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($parent) { Write-Host ("  Parent PID " + $parent.ProcessId + ": " + $parent.Name) }
    }
} else {
    Write-Host "Port 3335 is free"
}

Write-Host ""
Write-Host "--- Probe POST /panel ---"
try {
    $r = Invoke-WebRequest -Uri "http://localhost:3335/panel" -Method POST -ContentType "application/json" -Body '{"id":"__probe","type":"label","value":"hi"}' -UseBasicParsing -ErrorAction Stop
    Write-Host ("  /panel responded: HTTP " + $r.StatusCode + " " + $r.Content)
} catch {
    $resp = $_.Exception.Response
    if ($resp) {
        $code = [int]$resp.StatusCode
        if ($code -eq 404) { $note = "NOT FOUND (old build, no /panel route)" } else { $note = "reachable" }
        Write-Host ("  /panel HTTP " + $code + " - " + $note)
    } else {
        Write-Host ("  /panel error: " + $_.Exception.Message)
    }
}
