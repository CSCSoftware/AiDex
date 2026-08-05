<#
.SYNOPSIS
    Handle-Zaehler eines Prozesses im Sekundentakt mitschreiben (CSV).

.DESCRIPTION
    Messwerkzeug fuer Task #89 (Handle-Leck im Viewer-Watcher).

    Schreibt HandleCount / ThreadCount / Working Set eines Prozesses zyklisch in
    eine CSV und auf die Konsole. Gedacht, um die SAETTIGUNGSKURVE sichtbar zu
    machen: steigt der Handle-Zaehler nach Viewer-Start steil an und bleibt dann
    auf einem projektabhaengigen Plateau stehen, ist es der chokidar-Watcher
    (ein nicht-rekursives fs.watch = ein Directory-Handle pro Verzeichnis).
    Ein Timer-Leck waere dagegen projektunabhaengig und wuerde linear weiterlaufen.

    WICHTIG: handle.exe ist ohne Adminrechte UNBRAUCHBAR (zeigte in einem
    Vorversuch nur 4 von 184 Handles). Deshalb hier bewusst Get-Process /
    Win32_Process — das liefert den echten Gesamtzaehler des Prozesses.

.PARAMETER ProcessId
    PID des zu messenden Prozesses. Alternativ -MatchCommandLine benutzen.

.PARAMETER MatchCommandLine
    Substring, nach dem in der CommandLine aller node-Prozesse gesucht wird
    (z.B. "aidex" oder "measure-viewer"). Die PID des AiDex-MCP aendert sich bei
    jedem Neustart — deshalb NIE fest verdrahten, immer frisch ermitteln.

.PARAMETER Seconds
    Messdauer. 0 = endlos bis Ctrl+C.

.PARAMETER IntervalMs
    Abtastintervall (Default 1000 ms).

.PARAMETER Csv
    Ziel-CSV. Default: scripts/measurements/handles-<label>-<zeit>.csv

.PARAMETER Label
    Freitext, landet im Dateinamen und in der CSV — z.B. "aidex-viewer".
    So bleiben die Laeufe der drei Stufen auseinanderzuhalten.

.EXAMPLE
    .\watch-handles.ps1 -MatchCommandLine "measure-viewer" -Seconds 180 -Label "aidex-viewer"

.EXAMPLE
    .\watch-handles.ps1 -ProcessId 33636 -Seconds 0 -Label "mcp-idle"
#>
[CmdletBinding(DefaultParameterSetName = 'ByMatch')]
param(
    [Parameter(ParameterSetName = 'ByPid', Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(ParameterSetName = 'ByMatch', Mandatory = $true)]
    [string]$MatchCommandLine,

    [int]$Seconds = 180,
    [int]$IntervalMs = 1000,
    [string]$Csv,
    [string]$Label = 'run'
)

$ErrorActionPreference = 'Stop'

# --- PID ermitteln ------------------------------------------------------------
# Bewusst ueber die CommandLine statt fest verdrahtet: die PID wechselt bei jedem
# MCP-Neustart. Bei mehreren Treffern wird abgebrochen statt geraten — eine
# falsche PID wuerde eine flache Linie liefern und den Test wertlos machen.
if ($PSCmdlet.ParameterSetName -eq 'ByMatch') {
    $cands = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$MatchCommandLine*" })

    if ($cands.Count -eq 0) {
        Write-Host "Kein node.exe mit '$MatchCommandLine' in der CommandLine gefunden." -ForegroundColor Red
        exit 1
    }
    if ($cands.Count -gt 1) {
        Write-Host "Mehrdeutig — $($cands.Count) Treffer fuer '$MatchCommandLine':" -ForegroundColor Yellow
        $cands | ForEach-Object { "  PID {0,6}  {1}" -f $_.ProcessId, $_.CommandLine | Write-Host }
        Write-Host "Bitte -ProcessId explizit angeben." -ForegroundColor Yellow
        exit 1
    }
    $ProcessId = $cands[0].ProcessId
    Write-Host "Gemessen wird PID $ProcessId" -ForegroundColor Cyan
    Write-Host "  $($cands[0].CommandLine)" -ForegroundColor DarkGray
}

$proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "PID $ProcessId existiert nicht." -ForegroundColor Red
    exit 1
}

