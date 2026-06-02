# Inspect what npm publish would ship; flag anything sensitive/unwanted.
Set-Location (Split-Path -Parent $PSScriptRoot)
$out = npm publish --dry-run 2>&1 | Out-String
$bad = $out -split "`n" | Select-String -Pattern 'token|\.env|secret|\.npmrc|embed-|forensic|dry-run-|loadtest|\.log|test-panel|test-backpressure|test-tree|check-npm-auth|check-pid'
if ($bad) {
    Write-Host "WARNING - unwanted files in package:"
    $bad | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) }
} else {
    Write-Host "CLEAN - no sensitive/dev files in the package tarball"
}
