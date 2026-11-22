$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

Write-Host "[1/5] Building Firefox extension..."
npm run build:firefox | Out-Host

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$releaseRoot = Join-Path $root "release"
$targetRoot = Join-Path $releaseRoot "firefox-upload-$timestamp"
$unpackedDir = Join-Path $targetRoot "unpacked"
$zipPath = Join-Path $targetRoot "gemini-project-extension-firefox.zip"
$manifestPath = Join-Path $unpackedDir "manifest.json"

Write-Host "[2/5] Preparing release folder..."
New-Item -ItemType Directory -Path $unpackedDir -Force | Out-Null

Write-Host "[3/5] Copying dist/firefox files..."
Copy-Item -Path (Join-Path $root "dist\firefox\*") -Destination $unpackedDir -Recurse -Force
Get-ChildItem -Path $unpackedDir -Filter "*.map" -Recurse | Remove-Item -Force
Get-ChildItem -Path $unpackedDir -Filter "*.js" -Recurse | ForEach-Object {
  $content = Get-Content -Raw -Path $_.FullName -Encoding UTF8
  $stripped = [System.Text.RegularExpressions.Regex]::Replace($content, '(?m)^//# sourceMappingURL=.*(?:\r?\n|$)', '')
  [System.IO.File]::WriteAllText($_.FullName, $stripped, [System.Text.UTF8Encoding]::new($false))
}

if (!(Test-Path $manifestPath)) {
  throw "manifest.json not found in $unpackedDir"
}

Write-Host "[4/5] Validating Firefox manifest and extension pages..."
foreach ($requiredFile in @("grant-permission.html", "grant-permission.js")) {
  if (!(Test-Path (Join-Path $unpackedDir $requiredFile))) {
    throw "$requiredFile not found in $unpackedDir"
  }
}

$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
if ($manifest.browser_specific_settings.gecko.id -ne "gemini-folder-sync@pro-grammer.de") {
  throw "Unexpected browser_specific_settings.gecko.id: $($manifest.browser_specific_settings.gecko.id)"
}
if (!$manifest.background -or !$manifest.background.scripts -or $manifest.background.scripts.Count -eq 0) {
  throw "Expected Firefox manifest background.scripts to be populated"
}

Write-Host "[5/5] Creating zip..."
Compress-Archive -Path (Join-Path $unpackedDir "*") -DestinationPath $zipPath -Force

Write-Host ""
Write-Host "Done."
Write-Host "Unpacked: $unpackedDir"
Write-Host "Zip:      $zipPath"
