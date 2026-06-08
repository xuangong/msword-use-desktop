[CmdletBinding()]
param(
  [string]$Endpoint = $env:MSWORD_USE_ENDPOINT,
  [string]$ApiKey = $env:MSWORD_USE_API_KEY,
  [string]$Model = $env:MSWORD_USE_MODEL,
  [string]$InstallerPath,
  [switch]$Build,
  [switch]$UseMsi,
  [switch]$Silent,
  [switch]$NoLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bundleRoot = Join-Path $repoRoot "apps\desktop\src-tauri\target\release\bundle"

if ([string]::IsNullOrWhiteSpace($Endpoint)) {
  throw "Endpoint is required. Pass -Endpoint or set MSWORD_USE_ENDPOINT."
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "ApiKey is required. Pass -ApiKey or set MSWORD_USE_API_KEY."
}
if ([string]::IsNullOrWhiteSpace($Model)) {
  $Model = "claude-sonnet-4-5"
}

if ($Build) {
  Push-Location $repoRoot
  try {
    & bun run package:windows
    if ($LASTEXITCODE -ne 0) {
      throw "bun run package:windows failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $candidateDirs = @(
    $PSScriptRoot,
    (Join-Path $PSScriptRoot "nsis"),
    (Join-Path $PSScriptRoot "msi"),
    (Join-Path $bundleRoot "msi"),
    (Join-Path $bundleRoot "nsis")
  )
  $filter = if ($UseMsi) { "*.msi" } else { "*-setup.exe" }
  $installer = $candidateDirs |
    Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object { Get-ChildItem -Path $_ -Filter $filter -File -ErrorAction SilentlyContinue } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $installer) {
    throw "No installer matching $filter found next to this script or under $bundleRoot\nRun with -Build first, or pass -InstallerPath."
  }
  $InstallerPath = $installer.FullName
}

$InstallerPath = (Resolve-Path $InstallerPath).Path

$appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\Roaming" }
$dataDir = Join-Path $appData "msword-use"
$configPath = Join-Path $dataDir "config.json"
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$config = [ordered]@{
  baseUrl = $Endpoint.Trim()
  apiKey = $ApiKey.Trim()
  model = $Model.Trim()
  disableThinkingField = $true
}
$config | ConvertTo-Json -Depth 8 | Set-Content -Path $configPath -Encoding utf8
Write-Host "[install] wrote config: $configPath"

Write-Host "[install] running installer: $InstallerPath"
$ext = [System.IO.Path]::GetExtension($InstallerPath).ToLowerInvariant()
if ($ext -eq ".msi") {
  $installerArgs = @("/i", $InstallerPath)
  if ($Silent) {
    $installerArgs += "/qn"
  }
  $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $installerArgs -Wait -PassThru
} else {
  $installerArgs = @()
  if ($Silent) {
    $installerArgs += "/S"
  }
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $installerArgs -Wait -PassThru
}
if ($proc.ExitCode -ne 0) {
  throw "Installer failed with exit code $($proc.ExitCode)"
}

if (-not $NoLaunch) {
  $exeCandidates = @()
  if ($env:LOCALAPPDATA) {
    $exeCandidates += Join-Path $env:LOCALAPPDATA "msword-use\msword-use.exe"
  }
  if ($env:ProgramFiles) {
    $exeCandidates += Join-Path $env:ProgramFiles "msword-use\msword-use.exe"
  }
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  if ($programFilesX86) {
    $exeCandidates += Join-Path $programFilesX86 "msword-use\msword-use.exe"
  }

  $appExe = $exeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($appExe) {
    Write-Host "[install] launching: $appExe"
    Start-Process -FilePath $appExe | Out-Null
  } else {
    Write-Warning "Installed app exe was not found in the default locations. Launch msword-use from the Start menu."
  }
}

Write-Host "[install] done. User data: $dataDir"
