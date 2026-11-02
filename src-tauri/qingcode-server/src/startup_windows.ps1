$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

function Invoke-QcStartup($operation, $name, $binary, $state, $hostname, [int]$port) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $marker = 'QingCode startup v1; SID=' + $identity.User.Value + '; state=' + $state
    $task = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task -and $task.Description -cne $marker) { throw 'Refusing to modify an unowned scheduled task' }
    if ($operation -eq 'status') {
        if (!$task -or $task.State -eq 'Disabled') { throw 'Startup is disabled' }
        return
    }
    if ($operation -eq 'disable') {
        if ($task) { Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false }
        return
    }
    # A boot trigger needs an administrator to register. The actual gateway
    # runs with the same user's limited token, without a stored password.
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Boot startup requires an administrator SSH account. Turn off startup to start once.'
    }
    if ($binary.Contains('"') -or $state.Contains('"') -or $hostname -notmatch '^[0-9a-fA-F:.]+$') { throw 'Invalid startup path or listener address' }
    $arguments = 'direct --hostname "' + $hostname + '" --port ' + $port + ' --state-dir "' + $state.TrimEnd('\') + '"'
    $action = New-ScheduledTaskAction -Execute $binary -Argument $arguments -WorkingDirectory $env:USERPROFILE
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT15S'
    $owner = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType S4U -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $name -TaskPath '\' -Description $marker -Action $action -Trigger $trigger -Principal $owner -Settings $settings -Force | Out-Null
    $registered = Get-ScheduledTask -TaskName $name -TaskPath '\'
    if ($registered.Description -cne $marker -or $registered.State -eq 'Disabled') { throw 'Startup registration verification failed' }
}
