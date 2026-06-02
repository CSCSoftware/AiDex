foreach ($port in 3333, 3334, 3335, 3336) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) {
        $owner = ($c | Select-Object -First 1).OwningProcess
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
        $parent = $null
        if ($p) { $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue }
        $pname = if ($parent) { $parent.Name } else { "?" }
        Write-Host ("Port $port  LISTEN  PID $owner  parent=$pname")
    } else {
        Write-Host ("Port $port  FREE")
    }
}
