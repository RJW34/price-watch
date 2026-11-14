param([Parameter(Mandatory = $true)][string]$TargetDirectory)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = 'v24.22.3'
$architectures = @{
    'AMD64' = @{ label = 'x64'; archiveHash = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'; executableHash = '86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6' }
    'ARM64' = @{ label = 'arm64'; archiveHash = 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14'; executableHash = '172e320db179ce416fc012b96b9917dacfb442beb081de57c4deaed7b5a24644' }
}
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if (-not $architecture) { throw 'Windows processor architecture could not be determined.' }
$package = $architectures[$architecture.ToUpperInvariant()]
if (-not $package) { throw 'Price Watch requires 64-bit Windows on an x64 or ARM64 computer.' }
$runtime = [IO.Path]::GetFullPath($TargetDirectory)
if (Test-Path -LiteralPath $runtime) {
    $directory = Get-Item -LiteralPath $runtime -Force
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The runtime folder is not a normal directory.' }
} else { New-Item -ItemType Directory -Path $runtime | Out-Null }
$exe = Join-Path $runtime 'node.exe'
$license = Join-Path $runtime 'NODE-LICENSE.txt'
$metadata = Join-Path $runtime 'runtime-info.json'
if ((Test-Path -LiteralPath $exe) -or (Test-Path -LiteralPath $license) -or (Test-Path -LiteralPath $metadata)) { throw 'Runtime files already exist in the destination; they were not overwritten.' }
$nonce = [guid]::NewGuid().ToString('N')
$archivePath = Join-Path $runtime ('.node-download-' + $nonce + '.zip')
$executablePath = Join-Path $runtime ('.node-extract-' + $nonce + '.tmp')
$licensePath = Join-Path $runtime ('.node-license-' + $nonce + '.tmp')
$archiveCreated = $false
$executableCreated = $false
$licenseCreated = $false
$installedExe = $false
$installedLicense = $false
$metadataCreated = $false
$complete = $false
function FileHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
try {
    $filename = "node-$version-win-$($package.label).zip"
    $url = "https://nodejs.org/dist/$version/$filename"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "Downloading the Price Watch runtime from nodejs.org (about 40 MB)..."
    $reserved = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    $reserved.Dispose()
    $archiveCreated = $true
    Invoke-WebRequest -Uri $url -OutFile $archivePath -UseBasicParsing -TimeoutSec 300
    if ((FileHash $archivePath) -ne $package.archiveHash) { throw 'The downloaded runtime failed its integrity check.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entry = $zip.GetEntry("node-$version-win-$($package.label)/node.exe")
        if (-not $entry -or $entry.Length -gt 160MB -or $entry.Length -lt 1MB) { throw 'The runtime archive did not contain the expected executable.' }
        $licenseEntry = $zip.GetEntry("node-$version-win-$($package.label)/LICENSE")
        if (-not $licenseEntry -or $licenseEntry.Length -gt 1MB -or $licenseEntry.Length -eq 0) { throw 'The runtime archive did not contain its license.' }
        $inputStream = $entry.Open()
        try {
            $outputStream = [IO.File]::Open($executablePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            $executableCreated = $true
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
        } finally { $inputStream.Dispose() }
        $licenseInput = $licenseEntry.Open()
        try {
            $licenseOutput = [IO.File]::Open($licensePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            $licenseCreated = $true
            try { $licenseInput.CopyTo($licenseOutput) } finally { $licenseOutput.Dispose() }
        } finally { $licenseInput.Dispose() }
    } finally { $zip.Dispose() }
    if ((FileHash $executablePath) -ne $package.executableHash) { throw 'The extracted runtime failed its integrity check.' }
    Move-Item -LiteralPath $executablePath -Destination $exe
    $executableCreated = $false
    $installedExe = $true
    Move-Item -LiteralPath $licensePath -Destination $license
    $licenseCreated = $false
    $installedLicense = $true
    $reported = (& $exe --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $reported -ne $version) { throw 'The installed runtime could not start.' }
    $info = @{ managedBy = 'price-watch'; version = $version; sha256 = $package.executableHash } | ConvertTo-Json -Compress
    $metadataStream = [IO.File]::Open($metadata, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    $metadataCreated = $true
    try { $writer = New-Object IO.StreamWriter($metadataStream); try { $writer.Write($info) } finally { $writer.Dispose() } } finally { $metadataStream.Dispose() }
    $complete = $true
    Write-Host "Price Watch runtime $version is ready."
} finally {
    if ($archiveCreated -and (Test-Path -LiteralPath $archivePath)) { Remove-Item -LiteralPath $archivePath -Force }
    if ($executableCreated -and (Test-Path -LiteralPath $executablePath)) { Remove-Item -LiteralPath $executablePath -Force }
    if ($licenseCreated -and (Test-Path -LiteralPath $licensePath)) { Remove-Item -LiteralPath $licensePath -Force }
    if (-not $complete) {
        if ($installedExe -and (Test-Path -LiteralPath $exe)) { Remove-Item -LiteralPath $exe -Force }
        if ($installedLicense -and (Test-Path -LiteralPath $license)) { Remove-Item -LiteralPath $license -Force }
        if ($metadataCreated -and (Test-Path -LiteralPath $metadata)) { Remove-Item -LiteralPath $metadata -Force }
    }
}