# --- Ausgabedatei -------------------------------------------------------------
if (-not $Csv) {
    $dir = Join-Path $PSScriptRoot 'measurements'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $Csv = Join-Path $dir "handles-$Label-$stamp.csv"
}
'label,elapsed_s,timestamp,handles,threads,ws_mb' | Set-Content -Path $Csv -Encoding UTF8

$mode = if ($Seconds -le 0) { 'endlos (Ctrl+C beendet)' } else { "$Seconds s" }
Write-Host "Messe $mode, alle $IntervalMs ms  ->  $Csv" -ForegroundColor Cyan
Write-Host ''
Write-Host '  t/s   Handles   Delta   Threads    WS/MB' -ForegroundColor DarkGray

# --- Messschleife -------------------------------------------------------------
$sw       = [System.Diagnostics.Stopwatch]::StartNew()
$prev     = $null
$peak     = 0
$baseline = $null
$samples  = 0

try {
    while ($true) {
        $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        if ($Seconds -gt 0 -and $elapsed -ge $Seconds) { break }

        # Refresh() statt neuem Get-Process: billiger, und der Zaehler ist der
        # gleiche. Verschwindet der Prozess, ist der Lauf zu Ende.
        try { $proc.Refresh() } catch {
            Write-Host "`nProzess $ProcessId ist weg — Messung beendet." -ForegroundColor Yellow
            break
        }
        if ($proc.HasExited) {
            Write-Host "`nProzess $ProcessId beendet — Messung beendet." -ForegroundColor Yellow
            break
        }

        $h  = $proc.HandleCount
        $th = $proc.Threads.Count
        $ws = [math]::Round($proc.WorkingSet64 / 1MB, 1)

        if ($null -eq $baseline) { $baseline = $h }
        if ($h -gt $peak) { $peak = $h }
        $delta = if ($null -eq $prev) { 0 } else { $h - $prev }
        $prev  = $h
        $samples++

        '{0},{1},{2},{3},{4},{5}' -f $Label, $elapsed, (Get-Date -Format 'o'), $h, $th, $ws |
            Add-Content -Path $Csv -Encoding UTF8

        # Anstiege hervorheben — so sieht man die Sattelkante beim Zuschauen.
        $col = if ($delta -gt 50) { 'Red' } elseif ($delta -gt 5) { 'Yellow' } else { 'Gray' }
        Write-Host ('{0,5:N0}   {1,7:N0}   {2,5:+#;-#;0}   {3,7:N0}   {4,7:N1}' -f $elapsed, $h, $delta, $th, $ws) -ForegroundColor $col

        Start-Sleep -Milliseconds $IntervalMs
    }
} finally {
    $sw.Stop()
    if ($samples -gt 0) {
        Write-Host ''
        Write-Host '--- Ergebnis ---' -ForegroundColor Cyan
        Write-Host ("  Label      : {0}" -f $Label)
        Write-Host ("  Dauer      : {0:N1} s ({1} Messpunkte)" -f $sw.Elapsed.TotalSeconds, $samples)
        Write-Host ("  Start      : {0:N0} Handles" -f $baseline)
        Write-Host ("  Ende       : {0:N0} Handles" -f $prev)
        Write-Host ("  Maximum    : {0:N0} Handles" -f $peak)
        Write-Host ("  Zuwachs    : {0:+#;-#;0} Handles" -f ($peak - $baseline)) -ForegroundColor $(if (($peak - $baseline) -gt 1000) { 'Red' } else { 'Green' })
        Write-Host ("  CSV        : {0}" -f $Csv)
    }
}
