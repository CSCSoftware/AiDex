$pid_target = 6560
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid_target" -ErrorAction SilentlyContinue
if (-not $p) { Write-Host "PID $pid_target does not exist anymore."; exit 0 }

Write-Host "=== Process $pid_target ===" -ForegroundColor Cyan
$p | Select-Object ProcessId,ParentProcessId,Name,
    @{N='WorkingSetMB';E={[math]::Round($_.WorkingSetSize/1MB,1)}},
    @{N='PrivateMB';   E={[math]::Round($_.PrivatePageCount/1MB,1)}},
    @{N='VirtualGB';   E={[math]::Round($_.VirtualSize/1GB,2)}},
    @{N='PageFileMB';  E={[math]::Round($_.PageFileUsage/1KB,1)}},
    CreationDate, CommandLine |
    Format-List

Write-Host "`n=== Parent chain ===" -ForegroundColor Cyan
$cur = $p
while ($cur -and $cur.ParentProcessId -gt 0) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
    if (-not $parent) { break }
    "{0,6}  {1,-20}  {2}" -f $parent.ProcessId, $parent.Name, $parent.CommandLine | Write-Host
    if ($parent.ProcessId -eq $cur.ParentProcessId -and $cur.ParentProcessId -eq 4) { break }
    $cur = $parent
}

Write-Host "`n=== Child processes of $pid_target ===" -ForegroundColor Cyan
$kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$pid_target" -ErrorAction SilentlyContinue
if ($kids) {
    $kids | Select-Object ProcessId,Name,
        @{N='WorkingSetMB';E={[math]::Round($_.WorkingSetSize/1MB,1)}},
        CommandLine |
        Format-Table -AutoSize -Wrap
} else {
    Write-Host "(none)"
}

Write-Host "`n=== Listening ports owned by $pid_target ===" -ForegroundColor Cyan
Get-NetTCPConnection -OwningProcess $pid_target -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort | Format-Table -AutoSize

Write-Host "`n=== Established connections to/from $pid_target ===" -ForegroundColor Cyan
Get-NetTCPConnection -OwningProcess $pid_target -State Established -ErrorAction SilentlyContinue |
    Select-Object LocalPort,RemoteAddress,RemotePort | Format-Table -AutoSize
