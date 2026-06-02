param([int]$Port = 3336)
try {
    $r = Invoke-WebRequest -Uri ("http://localhost:$Port/panel") -Method POST -ContentType "application/json" -Body '{"id":"__probe","type":"label","value":"hi","group":"_probe"}' -UseBasicParsing -ErrorAction Stop
    Write-Host ("OK  HTTP " + $r.StatusCode + "  " + $r.Content)
} catch {
    $resp = $_.Exception.Response
    if ($resp) { Write-Host ("HTTP " + [int]$resp.StatusCode + " (404 = old build, no /panel)") }
    else { Write-Host ("ERR " + $_.Exception.Message) }
}
