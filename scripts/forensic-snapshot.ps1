$ErrorActionPreference = 'Continue'
$outDir = "Q:\develop\Repos\Aidex\scripts\forensic-2026-05-22"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$log = Join-Path $outDir 'snapshot.log'
function W($msg) { $line = (Get-Date -Format 'HH:mm:ss.fff') + '  ' + $msg; $line | Tee-Object -FilePath $log -Append }

W "=== Forensic snapshot for PID 6560 (AiDex MCP in UcHome) ==="

# 1. Process memory snapshot (3 samples, 2s apart, to see growth)
W ""
W "--- Memory samples (3x, 2s apart) ---"
for ($i=1; $i -le 3; $i++) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=6560" -ErrorAction SilentlyContinue
    if (-not $p) { W "PID 6560 gone"; break }
    $line = "{0,1}  WS={1,7:N1} MB  Private={2,8:N1} MB  Virtual={3,6:N2} GB  HandleCount={4}  ThreadCount={5}" -f `
        $i,
        ($p.WorkingSetSize/1MB),
        ($p.PrivatePageCount/1MB),
        ($p.VirtualSize/1GB),
        $p.HandleCount,
        $p.ThreadCount
    W $line
    Start-Sleep -Seconds 2
}

# 2. Loghub /health endpoint
W ""
W "--- LogHub /health (port 3335) ---"
try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:3335/health' -TimeoutSec 5
    $h | ConvertTo-Json -Depth 5 | Tee-Object -FilePath (Join-Path $outDir 'loghub-health.json')
    W ($h | ConvertTo-Json -Compress)
} catch {
    W "LogHub /health unreachable: $($_.Exception.Message)"
}

# 3. logs.db size + row counts (UcHome project)
W ""
W "--- UcHome logs.db ---"
$logsDb = "Q:\develop\Repos\MCP-Servers\UcHome\.aidex\logs.db"
if (Test-Path $logsDb) {
    $f = Get-Item $logsDb
    W ("logs.db size: {0:N1} MB  (last modified {1})" -f ($f.Length/1MB), $f.LastWriteTime)
    Copy-Item $logsDb (Join-Path $outDir 'logs.db.copy') -ErrorAction SilentlyContinue
    $wal = "$logsDb-wal"; if (Test-Path $wal) {
        $wf = Get-Item $wal
        W ("logs.db-wal size: {0:N1} MB" -f ($wf.Length/1MB))
        Copy-Item $wal (Join-Path $outDir 'logs.db-wal.copy') -ErrorAction SilentlyContinue
    }
} else {
    W "logs.db not found at $logsDb"
}

# 4. TCP connections snapshot
W ""
W "--- TCP connections of PID 6560 ---"
Get-NetTCPConnection -OwningProcess 6560 -ErrorAction SilentlyContinue |
    Select-Object State,LocalAddress,LocalPort,RemoteAddress,RemotePort |
    Format-Table -AutoSize | Out-String | Tee-Object -FilePath (Join-Path $outDir 'tcp-connections.txt')

# 5. Open file handles count (via handle.exe if available, else skip)
W ""
W "--- File handle count ---"
$p2 = Get-Process -Id 6560 -ErrorAction SilentlyContinue
if ($p2) { W ("Handles: $($p2.HandleCount)  Threads: $($p2.Threads.Count)  GdiHandles: n/a") }

# 6. System memory pressure
W ""
W "--- System memory pressure ---"
$os = Get-CimInstance Win32_OperatingSystem
W ("Total RAM:   {0,8:N1} GB" -f ($os.TotalVisibleMemorySize/1MB))
W ("Free RAM:    {0,8:N1} GB" -f ($os.FreePhysicalMemory/1MB))
W ("Total Swap:  {0,8:N1} GB" -f ($os.TotalVirtualMemorySize/1MB))
W ("Free Swap:   {0,8:N1} GB" -f ($os.FreeVirtualMemory/1MB))

W ""
W ("=== Done. Output in: $outDir ===")
