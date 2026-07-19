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
  [string]$TargetCommitish = 'master',
  # Per-file upload timeout (seconds). Avoids hanging forever on slow Gitee links.
  [int]$UploadTimeoutSec = 600
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
    if ($null -ne $found -and [int]$found.id -gt 0) { return $found }
  } catch {
    # Tag has no release yet, or API variant unavailable.
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

function Ensure-GiteeRelease {
  $existing = Get-ReleaseByTag -TagName $Tag
  if (-not $existing) {
    Write-Host "Creating Gitee release $Tag ..."
    return Invoke-GiteeApi -Method Post -Path "/repos/$Owner/$Repo/releases" -Form @{
      tag_name         = $Tag
      name             = $Name
      body             = $Body
      target_commitish = $TargetCommitish
    }
  }

  Write-Host "Updating Gitee release $Tag (id=$([int]$existing.id)) notes ..."
  return Invoke-GiteeApi -Method Patch -Path "/repos/$Owner/$Repo/releases/$([int]$existing.id)" -Form @{
    tag_name = $Tag
    name     = $Name
    body     = $Body
  }
}

function ConvertTo-Int32Scalar {
  param($Value)
  if ($null -eq $Value) { return 0 }
  $candidate = $Value
  # Gitee/PowerShell may surface ids as Object[]; unwrap before [int] cast.
  while ($candidate -is [System.Array]) {
    if ($candidate.Length -eq 0) { return 0 }
    $candidate = $candidate[0]
  }
  return [int]$candidate
}

function Get-AttachFiles([int]$ReleaseId) {
  try {
    $raw = Invoke-GiteeApi -Method Get -Path "/repos/$Owner/$Repo/releases/$ReleaseId/attach_files"
  } catch {
    return
  }
  if ($null -eq $raw) { return }

  # Emit one attachment object per pipeline item (never a nested Object[] as $asset).
  foreach ($item in @($raw)) {
    if ($null -eq $item) { continue }
    if ($item -is [System.Array]) {
      foreach ($inner in $item) {
        if ($null -ne $inner) { $inner }
      }
      continue
    }
    if ($item.PSObject.Properties['attach_files']) {
      foreach ($inner in @($item.attach_files)) {
        if ($null -ne $inner) { $inner }
      }
      continue
    }
    $item
  }
}

function Remove-AllAttachFiles([int]$ReleaseId) {
  $existing = @(Get-AttachFiles -ReleaseId $ReleaseId)
  if ($existing.Count -eq 0) {
    Write-Host 'No previous Gitee attachments.'
    return
  }

  Write-Host "Clearing $($existing.Count) previous Gitee attachment(s) ..."
  foreach ($asset in $existing) {
    if ($null -eq $asset) { continue }
    $attachId = ConvertTo-Int32Scalar $asset.id
    $fileName = [string]$asset.name
    if ($attachId -le 0) {
      Write-Host "  skip: attachment without scalar id ($fileName)"
      continue
    }
    Write-Host "  delete: $fileName (id=$attachId)"
    try {
      Invoke-GiteeApi -Method Delete -Path "/repos/$Owner/$Repo/releases/$ReleaseId/attach_files/$attachId" | Out-Null
    } catch {
      # Best-effort cleanup — stale/missing attach ids must not block the new upload.
      Write-Host "  warn: delete failed for $fileName — $($_.Exception.Message)"
    }
  }
}

function Get-CurlCommand {
  foreach ($name in @('curl.exe', 'curl')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  throw 'curl not found. Install curl (Windows) or ensure curl is on PATH.'
}

function Add-AttachFile([int]$ReleaseId, [string]$FilePath) {
  $item = Get-Item -LiteralPath $FilePath
  Write-Host ("  upload {0} ({1:N1} MB, timeout {2}s) ..." -f $item.Name, ($item.Length / 1MB), $UploadTimeoutSec)

  $uri = "$api/repos/$Owner/$Repo/releases/$ReleaseId/attach_files"
  $curl = Get-CurlCommand
  # No -f: do not abort the whole publish on a single HTTP blip; we inspect exit code.
  $args = @(
    '-sS',
    '--connect-timeout', '30',
    '--max-time', "$UploadTimeoutSec",
    '-X', 'POST',
    '-F', "access_token=$Token",
    '-F', "file=@$($item.FullName);filename=$($item.Name)",
    '-w', '%{http_code}',
    '-o', "$env:TEMP\gitee-upload-$($item.Name).json",
    $uri
  )
  $httpCode = & $curl @args
  $exit = $LASTEXITCODE
  if ($exit -ne 0) {
    throw "upload failed: $($item.Name) (curl exit $exit)"
  }
  if ($httpCode -notmatch '^(200|201)$') {
    $bodyHint = ''
    $outPath = "$env:TEMP\gitee-upload-$($item.Name).json"
    if (Test-Path -LiteralPath $outPath) {
      $bodyHint = (Get-Content -LiteralPath $outPath -Raw -ErrorAction SilentlyContinue)
      if ($bodyHint.Length -gt 200) { $bodyHint = $bodyHint.Substring(0, 200) + '…' }
    }
    throw "upload failed: $($item.Name) HTTP $httpCode $bodyHint"
  }
  Write-Host "  ok $($item.Name)"
}

$release = Ensure-GiteeRelease
$releaseId = ConvertTo-Int32Scalar $release.id
if ($releaseId -le 0) {
  throw "Gitee release id missing after create/update for tag $Tag"
}

# Always inspect and clear previous attachments before uploading this run's assets.
Remove-AllAttachFiles -ReleaseId $releaseId

$fileList = @(
  $Files |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { (Resolve-Path -LiteralPath $_).Path }
)

if ($fileList.Count -eq 0) {
  Write-Host 'No files provided; notes-only update.'
} else {
  Write-Host "Uploading $($fileList.Count) file(s) ..."
  $failed = New-Object System.Collections.Generic.List[string]
  foreach ($path in $fileList) {
    try {
      Add-AttachFile -ReleaseId $releaseId -FilePath $path
    } catch {
      Write-Host "  ERROR: $($_.Exception.Message)"
      $failed.Add([IO.Path]::GetFileName($path)) | Out-Null
    }
  }
  if ($failed.Count -gt 0) {
    throw ("Gitee upload incomplete ({0}/{1} failed): {2}" -f $failed.Count, $fileList.Count, ($failed -join ', '))
  }
}

$url = "https://gitee.com/$Owner/$Repo/releases/tag/$Tag"
Write-Host ""
Write-Host "OK Gitee release ready: $url" -ForegroundColor Green
Write-Host "  tag: $Tag"
Write-Host "  name: $Name"
