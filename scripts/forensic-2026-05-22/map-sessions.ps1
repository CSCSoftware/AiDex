# Ordnet jeden AiDex-MCP-node-Prozess seiner Claude-Session zu (ueber Parent-Kette)
$aidex = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*Repos/Aidex/build/index.js*' }

foreach ($n in $aidex) {
    Write-Host "=== AiDex node PID $($n.ProcessId) ===" -ForegroundColor Cyan
    $wsGB = [math]::Round($n.WorkingSetSize/1GB,2)
    Write-Host "  WS: $wsGB GB | Commit: $([math]::Round($n.VirtualSize/1GB,2)) GB | Start: $($n.CreationDate)"

    # Parent-Kette nach oben laufen bis claude.exe / electron / Code.exe
    $cur = $n
    $depth = 0
    while ($cur -and $depth -lt 6) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
        if (-not $parent) { break }
        $pcmd = if ($parent.CommandLine) { $parent.CommandLine.Substring(0,[math]::Min(110,$parent.CommandLine.Length)) } else { '' }
        Write-Host "    ^ PPID $($parent.ProcessId)  $($parent.Name)" -ForegroundColor DarkGray
        Write-Host "       $pcmd" -ForegroundColor DarkGray
        if ($parent.Name -match 'Code|electron|claude') {
            # Erste claude.exe gefunden -> Session-Typ einordnen
            if ($pcmd -match 'vscode|\.vscode|extensions') { Write-Host "       => VS CODE Session" -ForegroundColor Yellow }
            elseif ($pcmd -match 'AnthropicClaude|Programs\\claude|Claude\\') { Write-Host "       => DESKTOP App Session" -ForegroundColor Green }
        }
        $cur = $parent
        $depth++
    }
    Write-Host ""
}
