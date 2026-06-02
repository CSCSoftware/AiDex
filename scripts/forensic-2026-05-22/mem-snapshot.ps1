# Memory-Snapshot aller node.exe-Prozesse (E2E-Smoke-Test v2.1.1)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Select-Object ProcessId,
        @{N='WS_MB';E={[math]::Round($_.WorkingSetSize/1MB,1)}},
        @{N='Commit_MB';E={[math]::Round($_.VirtualSize/1MB,1)}},
        @{N='Cmd';E={ if ($_.CommandLine) { $_.CommandLine.Substring(0, [math]::Min(90,$_.CommandLine.Length)) } else { '' } }} |
    Sort-Object WS_MB -Descending |
    Format-Table -AutoSize -Wrap
