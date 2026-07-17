[CmdletBinding()]
param(
  [string]$Owner = 'FrancizTest_admin',
  [string]$Repo = 'qing-code',
  [Parameter(Mandatory = $true)]
  [string]$Tag,
  [Parameter(Mandatory = $true)]
  [string]$Name,
  [string]$Body = '',
  [Parameter(Mandatory = $true)]
  [string[]]$Files,
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
    return Invoke-GiteeApi -Method Get -Path "/repos/$Owner/$Repo/releases/tags/$TagName"
  } catch {
    $resp = $_.Exception.Response
    if ($resp -and [int]$resp.StatusCode -eq 404) { return $null }
    # Older Gitee may not support /tags/{tag}; fall back to list.
  }
  $page = 1
  while ($true) {
    $list = Invoke-GiteeApi -Method Get -Path "/repos/$Owner/$Repo/releases" -Query @{ page = "$page"; per_page = '50' }
    if (-not $list -or $list.Count -eq 0) { return $null }
    $hit = $list | Where-Object { $_.tag_name -eq $TagName } | Select-Object -First 1
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

function Add-AttachFile([int]$ReleaseId, [string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath)) {
    throw "File not found: $FilePath"
  }
  $item = Get-Item -LiteralPath $FilePath
  Write-Host ("  uploading {0} ({1:N1} MB) ..." -f $item.Name, ($item.Length / 1MB))

  $uri = "$api/repos/$Owner/$Repo/releases/$ReleaseId/attach_files"
  $args = @(
    '-sS', '-f', '-X', 'POST',
    '-F', "access_token=$Token",
    '-F', "file=@$($item.FullName);filename=$($item.Name)",
    $uri
  )
  & curl.exe @args
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to upload $($item.Name) to Gitee (curl exit $LASTEXITCODE). Check token permissions and Gitee attachment size limits."
  }
  Write-Host "  uploaded $($item.Name)"
}

$release = Get-ReleaseByTag -TagName $Tag
if (-not $release) {
  $release = New-GiteeRelease
} else {
  Write-Host "Gitee release for $Tag already exists (id=$($release.id)); uploading assets..."
}

$releaseId = [int]$release.id
$existing = Get-AttachFiles -ReleaseId $releaseId
$fileNames = @()
foreach ($path in $Files) {
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

foreach ($path in $Files) {
  $resolved = Resolve-Path -LiteralPath $path
  foreach ($r in $resolved) {
    Add-AttachFile -ReleaseId $releaseId -FilePath $r.Path
  }
}

$url = "https://gitee.com/$Owner/$Repo/releases"
Write-Host ""
Write-Host "OK Gitee release ready: $url" -ForegroundColor Green
Write-Host "  tag: $Tag"
Write-Host "  name: $Name"
