param(
    [switch]$Once,
    [switch]$Help,
    [switch]$Setup
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path $PSScriptRoot '..\..\work\ebay-credentials.xml'
$oldClientId = $env:EBAY_CLIENT_ID
$oldClientSecret = $env:EBAY_CLIENT_SECRET
try {
    if (Test-Path -LiteralPath $credentialPath) {
        $credential = Import-Clixml -LiteralPath $credentialPath
        $env:EBAY_CLIENT_ID = $credential.UserName
        $env:EBAY_CLIENT_SECRET = $credential.GetNetworkCredential().Password
    }
    Push-Location $PSScriptRoot
    try {
        $cliArgs = @()
        if ($Once) { $cliArgs += '--once' }
        if ($Help) { $cliArgs += '--help' }
        if ($Setup) { & node 'src/setup.js' } else { & node 'src/runner.js' @cliArgs }
        if ($LASTEXITCODE -ne 0) { throw "Watcher exited with code $LASTEXITCODE." }
    } finally { Pop-Location }
} finally {
    $env:EBAY_CLIENT_ID = $oldClientId
    $env:EBAY_CLIENT_SECRET = $oldClientSecret
}
