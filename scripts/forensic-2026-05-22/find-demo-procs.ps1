# Find all running demo-dashboard.mjs node processes
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*demo-dashboard.mjs*' }

if (-not $procs) {
    Write-Host "No demo-dashboard.mjs process running."
} else {
    $count = @($procs).Count
    Write-Host "Found $count demo-dashboard.mjs process(es):"
    foreach ($p in $procs) {
        Write-Host ("  PID " + $p.ProcessId + "  started " + $p.CreationDate + "  parent " + $p.ParentProcessId)
        Write-Host ("    " + $p.CommandLine)
    }
}
