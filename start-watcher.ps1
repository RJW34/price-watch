param(
    [switch]$Once,
    [switch]$Help,
    [switch]$Setup
)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $node = Join-Path $PSScriptRoot 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $node)) { $node = 'node' }
    $cliArgs = @()
    if ($Once) { $cliArgs += '--once' }
    if ($Help) { $cliArgs += '--help' }
    if ($Setup) { & $node 'src/setup.js' } else { & $node 'src/runner.js' @cliArgs }
    if ($LASTEXITCODE -ne 0) { throw "Watcher exited with code $LASTEXITCODE." }
} finally { Pop-Location }
