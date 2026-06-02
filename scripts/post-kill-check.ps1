$os = Get-CimInstance Win32_OperatingSystem
"Free RAM:   {0,6:N1} GB" -f ($os.FreePhysicalMemory/1MB)
"Free Swap:  {0,6:N1} GB" -f ($os.FreeVirtualMemory/1MB)

"`n--- Ports 3333/3335 ---"
$ports = Get-NetTCPConnection -LocalPort 3333,3335 -State Listen -ErrorAction SilentlyContinue
if ($ports) {
    $ports | Select-Object LocalPort,OwningProcess | Format-Table -AutoSize
} else {
    "Both ports free."
}
