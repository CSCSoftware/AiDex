# Kill ALL demo-dashboard.mjs node processes (clean up orphans left by TaskStop)
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*demo-dashboard.mjs*' }

if (-not $procs) {
    Write-Host "No demo processes to kill."
    return
}
foreach ($p in $procs) {
    Write-Host ("Killing demo PID " + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 400
$left = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*demo-dashboard.mjs*' }
$n = @($left).Count
Write-Host ("Remaining demo processes: " + $n)
