# Forensik fuer den fetten AiDex-Prozess (E2E-Smoke v2.1.1)
$pid_target = 36476

Write-Host "=== Prozess-Details PID $pid_target ===" -ForegroundColor Cyan
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid_target" -ErrorAction SilentlyContinue
if (-not $p) { Write-Host "Prozess existiert nicht mehr."; exit }

$p | Select-Object ProcessId, ParentProcessId, CreationDate,
    @{N='WS_GB';E={[math]::Round($_.WorkingSetSize/1GB,2)}},
    @{N='Commit_GB';E={[math]::Round($_.VirtualSize/1GB,2)}},
    CommandLine | Format-List

Write-Host "=== Parent-Prozess ===" -ForegroundColor Cyan
$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
if ($parent) {
    $parent | Select-Object ProcessId, Name,
        @{N='Cmd';E={ if($_.CommandLine){$_.CommandLine.Substring(0,[math]::Min(120,$_.CommandLine.Length))}else{''} }} | Format-List
} else { Write-Host "Kein Parent gefunden (PPID $($p.ParentProcessId))." }

Write-Host "=== Lauscht dieser PID auf 3333/3334/3335? ===" -ForegroundColor Cyan
Get-NetTCPConnection -OwningProcess $pid_target -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 3333,3334,3335 -or $_.State -eq 'Listen' } |
    Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, State |
    Format-Table -AutoSize

Write-Host "=== Wer haengt an 3333/3335 (alle PIDs)? ===" -ForegroundColor Cyan
Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 3333,3334,3335 } |
    Select-Object LocalPort, State, OwningProcess, RemoteAddress, RemotePort |
    Sort-Object LocalPort |
    Format-Table -AutoSize
