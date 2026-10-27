# Real file/ACL/OpenSSH validation with a disposable configuration. Service
# operations are mocked and reject every name except the fixture's own label.
param([Parameter(Mandatory)][string]$ImplementationPath)
$ErrorActionPreference = 'Stop'
. $ImplementationPath
$originalContext = Get-QingSshContext
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('qingcode-sshd-repair-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixtureRoot
$fixtureConfig = Join-Path $fixtureRoot 'sshd_config'
$sourceText = [IO.File]::ReadAllText($originalContext.Config)
$fixtureText = "# disposable compatibility fixture`r`n`r`n" + $sourceText
$script:fixtureContext = $originalContext.Clone()
$script:fixtureContext.Dir = $fixtureRoot
$script:fixtureContext.Config = $fixtureConfig
$script:fixtureContext.Service = 'qingcode-test-not-a-service'
$script:restarts = 0
$script:failRestart = $false
function Get-QingSshContext { $script:fixtureContext }
function Restart-Service {
    [CmdletBinding()]param([string]$Name)
    if ($Name -ne 'qingcode-test-not-a-service') { throw 'Refusing a non-fixture service operation.' }
    $script:restarts++
    if ($script:failRestart -and $script:restarts -eq 1) { throw 'injected restart failure' }
}
function Get-Service {
    param([string]$Name)
    if ($Name -ne 'qingcode-test-not-a-service') { throw 'Refusing a non-fixture service operation.' }
    $service = [pscustomobject]@{}
    $service | Add-Member ScriptMethod WaitForStatus { param($Status, $Timeout) }
    $service
}
function Reset-Fixture {
    [IO.File]::WriteAllText($fixtureConfig, $fixtureText, [Text.UTF8Encoding]::new($false))
    $script:restarts = 0
    $script:failRestart = $false
}
function Assert-Fixture([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}
$checks = @()
try {
    Reset-Fixture
    $plan = Get-QingSshRepairPlan
    $initialAcl = (Get-Acl $fixtureConfig).Sddl
    Assert-Fixture $plan.needsRepair 'Fixture should need compaction.'
    $result = Invoke-QingWindowsSshRepair $plan.configSha256 ('qingcode-ssh-repair-' + [Guid]::NewGuid().ToString('N'))
    Assert-Fixture ($script:restarts -eq 1 -and $result.restarted) 'Expected one mocked restart.'
    Assert-Fixture ((Get-Acl $fixtureConfig).Sddl -ceq $initialAcl) 'ACL changed.'
    Assert-Fixture ((Get-FileHash "$($result.backupRoot)/sshd_config.original").Hash -eq $plan.configSha256) 'Backup bytes changed.'
    Assert-Fixture (!(Get-QingSshRepairPlan).needsRepair) 'Compaction was not idempotent.'
    $checks += 'real-config-effective-equivalence-backup-acl-and-idempotence'

    Reset-Fixture
    $before = (Get-FileHash $fixtureConfig).Hash
    try {
        $null = Invoke-QingWindowsSshRepair ('0' * 64) ('qingcode-ssh-repair-' + [Guid]::NewGuid().ToString('N'))
        throw 'Expected stale digest rejection.'
    } catch { if ($_.Exception.Message -notmatch 'changed after confirmation') { throw } }
    Assert-Fixture ((Get-FileHash $fixtureConfig).Hash -eq $before -and $script:restarts -eq 0) 'Stale confirmation modified the fixture.'
    $checks += 'stale-confirmation-rejected-without-mutation'

    Reset-Fixture
    $before = (Get-FileHash $fixtureConfig).Hash
    $script:failRestart = $true
    try {
        $null = Invoke-QingWindowsSshRepair $before ('qingcode-ssh-repair-' + [Guid]::NewGuid().ToString('N'))
        throw 'Expected injected restart failure.'
    } catch { if ($_.Exception.Message -notmatch 'injected restart failure') { throw } }
    Assert-Fixture ((Get-FileHash $fixtureConfig).Hash -eq $before -and $script:restarts -eq 2) 'Restart failure did not restore original bytes.'
    Assert-Fixture ((Get-Acl $fixtureConfig).Sddl -ceq $initialAcl) 'Rollback did not preserve ACL.'
    $checks += 'restart-failure-restores-original-bytes-and-acl'

    Reset-Fixture
    $before = (Get-FileHash $fixtureConfig).Hash
    $savedCompact = (Get-Item function:Get-QingCompactBytes).ScriptBlock
    function Get-QingCompactBytes([string]$Path) {
        ,([Text.UTF8Encoding]::new($false).GetBytes("Port 1`r`n" + [IO.File]::ReadAllText($Path)))
    }
    try {
        $null = Invoke-QingWindowsSshRepair $before ('qingcode-ssh-repair-' + [Guid]::NewGuid().ToString('N'))
        throw 'Expected effective configuration rejection.'
    } catch { if ($_.Exception.Message -notmatch 'Effective sshd configuration changed') { throw } }
    Set-Item function:Get-QingCompactBytes $savedCompact
    Assert-Fixture ((Get-FileHash $fixtureConfig).Hash -eq $before -and $script:restarts -eq 0) 'Changed effective configuration was applied.'
    $checks += 'changed-effective-configuration-rejected-before-write'
    @{ passed = $true; checks = $checks; actualServiceRestarted = $false; actualConfigModified = $false } | ConvertTo-Json -Compress
} finally {
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (!$resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^qingcode-sshd-repair-test-[a-f0-9]{32}$') {
        throw 'Refusing fixture cleanup outside its own temporary directory.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
