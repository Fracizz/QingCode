# Configure Gitee + GitHub dual remotes for QingCode.
# - origin: fetch from Gitee; push to Gitee and GitHub
# - github: fetch/push GitHub only (for pull/compare from GitHub)
#
# Usage:
#   pnpm remotes:setup
#   pwsh -File ./scripts/setup-dual-remotes.ps1

[CmdletBinding()]
param(
  [string]$GiteeUrl = 'https://gitee.com/FrancizTest_admin/qing-code.git',
  [string]$GitHubUrl = 'https://github.com/Fracizz/QingCode.git'
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
    git remote set-url origin $GiteeUrl
    if ($LASTEXITCODE -ne 0) { throw 'failed to set origin url' }
  } else {
    git remote add origin $GiteeUrl
    if ($LASTEXITCODE -ne 0) { throw 'failed to add origin' }
  }

  if ($remotes -contains 'github') {
    git remote set-url github $GitHubUrl
    if ($LASTEXITCODE -ne 0) { throw 'failed to set github url' }
  } else {
    git remote add github $GitHubUrl
    if ($LASTEXITCODE -ne 0) { throw 'failed to add github' }
  }

  # Replace push URLs so `git push origin` goes to both hosts.
  $existingPush = @(git config --get-all remote.origin.pushurl 2>$null)
  foreach ($url in $existingPush) {
    git remote set-url --delete --push origin $url 2>$null
  }
  git remote set-url --add --push origin $GiteeUrl
  if ($LASTEXITCODE -ne 0) { throw 'failed to add Gitee pushurl' }
  git remote set-url --add --push origin $GitHubUrl
  if ($LASTEXITCODE -ne 0) { throw 'failed to add GitHub pushurl' }

  Write-Host 'Dual remotes configured:'
  Write-Host '  fetch  origin  -> Gitee'
  Write-Host '  push   origin  -> Gitee + GitHub'
  Write-Host '  fetch  github  -> GitHub'
  Write-Host ''
  git remote -v
  if ($LASTEXITCODE -ne 0) { throw 'git remote -v failed' }

  Write-Host ''
  Write-Host 'Typical workflow:'
  Write-Host '  git fetch origin'
  Write-Host '  git fetch github'
  Write-Host '  git push origin <branch>   # pushes to both'
} finally {
  Pop-Location
}
