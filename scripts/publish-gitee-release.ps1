[CmdletBinding()]
param(
  [string]$Owner = 'FrancizTest_admin',
  [string]$Repo = 'qing-code',
  [Parameter(Mandatory = $true)]
  [string]$Tag,
  [Parameter(Mandatory = $true)]
  [string]$Name,
  [string]$Body = '',
  # Optional: omit or pass @() to only create/update release notes (no asset upload).
  [string[]]$Files = @(),
  [string]$Token = $env:GITEE_TOKEN,
  [string]$TargetCommitish = 'master'
)

$ErrorActionPreference = 'Stop'
$api = 'https://gitee.com/api/v5'

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw 'GITEE_TOKEN is empty. Create a Gitee private token and set GitHub secret GITEE_TOKEN.'
}

function Invoke-GiteeApi {
  param(
    [string]$Method,
    [string]$Path,
    [hashtable]$Query = @{},
    [hashtable]$Form = $null
  )
  $uri = [System.UriBuilder]"$api$Path"
  $pairs = New-Object System.Collections.Generic.List[string]
  $pairs.Add("access_token=$([uri]::EscapeDataString($Token))")
  foreach ($key in $Query.Keys) {
    $pairs.Add("$key=$([uri]::EscapeDataString([string]$Query[$key]))")
  }
  $uri.Query = ($pairs -join '&')

  if ($null -ne $Form) {
    return Invoke-RestMethod -Method $Method -Uri $uri.Uri -Body $Form -ContentType 'application/x-www-form-urlencoded'
  }
  return Invoke-RestMethod -Method $Method -Uri $uri.Uri
}

function Get-ReleaseByTag([string]$TagName) {
  try {
    $found = Invoke-GiteeApi -Method Get -Path "/repos/$Owner/$Repo/releases/tags/$TagName"
    # Gitee may respond 200 with JSON null / empty object when the tag has no release.
    if ($null -ne $found -and [int]$found.id -gt 0) { return $found }
  } catch {
    $resp = $_.Exception.Response
    if ($resp -and [int]$resp.StatusCode -eq 404) {
      # Fall through to list lookup.
    } else {
      # Older Gitee may not support /tags/{tag}; fall back to list.
    }
  }
  $page = 1
  while ($true) {
    $list = Invoke-GiteeApi -Method Get -Path "/repos/$Owner/$Repo/releases" -Query @{ page = "$page"; per_page = '50' }
    if (-not $list -or $list.Count -eq 0) { return $null }
    $hit = $list | Where-Object { $_.tag_name -eq $TagName -and [int]$_.id -gt 0 } | Select-Object -First 1
    if ($hit) { return $hit }
    if ($list.Count -lt 50) { return $null }
    $page++
  }
}

function New-GiteeRelease {
  Write-Host "Creating Gitee release $Tag ..."
  return Invoke-GiteeApi -Method Post -Path "/repos/$Owner/$Repo/releases" -Form @{
    tag_name         = $Tag
    name             = $Name
    body             = $Body
    target_commitish = $TargetCommitish
  }
}

function Update-GiteeRelease([int]$ReleaseId) {
  if ($ReleaseId -le 0) {
    throw "Invalid Gitee release id=$ReleaseId for tag $Tag"
  }
  Write-Host "Updating Gitee release $Tag (id=$ReleaseId) notes ..."
  # Gitee PATCH requires tag_name even when only updating notes.
  return Invoke-GiteeApi -Method Patch -Path "/repos/$Owner/$Repo/releases/$ReleaseId" -Form @{
    tag_name = $Tag
    name     = $Name
    body     = $Body
  }
}

function Get-AttachFiles([int]$ReleaseId) {
  try {
    return @(Invoke-GiteeApi -Method Get -Path "/repos/$Owner/$Repo/releases/$ReleaseId/attach_files")
  } catch {
    return @()
  }
}

function Remove-AttachFile([int]$ReleaseId, [int]$AttachId, [string]$FileName) {
  Write-Host "  removing existing attachment: $FileName"
  Invoke-GiteeApi -Method Delete -Path "/repos/$Owner/$Repo/releases/$ReleaseId/attach_files/$AttachId" | Out-Null
}

function Get-CurlCommand {
  foreach ($name in @('curl.exe', 'curl')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  throw 'curl not found. Install curl (Windows) or ensure curl is on PATH (Linux/macOS CI).'
}

function Add-AttachFile([int]$ReleaseId, [string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath)) {
    throw "File not found: $FilePath"
  }
  $item = Get-Item -LiteralPath $FilePath
  Write-Host ("  uploading {0} ({1:N1} MB) ..." -f $item.Name, ($item.Length / 1MB))

  $uri = "$api/repos/$Owner/$Repo/releases/$ReleaseId/attach_files"
  $curl = Get-CurlCommand
  $args = @(
    '-sS', '-f', '-X', 'POST',
    '-F', "access_token=$Token",
    '-F', "file=@$($item.FullName);filename=$($item.Name)",
    $uri
  )
  & $curl @args
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload $($item.Name) to Gitee (curl exit $LASTEXITCODE). Check token permissions and Gitee attachment size limits."
  }
  Write-Host "  uploaded $($item.Name)"
}

$release = Get-ReleaseByTag -TagName $Tag
if (-not $release) {
  $release = New-GiteeRelease
} else {
  $release = Update-GiteeRelease -ReleaseId ([int]$release.id)
}

$releaseId = [int]$release.id
$fileList = @($Files | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($fileList.Count -gt 0) {
  $existing = Get-AttachFiles -ReleaseId $releaseId
  $fileNames = @()
  foreach ($path in $fileList) {
    $resolved = Resolve-Path -LiteralPath $path
    foreach ($r in $resolved) {
      $fileNames += (Get-Item -LiteralPath $r.Path).Name
    }
  }

  foreach ($asset in $existing) {
    if ($fileNames -contains $asset.name) {
      Remove-AttachFile -ReleaseId $releaseId -AttachId ([int]$asset.id) -FileName $asset.name
    }
  }

  foreach ($path in $fileList) {
    $resolved = Resolve-Path -LiteralPath $path
    foreach ($r in $resolved) {
      Add-AttachFile -ReleaseId $releaseId -FilePath $r.Path
    }
  }
} else {
  Write-Host 'No files provided; skipped asset upload (notes only).'
}

$url = "https://gitee.com/$Owner/$Repo/releases/tag/$Tag"
Write-Host ""
Write-Host "OK Gitee release ready: $url" -ForegroundColor Green
Write-Host "  tag: $Tag"
Write-Host "  name: $Name"
