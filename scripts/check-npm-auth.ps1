# Verify npm auth token is present WITHOUT printing any secret.
$npmrc = Join-Path $HOME ".npmrc"
if (Test-Path $npmrc) {
    $hasToken = Select-String -Path $npmrc -Pattern "_authToken" -Quiet
    Write-Host ("~/.npmrc present. authToken configured: " + $hasToken)
} else {
    Write-Host "No ~/.npmrc found"
}
