Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Select-Object ProcessId,
        @{N='MemMB';E={[math]::Round($_.WorkingSetSize/1MB,1)}},
        @{N='Started';E={$_.CreationDate}},
        CommandLine |
    Sort-Object MemMB -Descending |
    Format-List |
    Out-String -Width 400
