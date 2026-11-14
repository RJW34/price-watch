param(
    [switch]$Once,
    [switch]$Help,
    [switch]$Setup
)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $cliArgs = @()
    if ($Once) { $cliArgs += '--once' }
    if ($Help) { $cliArgs += '--help' }
    if ($Setup) { & node 'src/setup.js' } else { & node 'src/runner.js' @cliArgs }
    if ($LASTEXITCODE -ne 0) { throw "Watcher exited with code $LASTEXITCODE." }
} finally { Pop-Location }
