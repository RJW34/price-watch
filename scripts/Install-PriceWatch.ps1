param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\PriceWatch'),
    [string[]]$PreviousInstall = @(),
    [switch]$NonInteractive,
    [switch]$NoShortcuts,
    [switch]$SkipNodeCheck
)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
$stage = $null
$backup = $null
$installed = $false

function Checked-Path([string]$Root, [string]$Relative) {
    if ($Relative -notmatch '^(?:(?:src|test|scripts)/[a-zA-Z0-9_./-]+|README\.md|ALERTS\.md|config\.example\.json|package\.json|start-watcher\.ps1|update-manifest\.json)$' -or $Relative -match '(^|/)\.\.?(/|$)') { throw "Invalid managed file path: $Relative" }
    $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $full.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'A managed file escaped its installation folder.' }
    $current = Split-Path -Parent $full
    while ($current.Length -gt $Root.Length) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "A managed directory is not safe: $current" }
        }
        $current = Split-Path -Parent $current
    }
    return $full
}
function Assert-RealDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Not a normal directory: $Path" }
    return $item.FullName.TrimEnd('\')
}
function Assert-Previous([string]$Path) {
    $root = Assert-RealDirectory $Path
    if (Test-Path -LiteralPath (Join-Path $root '.git')) { throw 'A Git checkout cannot be removed by the installer.' }
    $packagePath = Join-Path $root 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath) -or -not (Test-Path -LiteralPath (Join-Path $root 'src\watcher.js'))) { throw "Not a recognized Price Watch installation: $root" }
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    if ($package.name -notin @('price-watch', 'speaker-watch')) { throw "Not a recognized Price Watch installation: $root" }
    return $root
}
function Copy-Personal([string]$From, [string]$To) {
    foreach ($name in @('config.json', '.env', '.price-watch-state.json', '.speaker-watch-state.json')) {
        $old = Join-Path $From $name
        $new = Join-Path $To $name
        if ((Test-Path -LiteralPath $old -PathType Leaf) -and -not (Test-Path -LiteralPath $new)) {
            $item = Get-Item -LiteralPath $old -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cannot migrate a linked file: $old" }
            Copy-Item -LiteralPath $old -Destination $new
        }
    }
}
function File-SHA256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
function Remove-OldProgram([string]$Root) {
    $manifest = Join-Path $Root 'update-manifest.json'
    $names = @('README.md', 'ALERTS.md', 'config.example.json', 'package.json', 'start-watcher.ps1', 'update-manifest.json', 'src/cli.js', 'src/setup.js', 'src/watcher.js', 'src/updater.js', 'src/runner.js', 'src/zip-updater.js', 'test/watcher.test.js', 'test/updater.test.js', 'test/zip-updater.test.js', 'test/manifest.test.js', 'scripts/build-update-manifest.js')
    if (Test-Path -LiteralPath $manifest) {
        $oldManifest = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if ($oldManifest.version -ne 1 -or -not $oldManifest.files) { throw 'Old installation manifest is invalid; old files were left in place.' }
        $names += @($oldManifest.files.PSObject.Properties.Name)
    }
    $directories = @{}
    foreach ($name in ($names | Select-Object -Unique)) {
        $file = Checked-Path $Root $name
        $parent = Split-Path -Parent $file
        while ($parent.Length -gt $Root.Length) {
            if (Test-Path -LiteralPath $parent) { [void](Assert-RealDirectory $parent) }
            $directories[$parent] = $true
            $parent = Split-Path -Parent $parent
        }
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $item = Get-Item -LiteralPath $file -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Old installation contains a linked file: $file" }
            Remove-Item -LiteralPath $file -Force
        }
    }
    foreach ($dir in ($directories.Keys | Sort-Object Length -Descending)) {
        if ((Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $dir }
    }
    if (-not (Get-ChildItem -LiteralPath $Root -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $Root }
}

try {
    [void](Assert-RealDirectory $source)
    if ($source -eq $destination -or $source.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase) -or $destination.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose an installation folder separate from the downloaded files.' }
    if (-not $SkipNodeCheck) {
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or later is required. Install it from https://nodejs.org/ and run this installer again.' }
        $nodeVersion = (& node --version).TrimStart('v').Split('.')[0]
        if ([int]$nodeVersion -lt 20) { throw 'Node.js 20 or later is required. Update it from https://nodejs.org/ and run this installer again.' }
    }
    $manifestPath = Join-Path $source 'update-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.version -ne 1 -or -not $manifest.files) { throw 'The downloaded update manifest is invalid.' }
    if (Test-Path -LiteralPath $destination) { [void](Assert-Previous $destination) }
    if (-not $NonInteractive) {
        Add-Type -AssemblyName System.Windows.Forms
        do {
            $answer = [Windows.Forms.MessageBox]::Show('Do you have an older extracted Price Watch folder to remove? Select it to transfer settings and remove its program files. You can select multiple old folders, one at a time.','Price Watch setup','YesNo','Question')
            if ($answer -ne 'Yes') { break }
            $picker = New-Object Windows.Forms.FolderBrowserDialog
            $picker.Description = 'Select the old Price Watch folder (the folder containing package.json).'
            if ($picker.ShowDialog() -ne 'OK') { break }
            $PreviousInstall += $picker.SelectedPath
        } while ($true)
    }
    $previousDirs = @()
    foreach ($candidate in $PreviousInstall) {
        $previous = Assert-Previous $candidate
        if ($previous -eq $source -or $previous.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($previous + '\', [StringComparison]::OrdinalIgnoreCase) -or $destination.StartsWith($previous + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The previous installation must be separate from the download and new installation.' }
        if ($previous -notin $previousDirs -and $previous -ne $destination) { $previousDirs += $previous }
    }
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $stage = Join-Path $parent ('.price-watch-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    foreach ($property in $manifest.files.PSObject.Properties) {
        $from = Checked-Path $source $property.Name
        $to = Checked-Path $stage $property.Name
        if (-not (Test-Path -LiteralPath $from -PathType Leaf) -or (Get-Item -LiteralPath $from -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Missing or linked download file: $($property.Name)" }
        if ((File-SHA256 $from) -ne $property.Value) { throw "Downloaded file failed verification: $($property.Name)" }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
        Copy-Item -LiteralPath $from -Destination $to
    }
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage 'update-manifest.json')
    if (Test-Path -LiteralPath $destination) { Copy-Personal $destination $stage }
    foreach ($previous in $previousDirs) { Copy-Personal $previous $stage }
    if (Test-Path -LiteralPath $destination) {
        $backup = $destination + '.previous-' + [guid]::NewGuid().ToString('N')
        Move-Item -LiteralPath $destination -Destination $backup
    }
    try { Move-Item -LiteralPath $stage -Destination $destination; $installed = $true }
    catch { if ($backup -and -not (Test-Path -LiteralPath $destination)) { Move-Item -LiteralPath $backup -Destination $destination; $backup = $null }; throw }
    if (-not $NoShortcuts) {
        $programs = [Environment]::GetFolderPath('Programs')
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $programs 'Price Watch.lnk'))
        $shortcut.TargetPath = Join-Path $destination 'scripts\Start-PriceWatch.cmd'
        $shortcut.WorkingDirectory = $destination
        $shortcut.Description = 'Search for products and track eBay prices'
        $shortcut.Save()
    }
    foreach ($old in (@($backup) + $previousDirs)) {
        if ($old -and $old -ne $destination -and (Test-Path -LiteralPath $old)) {
            try { Remove-OldProgram $old } catch { Write-Warning "The new version is installed, but some old files were retained: $($_.Exception.Message)" }
        }
    }
    Write-Host "Price Watch installed at $destination. Open it from the Start menu."
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Write-Warning "Temporary installer files remain at $stage." }
}
