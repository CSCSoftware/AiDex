# Fill the mic plot history with a wide negative value to test cur/min overlap.
param([int]$Port = 3335)
1..200 | ForEach-Object {
    Invoke-RestMethod -Uri ("http://localhost:$Port/panel") -Method POST -ContentType "application/json" -Body '{"id":"mic","value":-123.45}' | Out-Null
}
Write-Host "mic filled with -123.45 (widest case)"
