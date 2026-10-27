$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

function Get-QingSshContext {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Windows SSH compatibility repair requires an administrator SSH account.'
    }
    $service = Get-CimInstance Win32_Service -Filter "Name='sshd'"
    if (!$service) { throw 'Windows OpenSSH service sshd was not found.' }
    $command = [Environment]::ExpandEnvironmentVariables($service.PathName)
    if ($command -match '^\s*"([^"]+)"(.*)$') { $exe = $Matches[1]; $arguments = $Matches[2] }
    elseif ($command -match '^\s*(\S+)(.*)$') { $exe = $Matches[1]; $arguments = $Matches[2] }
    else { throw 'Cannot resolve the Windows OpenSSH service executable.' }
    if ($arguments -match '(?i)(^|\s)-f') { throw 'Custom sshd configuration paths are not supported by automatic repair.' }
    if ([IO.Path]::GetFileName($exe) -ine 'sshd.exe' -or !(Test-Path -LiteralPath $exe -PathType Leaf)) {
        throw 'Windows OpenSSH service executable is invalid.'
    }
    $dir = Join-Path $env:ProgramData 'ssh'
    $config = Join-Path $dir 'sshd_config'
    if (!(Test-Path -LiteralPath $config -PathType Leaf) -or (Get-Item -LiteralPath $config).Length -gt 262144) {
        throw 'Windows OpenSSH configuration is missing or too large.'
    }
    foreach ($path in @($dir, $config)) {
        if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Automatic repair does not follow configuration reparse points.'
        }
    }
    $parts = @($env:SSH_CONNECTION -split '\s+')
    $criteria = "user=$env:USERNAME,host=$env:COMPUTERNAME"
    if ($parts.Count -eq 4) { $criteria += ",addr=$($parts[0]),laddr=$($parts[2]),lport=$($parts[3])" }
    @{ Exe = $exe; Dir = $dir; Config = $config; Criteria = $criteria; Service = 'sshd'; Port = $(if ($parts.Count -eq 4) { [int]$parts[3] } else { 22 }) }
}

function Get-QingCompactBytes([string]$Path) {
    $lines = [IO.File]::ReadAllText($Path) -split '\r?\n' | Where-Object { $_ -notmatch '^\s*(#|$)' }
    $text = ($lines -join "`r`n") + "`r`n"
    ,([Text.UTF8Encoding]::new($false).GetBytes($text))
}

function Get-QingSshRepairPlan {
    $ctx = Get-QingSshContext
    $compact = Get-QingCompactBytes $ctx.Config
    $current = [IO.File]::ReadAllBytes($ctx.Config)
    @{
        configSha256 = (Get-FileHash -LiteralPath $ctx.Config -Algorithm SHA256).Hash
        originalBytes = $current.Length
        compactBytes = $compact.Length
        needsRepair = [Convert]::ToBase64String($current) -cne [Convert]::ToBase64String($compact)
        activeConnections = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpConnections() | Where-Object { $_.LocalEndPoint.Port -eq $ctx.Port -and $_.State -eq 'Established' }).Count
    }
}

function Test-QingSshCandidate($ctx, [string]$Candidate) {
    & $ctx.Exe -t -f $Candidate
    if ($LASTEXITCODE -ne 0) { throw 'Candidate sshd configuration failed syntax validation.' }
    foreach ($criteria in @('', $ctx.Criteria)) {
        $sshArgs = @('-T')
        if ($criteria) { $sshArgs += @('-C', $criteria) }
        $before = @(& $ctx.Exe @sshArgs -f $ctx.Config)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot read the current effective sshd configuration.' }
        $after = @(& $ctx.Exe @sshArgs -f $Candidate)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot read the candidate effective sshd configuration.' }
        if (@(Compare-Object ($before | Sort-Object) ($after | Sort-Object)).Count) {
            throw 'Effective sshd configuration changed; repair was cancelled.'
        }
    }
}

function Invoke-QingWindowsSshRepair([string]$ExpectedSha256, [string]$BackupName) {
    $ctx = Get-QingSshContext
    if ($BackupName -notmatch '^qingcode-ssh-repair-[a-f0-9]{32}$') { throw 'Invalid backup name.' }
    $lock = [IO.File]::Open((Join-Path $ctx.Dir 'qingcode-sshd-repair.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $configFile = $null
    $modified = $false
    try {
        # Hold the config against concurrent writers through validation and commit.
        $configFile = [IO.File]::Open($ctx.Config, 'Open', 'Read', 'Read')
        if ((Get-FileHash -LiteralPath $ctx.Config -Algorithm SHA256).Hash -ine $ExpectedSha256) {
            throw 'sshd_config changed after confirmation; review the repair again.'
        }
        $backup = Join-Path $ctx.Dir $BackupName
        if (Test-Path -LiteralPath $backup) { throw 'Backup directory already exists.' }
        $null = New-Item -ItemType Directory -Path $backup
        $acl = Get-Acl -LiteralPath $ctx.Config
        $original = [IO.File]::ReadAllBytes($ctx.Config)
        $compact = Get-QingCompactBytes $ctx.Config
        [IO.File]::WriteAllBytes("$backup/sshd_config.original", $original)
        [IO.File]::WriteAllBytes("$backup/sshd_config.compact", $compact)
        [IO.File]::WriteAllText("$backup/original-acl.sddl", $acl.Sddl)
        foreach ($path in @("$backup/sshd_config.original", "$backup/sshd_config.compact", "$backup/original-acl.sddl")) {
            Set-Acl -LiteralPath $path -AclObject $acl
        }
        Test-QingSshCandidate $ctx "$backup/sshd_config.compact"
        $configFile.Dispose(); $configFile = $null
        $configFile = [IO.File]::Open($ctx.Config, 'Open', 'ReadWrite', 'None')
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $lockedHash = [BitConverter]::ToString($sha.ComputeHash($configFile)).Replace('-', '') }
        finally { $sha.Dispose() }
        if ($lockedHash -ine $ExpectedSha256) { throw 'sshd_config changed before commit; repair was cancelled.' }
        $configFile.Position = 0
        $modified = $true
        $configFile.SetLength(0)
        $configFile.Write($compact, 0, $compact.Length)
        $configFile.Flush($true)
        $configFile.Dispose(); $configFile = $null
        if ((Get-Acl -LiteralPath $ctx.Config).Sddl -cne $acl.Sddl) { throw 'Configuration ACL changed.' }
        Restart-Service -Name $ctx.Service -ErrorAction Stop
        (Get-Service -Name $ctx.Service).WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(10))
        $result = @{ backupRoot = $backup; configSha256 = (Get-FileHash -LiteralPath $ctx.Config).Hash; restarted = $true }
        $result | ConvertTo-Json -Compress | Set-Content -LiteralPath "$backup/result.json" -Encoding UTF8
        $result
    } catch {
        $failure = $_
        if ($modified) {
            if ($configFile) { $configFile.Dispose(); $configFile = $null }
            [IO.File]::WriteAllBytes($ctx.Config, $original)
            Set-Acl -LiteralPath $ctx.Config -AclObject $acl
            Restart-Service -Name $ctx.Service -ErrorAction Stop
        }
        throw $failure
    } finally {
        if ($configFile) { $configFile.Dispose() }
        $lock.Dispose()
    }
}
