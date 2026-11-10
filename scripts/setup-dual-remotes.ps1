# Configure GitHub + Gitee remotes for QingCode.
# - origin: fetch/push GitHub (primary repository)
# - gitee: fetch/push Gitee only (mirror)
#
# Usage:
#   pnpm remotes:setup
#   pwsh -File ./scripts/setup-dual-remotes.ps1

[CmdletBinding()]
param(
  [string]$GitHubUrl = 'https://github.com/Fracizz/QingCode.git',
  [string]$GiteeUrl = 'https://gitee.com/FrancizTest_admin/qing-code.git'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.git'))) {
    throw 'Not a git repository. Run from a QingCode clone.'
  }

  $remotes = @(git remote)
  if ($LASTEXITCODE -ne 0) { throw 'git remote failed' }

  if ($remotes -contains 'origin') {
    git remote set-url origin $GitHubUrl
    if ($LASTEXITCODE -ne 0) { throw 'failed to set origin url' }
  } else {
    git remote add origin $GitHubUrl
    if ($LASTEXITCODE -ne 0) { throw 'failed to add origin' }
  }

  if ($remotes -contains 'gitee') {
    git remote set-url gitee $GiteeUrl
    if ($LASTEXITCODE -ne 0) { throw 'failed to set gitee url' }
  } else {
    git remote add gitee $GiteeUrl
    if ($LASTEXITCODE -ne 0) { throw 'failed to add gitee' }
  }

  # The old layout used a separate `github` remote alongside a Gitee origin;
  # `origin` now points at GitHub, so drop the duplicate remote if present.
  if ($remotes -contains 'github') {
    git remote remove github
    if ($LASTEXITCODE -ne 0) { throw 'failed to remove legacy github remote' }
  }

  # Drop any extra push URLs so `git push origin` targets GitHub only.
  $existingPush = @(git config --get-all remote.origin.pushurl 2>$null)
  foreach ($url in $existingPush) {
    git remote set-url --delete --push origin $url 2>$null
  }

  Write-Host 'Remotes configured:'
  Write-Host '  fetch/push  origin -> GitHub (primary)'
  Write-Host '  fetch/push  gitee  -> Gitee (mirror)'
  Write-Host ''
  git remote -v
  if ($LASTEXITCODE -ne 0) { throw 'git remote -v failed' }

  Write-Host ''
  Write-Host 'Typical workflow:'
  Write-Host '  git fetch origin'
  Write-Host '  git push origin <branch>   # publishes to GitHub'
  Write-Host '  git push gitee <branch>    # mirrors to Gitee'
} finally {
  Pop-Location
}
