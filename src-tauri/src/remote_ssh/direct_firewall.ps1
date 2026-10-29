$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Get-QcAddress([string]$text) {
  $ip = $null
  if (-not [Net.IPAddress]::TryParse($text, [ref]$ip)) { return $null }
  if ($ip.IsIPv4MappedToIPv6) { $ip = $ip.MapToIPv4() }
  if ([Net.IPAddress]::IsLoopback($ip) -or $ip.Equals([Net.IPAddress]::Any) -or $ip.Equals([Net.IPAddress]::IPv6Any)) { return $null }
  return $ip.ToString()
}
function Get-QcHash([string]$text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha.Dispose() }
}
function Get-QcFirewallPlan([int]$port) {
  if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid TCP port' }
  $p = [ordered]@{ port=$port; clientAddress=''; localAddress=''; networkCategory=''; interfaceAlias=''; profiles=@(); ruleName=''; alreadyEnabled=$false; canApply=$false; reason=$null; account=[Security.Principal.WindowsIdentity]::GetCurrent().Name; existing=$null }
  $required = @('Get-NetFirewallRule','Get-NetFirewallPortFilter','Get-NetFirewallAddressFilter','New-NetFirewallRule','Get-NetIPAddress','Get-NetConnectionProfile')
  foreach ($name in $required) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { $p.reason='[direct:firewall-unsupported] 此主机不支持 Windows NetSecurity 防火墙管理，请手动配置。'; return $p }
  }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $p.reason='[direct:firewall-admin] 此 SSH 账户没有管理员权限，请使用已确认身份的管理员 SSH 连接或手动放行端口。'; return $p }
  $parts = @($env:SSH_CONNECTION -split '\s+' | Where-Object { $_ })
  if ($parts.Count -ne 4) { $p.reason='[direct:firewall] 无法从此 SSH 会话确定客户端来源地址，未生成放行计划。'; return $p }
  $client = Get-QcAddress $parts[0]
  $local = Get-QcAddress $parts[2]
  if (-not $client -or -not $local) { $p.reason='[direct:firewall] SSH 来源或本地地址不适合生成精确的防火墙规则，请手动配置。'; return $p }
  $p.clientAddress=$client; $p.localAddress=$local
  $interfaces = @(Get-NetIPAddress -IPAddress $local -ErrorAction Stop | Select-Object -ExpandProperty InterfaceIndex -Unique)
  if ($interfaces.Count -ne 1) { $p.reason='[direct:firewall] 无法唯一确定接收 SSH 连接的网络接口，请手动配置。'; return $p }
  $networks = @(Get-NetConnectionProfile -InterfaceIndex $interfaces[0] -ErrorAction Stop)
  $categories = @($networks | ForEach-Object { [string]$_.NetworkCategory } | Sort-Object -Unique)
  if ($categories.Count -ne 1) { $p.reason='[direct:firewall] 无法唯一确定当前网络配置文件，请手动配置。'; return $p }
  $category=$categories[0]
  $profile = switch ($category) { 'DomainAuthenticated' { 'Domain' } 'Private' { 'Private' } 'Public' { 'Public' } default { $null } }
  if (-not $profile) { $p.reason='[direct:firewall] 当前网络类型不受支持，请手动配置。'; return $p }
  $p.networkCategory=$category; $p.interfaceAlias=[string]$networks[0].InterfaceAlias; $p.profiles=@($profile)
  $id = (Get-QcHash "$port|$client|$local").Substring(0,16)
  $p.ruleName="QingCode-Agent-Direct-TCP-$port-$id"
  $description="QingCode managed Agent inbound v1; TCP=$port; Source=$client; Local=$local"
  $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $p.ruleName -ErrorAction SilentlyContinue)
  if ($rules.Count -gt 1) { $p.reason='[direct:firewall] 存在重复的同名防火墙规则，请先手动核对。'; return $p }
  if ($rules.Count -eq 1) {
    $rule=$rules[0]
    $ports=@(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)
    $addresses=@(Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)
    $p.existing=[ordered]@{ name=[string]$rule.Name; group=[string]$rule.Group; description=[string]$rule.Description; enabled=[string]$rule.Enabled; direction=[string]$rule.Direction; action=[string]$rule.Action; profile=[string]$rule.Profile; ports=@($ports | Select-Object Protocol,LocalPort,RemotePort); addresses=@($addresses | Select-Object LocalAddress,RemoteAddress) }
    $matches = $rule.Group -eq 'QingCode Agent' -and $rule.Description -eq $description -and [string]$rule.Enabled -eq 'True' -and [string]$rule.Direction -eq 'Inbound' -and [string]$rule.Action -eq 'Allow' -and [string]$rule.Profile -eq $profile -and $ports.Count -eq 1 -and $addresses.Count -eq 1
    if ($matches) { $matches = [string]$ports[0].Protocol -in @('TCP','6') -and [string]$ports[0].LocalPort -eq [string]$port -and [string]$ports[0].RemotePort -eq 'Any' -and @($addresses[0].RemoteAddress).Count -eq 1 -and [string]$addresses[0].RemoteAddress -eq $client -and @($addresses[0].LocalAddress).Count -eq 1 -and [string]$addresses[0].LocalAddress -eq $local }
    if (-not $matches) { $p.reason='[direct:firewall] 已存在同名但范围不同的规则，应用不会覆盖，请先手动核对。'; return $p }
    $p.alreadyEnabled=$true
  }
  $p.canApply=$true
  return $p
}
function Invoke-QcFirewall([int]$port,[string]$expected,[bool]$apply,[string]$identity='') {
  $plan=Get-QcFirewallPlan $port
  $hash=Get-QcHash ($identity + "`n" + ($plan | ConvertTo-Json -Depth 10 -Compress))
  if (-not $apply) {
    $plan.Remove('existing')
    $plan['planSha256']=$hash
    return [ordered]@{ok=$true;value=$plan}
  }
  if ($hash -ne $expected) { return [ordered]@{ok=$false;code='[direct:firewall-stale]';message='防火墙状态或 SSH 来源已变化，请重新检查后确认。'} }
  if (-not $plan.canApply) { return [ordered]@{ok=$false;code='[direct:firewall]';message=$plan.reason} }
  $changed=-not $plan.alreadyEnabled
  if ($changed) {
    New-NetFirewallRule -PolicyStore PersistentStore -Name $plan.ruleName -DisplayName "QingCode Agent TCP $port ($($plan.clientAddress))" -Group 'QingCode Agent' -Description "QingCode managed Agent inbound v1; TCP=$port; Source=$($plan.clientAddress); Local=$($plan.localAddress)" -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -RemotePort Any -RemoteAddress $plan.clientAddress -LocalAddress $plan.localAddress -Profile $plan.profiles -ErrorAction Stop | Out-Null
  }
  $after=Get-QcFirewallPlan $port
  if (-not $after.alreadyEnabled) { throw 'Firewall rule verification failed' }
  return [ordered]@{ok=$true;value=[ordered]@{changed=$changed;ruleName=$plan.ruleName;port=$port;clientAddress=$plan.clientAddress;localAddress=$plan.localAddress;profiles=$plan.profiles}}
}
