# QingCode Linux 防火墙授权脚本（经 sudo 以 root 运行，参数由客户端拼接且已校验）。
# $1 端口  $2 期望计划哈希（检查时为空）  $3 是否写入(0/1)  $4 SSH 身份哈希
# $5 提权前的 SSH_CONNECTION  $6 提权前的登录账户
# 只新增「单一来源 + 单一接收地址 + 单一 TCP 端口」的放行规则，不删改已有规则、不重载防火墙。
PATH="$PATH:/usr/sbin:/sbin:/usr/bin:/bin"
export LC_ALL=C
port=$1; expected=$2; apply=$3; identity=$4; conn=$5; login=$6

out_fail() { printf '{"ok":false,"code":"%s","message":"%s"}\n' "$1" "$2"; exit 0; }
# 输出进 JSON 的动态值只允许安全字符，无需转义。
safe() { case "$1" in *[!A-Za-z0-9._:@/+-]*) return 1;; esac; return 0; }
addr() {
  a=${1#::ffff:}
  case "$a" in ''|*[!0-9A-Fa-f.:]*|127.*|::1|0.0.0.0|::) return 1;; esac
  printf '%s' "$a"
}
hash16() { printf '%s' "$1" | sha256sum | cut -c1-16; }

plan() {
  reason=null; can=false; already=false; category=''; iface=''; zone=''; rule=''; profiles=''; rich=''
  client=''; local=''
  set -- $conn
  if [ $# -ne 4 ]; then reason='"[direct:firewall] 无法从此 SSH 会话确定客户端来源地址，未生成放行计划。"'; build; return; fi
  client=$(addr "$1") || client=''
  local=$(addr "$3") || local=''
  if [ -z "$client" ] || [ -z "$local" ]; then client=''; local=''; reason='"[direct:firewall] SSH 来源或本地地址不适合生成精确的防火墙规则，请手动配置。"'; build; return; fi
  if command -v ip >/dev/null 2>&1; then
    iface=$(ip -o addr show 2>/dev/null | awk -v a="$local" '{ split($4, p, "/"); if (p[1] == a) { print $2; exit } }')
    safe "$iface" || iface=''
  fi
  family=ipv4; case "$local" in *:*) family=ipv6;; esac
  rule="QingCode-Agent-Direct-TCP-$port-$(hash16 "$port|$client|$local")"
  fw_installed=false
  if command -v firewall-cmd >/dev/null 2>&1; then
    fw_installed=true
    if [ "$(firewall-cmd --state 2>/dev/null)" = running ]; then
      category=firewalld
      [ -n "$iface" ] && zone=$(firewall-cmd --get-zone-of-interface="$iface" 2>/dev/null)
      [ -n "$zone" ] || zone=$(firewall-cmd --get-default-zone 2>/dev/null)
      if [ -z "$zone" ] || ! safe "$zone"; then zone=''; reason='"[direct:firewall] 无法确定接收 SSH 连接的 firewalld 区域，请手动配置。"'; build; return; fi
      profiles="\"$zone\""
      rich="rule family=\"$family\" source address=\"$client\" destination address=\"$local\" port port=\"$port\" protocol=\"tcp\" accept"
      if firewall-cmd --permanent --zone="$zone" --query-rich-rule="$rich" >/dev/null 2>&1 &&
         firewall-cmd --zone="$zone" --query-rich-rule="$rich" >/dev/null 2>&1; then already=true; fi
      can=true; build; return
    fi
  fi
  if command -v ufw >/dev/null 2>&1; then
    fw_installed=true
    status=$(ufw status 2>/dev/null) || { reason='"[direct:firewall] 无法读取 ufw 状态，请手动配置。"'; build; return; }
    case "$status" in
      'Status: active'*)
        category=ufw; profiles='"ufw"'
        if printf '%s\n' "$status" | awk -v l="$local" -v p="$port/tcp" -v c="$client" '$1 == l && $2 == p && $3 == "ALLOW" && ($4 == c || ($4 == "IN" && $5 == c)) { found = 1 } END { exit !found }'; then already=true; fi
        can=true; build; return;;
    esac
  fi
  # 已安装 firewalld/ufw 但都未启用：端口未被它们拦截，无需写规则。
  if [ "$fw_installed" = true ]; then
    category=inactive; profiles='"inactive"'; can=true; already=true; build; return
  fi
  reason='"[direct:firewall-unsupported] 未检测到 firewalld 或 ufw，请按说明手动配置防火墙。"'
  build
}

build() {
  shown=$rule
  [ -n "$rich" ] && shown=$(printf '%s' "$rich" | tr '"' "'")
  json="\"port\":$port,\"clientAddress\":\"$client\",\"localAddress\":\"$local\",\"networkCategory\":\"$category\",\"interfaceAlias\":\"$iface\",\"profiles\":[$profiles],\"ruleName\":\"$shown\",\"alreadyEnabled\":$already,\"canApply\":$can,\"reason\":$reason,\"account\":\"$account\""
}

if [ "$(id -u)" != 0 ]; then out_fail '[direct:firewall-admin]' '此 SSH 账户无法以 root 修改防火墙。'; fi
if safe "$login" && [ -n "$login" ]; then
  if [ "$login" = root ]; then account=root; else account="$login (sudo)"; fi
else
  account=root
fi
plan
hash=$(printf '%s\n%s' "$identity" "$json" | sha256sum | cut -d' ' -f1)
if [ "$apply" != 1 ]; then
  printf '{"ok":true,"value":{%s,"planSha256":"%s"}}\n' "$json" "$hash"
  exit 0
fi
[ "$hash" = "$expected" ] || out_fail '[direct:firewall-stale]' '防火墙状态或 SSH 来源已变化，请重新检查后确认。'
[ "$can" = true ] || out_fail '[direct:firewall]' '当前无法放行该端口，请重新检查。'
changed=false
if [ "$already" != true ]; then
  changed=true
  case "$category" in
    firewalld)
      firewall-cmd --permanent --zone="$zone" --add-rich-rule="$rich" >/dev/null 2>&1 &&
        firewall-cmd --zone="$zone" --add-rich-rule="$rich" >/dev/null 2>&1 ||
        out_fail '[direct:firewall]' 'firewalld 规则写入失败。'
      ;;
    ufw)
      ufw allow proto tcp from "$client" to "$local" port "$port" comment "QingCode Server TCP $port" >/dev/null 2>&1 ||
        out_fail '[direct:firewall]' 'ufw 规则写入失败。'
      ;;
    *) out_fail '[direct:firewall]' '当前防火墙类型不受支持。';;
  esac
  plan
  [ "$already" = true ] || out_fail '[direct:firewall]' '防火墙规则写入后校验失败。'
fi
printf '{"ok":true,"value":{"changed":%s,"ruleName":"%s","port":%s,"clientAddress":"%s","localAddress":"%s","profiles":[%s]}}\n' "$changed" "$shown" "$port" "$client" "$local" "$profiles"
