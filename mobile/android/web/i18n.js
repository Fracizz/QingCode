// Android 端国际化：仅中文（默认）与英文。以中文原文作为 key，英文缺失时回退中文。
// 语言偏好保存在手机 localStorage：auto 跟随系统语言，zh / en 为手动选择；切换后立即重译页面并重绘视图，不重新加载。
// 纯逻辑可在 Node 中导入（Vitest：src/lib/mobileAndroidI18n.test.ts）；app.js 启动时调用 initLocale 确定语言。

export const LOCALE_KEY = 'qingcode:mobile:locale';
export const LOCALE_CHOICES = Object.freeze(['auto', 'zh', 'en']);

/** 中文原文 → 英文；`{name}` 为占位符。也收录 Android 原生层与电脑端返回的常见错误。 */
export const EN = Object.freeze({
  // —— 工作台 ——
  '未连接': 'Not connected',
  '终端': 'Terminal',
  '项目': 'Projects',
  '连接': 'Connections',
  '接回会话，继续手边的工作。': 'Resume a session and pick up where you left off.',
  '重连': 'Reconnect',
  '继续终端': 'Continue terminal',
  '连接一台 QingCode': 'Connect to QingCode',
  '配对电脑后，就能在这里打开远程终端。': 'Pair a computer to open remote terminals here.',
  '添加连接': 'Add connection',
  '从其他项目打开终端': 'Open a terminal from another project',
  '最近打开': 'Recently opened',
  '全部项目': 'All projects',
  '还没有最近打开的项目，可从全部项目中选择。': 'No recent projects yet. Pick one from All projects.',
  '开启电脑连接': 'Enable desktop connection',
  '电脑端设置 → 功能 → Android 移动连接': 'Desktop Settings → Features → Android mobile connection',
  '扫码配对': 'Scan to pair',
  '扫描电脑上的二维码，输入连接密码。': 'Scan the QR code on the computer and enter the connection password.',
  '继续工作': 'Keep working',
  '选择项目，接回终端或新建会话。': 'Pick a project, then resume a terminal or start a new session.',
  '选择要控制的 QingCode 电脑。': 'Choose the QingCode computer to control.',
  '添加': 'Add',
  '暂无已配对电脑': 'No paired computers',
  '在电脑端「设置 → 功能 → Android 移动连接」启用后，点「添加」扫描二维码。': 'Enable "Settings → Features → Android mobile connection" on the computer, then tap "Add" to scan the QR code.',
  '刷新项目': 'Refresh projects',
  '正在读取项目': 'Loading projects',
  '搜索 IP、项目名或路径': 'Search IP, project name, or path',
  '主导航': 'Main navigation',
  '已配对': 'Paired',
  '连接中…': 'Connecting…',
  '已连接': 'Connected',
  '连接失败': 'Connection failed',
  '需要重新配对': 'Re-pairing required',
  '管理连接 {name}': 'Manage connection {name}',
  ' · 当前电脑': ' · Current computer',
  '切换连接，当前为 {name}': 'Switch connection, current: {name}',
  '管理连接': 'Manage connections',
  '{n} 个已信任项目 · 可以打开终端': '{n} trusted projects · Ready for terminals',
  '正在读取项目…': 'Loading projects…',
  '电脑暂时不可达': 'Computer unreachable',
  '配对已失效': 'Pairing expired',
  '等待连接': 'Waiting to connect',
  '正在连接电脑': 'Connecting to computer',
  '正在读取已信任的项目。': 'Loading trusted projects.',
  '查看连接': 'View connections',
  '检查手机和电脑的网络后重试。': 'Check the phone and computer network, then try again.',
  '重新连接': 'Reconnect',
  '请在电脑端重新启用 Android 移动连接。': 'Re-enable Android mobile connection on the computer.',
  '重新配对': 'Pair again',
  '打开终端': 'Open a terminal',
  '选择已信任的项目，接回已有会话或启动 Shell。': 'Pick a trusted project to resume a session or start a shell.',
  '选择项目': 'Choose project',
  '选择一台电脑': 'Choose a computer',
  '从已配对的电脑进入终端。': 'Open a terminal from a paired computer.',
  '{name} · 已信任项目': '{name} · Trusted projects',
  '请先在「连接」中配对电脑。': 'Pair a computer in "Connections" first.',
  '{n} 个项目': '{n} projects',
  '没有匹配的项目': 'No matching projects',
  '没有已信任的项目': 'No trusted projects',
  '先连接一台电脑': 'Connect a computer first',
  '暂无可用项目': 'No projects available',
  '配对后即可查看电脑上的已信任项目。': 'After pairing, trusted projects on the computer appear here.',
  '试试其他关键词，或清除搜索查看全部项目。': 'Try other keywords, or clear the search to see all projects.',
  '在电脑端添加并信任项目，再回到这里刷新。': 'Add and trust a project on the computer, then refresh here.',
  '检查电脑连接后重新读取项目。': 'Check the computer connection, then reload projects.',
  '前往连接': 'Go to connections',
  '清除搜索': 'Clear search',
  '重新读取': 'Reload',
  '本机': 'Local',
  '远端': 'Remote',
  '语言 / Language': 'Language',
  '中文': '中文', // 语言名保持原文
  // data-i18n：同一中文在不同位置需要不同英文时使用的专用 key。
  'action:connect': 'Connect',
  'state:off': 'Off',
  '跟随系统': 'System', // 三段选择里需短词，避免窄屏截断
  '切换后立即生效': 'Takes effect immediately',
  // —— 设置页 ——
  '设置': 'Settings',
  '打开设置': 'Open settings',
  '只保存在这台手机上，对所有连接和终端生效。': 'Saved on this phone only and applied to every connection and terminal.',
  '通用': 'General',
  '发送与图片': 'Sending and images',
  '提醒与渲染': 'Alerts and rendering',
  '更多设置': 'More settings',
  '语言、图片压缩、发送按键、后台提醒等': 'Language, image compression, send key, background alerts and more',
  '打开': 'Open',

  // —— 终端 ——
  '打开会话侧栏': 'Open session drawer',
  '收起会话侧栏': 'Collapse session sidebar',
  '新建终端': 'New terminal',
  '终端设置': 'Terminal settings',
  '终端输出': 'Terminal output',
  '历史输出（只读）': 'Output history (read-only)',
  '向上滚动加载更早输出': 'Scroll up to load earlier output',
  '加载更早输出': 'Load earlier output',
  '此项目还没有终端': 'This project has no terminals yet',
  '回到最新': 'Jump to latest',
  '重试': 'Retry',
  '↑↓ 选择 · ↵ 确认': '↑↓ Select · ↵ Confirm',
  '草稿': 'Draft',
  '直发': 'Direct',
  '手机到电脑往返延迟': 'Phone-to-computer round trip',
  '电脑 --': 'PC --',
  '终端列数和行数': 'Terminal columns and rows',
  '收起按键': 'Hide keys',
  '展开按键': 'Show keys',
  '终端操作菜单': 'Terminal menu',
  '先在手机编辑，点发送才提交；点键盘按钮切到': ' is edited on the phone and submitted only when you tap Send. Tap the keyboard button to switch to ',
  '，按键立即发给终端。在输入框上左右拖动可移动光标，双指缩放终端可调字号。': ', where keys go straight to the terminal. Drag left or right on the input to move the cursor; pinch the terminal to change the font size.',
  '知道了': 'Got it',
  'AI 编程快捷键': 'AI coding shortcuts',
  '发送 Ctrl+C': 'Send Ctrl+C',
  '发送 Shift+Tab': 'Send Shift+Tab',
  '向上': 'Up',
  '向下': 'Down',
  '退格': 'Backspace',
  '输入斜杠命令': 'Type a slash command',
  '斜杠命令': 'Slash command',
  '/命令': '/cmd',
  '向左': 'Left',
  '向右': 'Right',
  '更多': 'More',
  '命令输入': 'Command input',
  '打开实时输入键盘': 'Open live input keyboard',
  '选择图片插入草稿，可多选': 'Insert images into the draft (multiple allowed)',
  '输入终端命令': 'Enter a terminal command',
  '输入命令…': 'Enter a command…',
  '发送回车': 'Send Enter',
  '发送': 'Send',
  '命令栏可编辑中文 · 空白发送为回车': 'The command bar supports IME input · Sending empty sends Enter',
  '会话中': 'In session',
  '输入提交结果未知，请检查终端输出。': 'Input result unknown. Check the terminal output.',
  '电脑 {value}': 'PC {value}',
  '手机到电脑往返延迟 {value}': 'Phone-to-computer round trip {value}',
  ' · 电脑 {value}': ' · PC {value}',
  '延迟仅检测当前连接的电脑。': 'Latency is measured only for the current computer.',
  '尚未测量。': 'Not measured yet. ',
  '本次检测未获得结果。': 'The last check returned no result. ',
  '结果已过期，等待更新。': 'Result is stale, waiting for an update. ',
  '当前电脑端不支持延迟检测，请更新电脑端 QingCode。': 'This computer does not support latency checks. Update QingCode on the computer. ',
  '最近测量 {time}。': 'Last measured {time}. ',
  '手机到电脑往返延迟：{value}。': 'Phone-to-computer round trip: {value}. ',
  '不包含电脑到远端及终端程序处理耗时。': 'Excludes computer-to-remote time and terminal program processing.',
  '切回草稿输入': 'Switch back to draft input',
  '切换为直发：按键立即发给终端': 'Switch to direct: keys go straight to the terminal',
  '终端实时输入 · 按键直接发送 · ⌫ 删除远端文字 · ↵ 确认': 'Live terminal input · Keys sent directly · ⌫ deletes remote text · ↵ confirms',
  '命令输入 · 空白发送回车 · ⌫ 编辑本地文字 · 斜杠命令先查看候选': 'Command input · Empty send is Enter · ⌫ edits local text · Slash commands show suggestions first',
  '终端实时输入': 'Live terminal input',
  '编辑目标：{target}': 'Editing target: {target}',
  '编辑目标：手机草稿': 'Editing target: Phone draft',
  '手机草稿': 'Phone draft',
  '直发中 · 按键立即发给终端': 'Direct · Keys go straight to the terminal',
  '草稿 · 编辑后点发送': 'Draft · Edit, then tap Send',
  '手机保存失败，请复制并保留原文。': 'Saving on the phone failed. Copy and keep the text.',
  '发送中': 'Sending',
  '电脑已接收': 'Received by computer',
  '提交结果未知': 'Result unknown',
  '本项目其他会话草稿': 'Draft from another session in this project',
  '本项目其他会话提交 · {state}': 'Submission from another session · {state}',
  '结果未知': 'Unknown',
  '原文已复制': 'Text copied',
  '确认终端中的选择或命令': 'Confirm the selection or command in the terminal',
  '查看命令或技能候选，不发送回车': 'Show command or skill suggestions without Enter',
  '发送并回车': 'Send and press Enter',
  '确认': 'Confirm',
  '候选': 'Suggest',
  '先查看候选，再确认': 'Review suggestions, then confirm',
  '此全屏程序未开启鼠标滚动，可用 PgUp / PgDn 翻页': 'This full-screen program has no mouse scrolling; use PgUp / PgDn',
  '会话已切换': 'Session switched',
  '终端中为 {url}': 'In terminal: {url}',
  '链接已复制': 'Link copied',
  '字号 {size}px': 'Font size {size}px',
  '正在连接终端…': 'Connecting to terminal…',
  '暂无终端': 'No terminals',
  '需先在电脑上信任': 'Trust it on the computer first',
  '请先在电脑上新建一次「{name}」终端并选择「信任此配置」。': 'On the computer, create a "{name}" terminal once and choose "Trust this profile".',
  '无法读取电脑端终端配置，已仅显示普通终端。': 'Could not read terminal profiles from the computer; showing the default terminal only.',
  '正在接入终端…': 'Attaching to terminal…',
  '[较早的输出已超出电脑端缓存]': '[Earlier output exceeds the computer cache]',
  '有新输出 · 回到最新': 'New output · Jump to latest',
  '电脑到远端的终端连接已中断': 'The computer lost its terminal connection to the remote host',
  '会话已结束 · 退出码 {code}': 'Session ended · Exit code {code}',
  '原会话已不存在 · 草稿保留，可新建终端恢复': 'Original session is gone · Draft kept; create a new terminal to restore it',
  '连接中断，正在接回会话…': 'Connection lost, reattaching…',
  '输入过长，请分段粘贴。': 'Input too long. Paste it in parts.',
  '正在新建终端…': 'Creating terminal…',
  '移除会话？': 'Remove session?',
  '关闭会话？': 'Close session?',
  '「{name}」的输出将从列表中移除。': 'Output of "{name}" will be removed from the list.',
  '「{name}」中的 Shell 和前台任务将被关闭。': 'The shell and foreground tasks in "{name}" will be closed.',
  '移除': 'Remove',
  '关闭': 'Close',
  '结束全部会话？': 'End all sessions?',
  '将结束「{host} / {project}」的全部 {n} 个手机会话，关闭其中的 Shell 和前台任务，并移除会话输出。其他项目和桌面终端不受影响。': 'All {n} phone sessions in "{host} / {project}" will end, closing their shells and foreground tasks and removing their output. Other projects and desktop terminals are not affected.',
  '结束全部': 'End all',
  '正在结束全部会话…': 'Ending all sessions…',
  '已结束 {ended} 个会话，{failed} 个未确认结束，请核对后重试。': 'Ended {ended} sessions; {failed} not confirmed. Check and try again.',
  '电脑端不支持图片上传，请更新电脑端 QingCode。': 'The computer does not support image upload. Update QingCode on the computer.',
  '正在上传…': 'Uploading…',
  '图片上传中…': 'Uploading image…',
  '图片上传中… {index}/{count}': 'Uploading images… {index}/{count}',
  '✓ 图片已插入': '✓ Image inserted',
  '✓ 已插入 {n} 张图片': '✓ Inserted {n} images',
  '⚠ 图片上传失败': '⚠ Image upload failed',
  '已插入 {inserted}/{count} 张图片。{error} 请重新选择剩余未上传的图片。': 'Inserted {inserted}/{count} images. {error} Select the remaining images again.',
  '选择图片': 'Choose images',
  '⚠ 手机保存失败': '⚠ Phone save failed',
  '正在发送…': 'Sending…',
  '✓ 电脑已接收 · 查看': '✓ Received · View',
  '⚠ 结果未知 · 查看': '⚠ Unknown · View',
  '手机保存失败，请保留原文': 'Phone save failed; keep the text',
  '正在发送': 'Sending',
  '电脑已接收，查看提交原文': 'Received by computer; view the submitted text',
  '提交结果未知，原文已保留，点按查看': 'Result unknown; text kept, tap to view',
  '全屏画面': 'Full-screen view',
  '刷新内容': 'Refresh',
  '刷新内容（有新输出）': 'Refresh (new output)',
  '（最多 500 处）': ' (max 500)',
  '未找到': 'Not found',
  '只读快照': 'Read-only snapshot',
  '此范围暂无输出': 'No output in this range',
  '输出已复制': 'Output copied',
  '终端 {n}': 'Terminal {n}',
  '未命名配置': 'Untitled profile',
  '普通终端': 'Default terminal',
  '不到 1 分钟': 'under 1 min',
  '{n} 分钟': '{n} min',
  '{h} 小时 {m} 分': '{h} h {m} min',
  '{h} 小时': '{h} h',
  '自动结束': 'auto-ends',
  '刚刚有活动': 'Active just now',
  '空闲 {time}': 'Idle {time}',
  '即将{action}': '{action} soon',
  '{time}后{action}': '{action} in {time}',
  '，': ', ',
  '切换到 {name}': 'Switch to {name}',
  '已结束': 'Ended',
  '运行中': 'Running',
  '当前会话': 'Current',
  '可接入': 'Available',
  '已置顶': 'Pinned',
  '{name} 的更多操作': 'More actions for {name}',
  '移除 {name}': 'Remove {name}',
  '关闭 {name}': 'Close {name}',
  '取消置顶': 'Unpin',
  '置顶': 'Pin',
  '重命名': 'Rename',
  '重命名（需更新电脑端）': 'Rename (update the computer app)',
  '移除已结束会话': 'Remove ended session',
  '结束当前会话': 'End current session',
  '结束会话': 'End session',
  '在快捷键栏显示 {name}': 'Show {name} in the shortcut bar',
  '{name} · 在「更多」中': '{name} · In "More"',
  '上移 {name}': 'Move {name} up',
  '下移 {name}': 'Move {name} down',
  '正在加载历史…': 'Loading history…',
  '继续向上翻看历史': 'Keep scrolling up for more history',
  '更早输出已超出电脑端缓存': 'Earlier output exceeds the computer cache',
  '已到保留历史起点': 'Reached the start of saved history',
  '重试加载历史': 'Retry loading history',
  '向上翻一页': 'Page up',
  '按住上下拖动滚动，松手停止': 'Hold and drag up or down to scroll; release to stop',
  '向下翻一页': 'Page down',
  '无法识别的链接，可复制后查看。': 'Unrecognized link. Copy it to view.',
  '这是远端主机上的本地地址，手机无法直接访问。可复制后在远端或通过端口转发打开。': 'This is a local address on the remote host and cannot be opened from the phone. Copy it and open it on the remote host or through port forwarding.',
  '这是电脑上的本地地址，手机无法直接访问。': 'This is a local address on the computer and cannot be opened from the phone.',
  '已换成电脑地址。开发服务需监听局域网（例如 --host 0.0.0.0）且电脑防火墙放行该端口，手机才能打开。': 'Rewritten to the computer address. The dev server must listen on the LAN (e.g. --host 0.0.0.0) and the firewall must allow the port.',
  '终端文字选择': 'Terminal text selection',
  '调整选区起点': 'Adjust selection start',
  '调整选区终点': 'Adjust selection end',
  '复制': 'Copy',
  '已复制': 'Copied',
  '添加到对话': 'Add to Conversation',
  '全选': 'Select all',
  '取消': 'Cancel',
  '复制失败，请重试': 'Copy failed. Try again.',

  // —— 配对与连接 ——
  '打开电脑端「设置 → 功能 → Android 移动连接」，用手机扫描其中的二维码。': 'Open "Settings → Features → Android mobile connection" on the computer and scan its QR code with this phone.',
  '扫码添加': 'Scan QR code',
  '粘贴配对链接': 'Paste pairing link',
  '已从配对链接读取地址和证书指纹，连接时自动核对。': 'Address and certificate fingerprint read from the pairing link; they are verified on connect.',
  '连接名称': 'Connection name',
  'IPv4 地址': 'IPv4 address',
  '端口': 'Port',
  '连接密码': 'Connection password',
  '例如 工作电脑': 'e.g. Work PC',
  '6–20 位密码': '6–20 character password',
  '核对电脑身份': 'Verify computer identity',
  '请逐位核对电脑端显示的 SHA-256 指纹。': 'Compare every character with the SHA-256 fingerprint shown on the computer.',
  '指纹一致': 'Fingerprints match',
  '连接详情': 'Connection details',
  '电脑端切换端口后，在这里改为新端口即可，无需重新配对。': 'If the computer changes its port, update it here; no re-pairing needed.',
  '保存': 'Save',
  '移除连接': 'Remove connection',
  '扫描配对二维码': 'Scan pairing QR code',
  '将电脑端二维码完整放在画面中央，稍等相机对焦；若模糊，请稍微拉远手机。': 'Center the whole QR code in the frame and wait for focus. If it is blurry, move the phone back a little.',
  '相机预览': 'Camera preview',
  '这不是 QingCode 配对链接。': 'This is not a QingCode pairing link.',
  '剪贴板中没有 QingCode 配对链接。': 'No QingCode pairing link in the clipboard.',
  '需要相机权限才能扫码。也可以粘贴电脑端复制的配对链接。': 'Camera permission is required to scan. You can also paste the pairing link copied on the computer.',
  '需要相机权限才能扫码。也可以取消后粘贴配对链接。': 'Camera permission is required to scan. You can also cancel and paste the pairing link.',
  '无法打开相机。': 'Cannot open the camera.',
  '无法加载扫码组件，请取消后重试，或粘贴电脑端复制的配对链接。': 'Could not load the scanner. Cancel and try again, or paste the pairing link copied on the computer.',
  '暂时无法识别，请调整距离和光线后重试。': 'Not recognized yet. Adjust distance and lighting, then try again.',
  '请输入连接名称。': 'Enter a connection name.',
  '请输入有效的电脑 IPv4 地址和端口。': 'Enter a valid computer IPv4 address and port.',
  '密码须为 6–20 位，可使用数字、英文字母或符号，无需组合。': 'Password must be 6–20 characters: digits, letters, or symbols in any mix.',
  '电脑证书与二维码中的指纹不一致，已停止配对。请确认地址，或在电脑端重新生成二维码。': 'The computer certificate does not match the QR code fingerprint, so pairing stopped. Check the address or regenerate the QR code on the computer.',
  '电脑证书已变化，已停止配对。请重新扫描电脑端二维码或粘贴配对链接。': 'The computer certificate changed, so pairing stopped. Scan the QR code again or paste the pairing link.',
  '端口须为 1–65535 之间的整数。': 'Port must be an integer between 1 and 65535.',
  '移除 {name}？': 'Remove {name}?',
  '此操作会删除手机上保存的配对。要撤销电脑端授权，请在电脑端停止移动连接。': 'This deletes the pairing saved on the phone. To revoke access on the computer, stop the mobile connection there.',
  '配对链接版本不受支持，请升级 QingCode Android。': 'Unsupported pairing link version. Update QingCode Android.',
  '配对链接中的地址无效。': 'The pairing link has an invalid address.',
  '配对链接中的证书指纹无效。': 'The pairing link has an invalid certificate fingerprint.',
  '电脑端移动协议不兼容，请更新电脑端和 Android APK。': 'Incompatible mobile protocol. Update both the computer app and the Android APK.',
  '连接失败。': 'Connection failed.',
  '请求超时，操作结果未知，请核对电脑端；不会自动重发。': 'Request timed out; the result is unknown. Check the computer. It will not be resent automatically.',

  // —— 弹层 ——
  '更多按键': 'More keys',
  '已从快捷键栏隐藏': 'Hidden from the shortcut bar',
  '编辑与终端按键': 'Editing and terminal keys',
  '@引用': '@mention',
  '输入 @ 引用': 'Type an @ mention',
  '删词': 'Del word',
  '删至行首': 'Del to start',
  '清除输入': 'Clear input',
  '清除终端当前输入': 'Clear the current terminal input',
  '清空草稿': 'Clear draft',
  '换行': 'Newline',
  '插入换行': 'Insert newline',
  '「清除输入」清除终端当前行尚未提交的文字；「清空草稿」只清手机命令栏。按键由当前程序处理。Esc 取消或中断，不删除文字；Ctrl+C 也可能退出程序。': '"Clear input" clears unsubmitted text on the current terminal line; "Clear draft" only clears the phone command bar. Keys are handled by the current program. Esc cancels or interrupts without deleting text; Ctrl+C may also exit the program.',
  '返回': 'Back',
  '终端会话': 'Terminal sessions',
  '关闭会话侧栏': 'Close session drawer',
  '项目会话': 'Project sessions',
  '更新电脑端后可重命名会话。': 'Update the computer app to rename sessions.',
  '返回工作台': 'Back to dashboard',
  '关闭全部会话': 'Close all sessions',
  // —— 会话纵览 ——
  '会话范围': 'Session scope',
  '本项目': 'This project',
  '全部': 'All',
  '更新电脑端后可查看全部项目的会话。': 'Update the computer app to see sessions from all projects.',
  '搜索会话、项目或设备': 'Search sessions, projects, or devices',
  '会话状态': 'Session status',
  '未结束': 'Active',
  '没有符合条件的会话': 'No matching sessions',
  '这台电脑上还没有手机会话': 'No phone sessions on this computer yet',
  '当前项目': 'Current project',
  '电脑端已移除': 'Removed on computer',
  '来自 {device}': 'From {device}',
  '其他设备': 'another device',
  '电脑端已没有项目「{name}」，只能关闭其中的会话。': 'The computer no longer has project "{name}". You can only close its sessions.',
  '全部会话': 'All sessions',
  '管理': 'Manage',
  '已选 {n}': '{n} selected',
  '全选 {n}': 'Select all {n}',
  '取消全选': 'Clear selection',
  '选已结束': 'Select ended',
  '关闭所选': 'Close selected',
  '选择 {name}': 'Select {name}',
  '展开全部（还有 {n} 个）': 'Show all ({n} more)',
  '上次使用': 'Last used',
  '该会话由 {device} 创建。': ' It was started from {device}.',
  '关闭 {n} 个会话？': 'Close {n} sessions?',
  '将关闭 {n} 个运行中会话的 Shell 和前台任务。': 'This closes the shell and foreground tasks of {n} running sessions. ',
  '其中 {n} 个由其他设备创建。': '{n} of them were started from other devices. ',
  '将移除 {n} 个已结束会话的输出。': 'This removes the output of {n} ended sessions. ',
  '涉及 {n} 个项目。': 'Affects {n} projects.',
  '关闭 {n} 个': 'Close {n}',
  '已关闭 {ended} 个会话，{failed} 个未确认关闭，请核对后重试。': 'Closed {ended} sessions; {failed} could not be confirmed. Check and try again.',
  '会话操作': 'Session actions',
  '置顶只保存在这台手机上，不改变电脑端终端顺序。': 'Pins are saved on this phone only and do not change the order on the computer.',
  '重命名会话': 'Rename session',
  '会话名称': 'Session name',
  '手动名称优先。留空保存后恢复跟随程序标题。': 'A manual name takes priority. Save it empty to follow the program title again.',
  '终端列宽': 'Terminal width',
  '适应屏幕': 'Fit screen',
  '固定 80 列': 'Fixed 80 columns',
  '固定 100 列': 'Fixed 100 columns',
  '固定列宽时可横向滚动，旋转和键盘弹出只改变可见高度。': 'With a fixed width you can scroll sideways; rotation and the keyboard only change the visible height.',
  '全屏程序中的触摸': 'Touch in full-screen programs',
  '点按只聚焦': 'Tap only focuses',
  '防误触，不向程序发送点击': 'Prevents accidental clicks; no clicks are sent',
  '点按发给程序': 'Send taps to the program',
  '点按会作为鼠标点击': 'Taps are sent as mouse clicks',
  '手指上下滑动始终滚动原始终端：普通终端滚动输出记录，Codex、OpenCode 等全屏程序由程序自己滚动。这里只决定点按是否作为鼠标点击发给程序。实体鼠标不受影响。': 'Swiping up or down always scrolls the terminal itself: regular terminals scroll their output, and full-screen programs such as Codex or OpenCode scroll on their own. This only decides whether taps are sent as mouse clicks. Physical mice are not affected.',
  '终端字号': 'Terminal font size',
  '仅调整手机显示，也可在终端上双指缩放': 'Phone display only; you can also pinch the terminal',
  '缩小终端字号': 'Decrease terminal font size',
  '放大终端字号': 'Increase terminal font size',
  '快捷键栏': 'Shortcut bar',
  '调整常用键顺序，隐藏的键移到「更多」': 'Reorder common keys; hidden keys move to "More"',
  '调整': 'Adjust',
  '图片压缩': 'Image compression',
  '原图 · 不压缩': 'Original · No compression',
  '低压缩 · 更清晰': 'Low · Sharper',
  '中压缩 · 推荐': 'Medium · Recommended',
  '高压缩 · 更小': 'High · Smaller',
  '自动保存，下次发图直接使用。原图保留 PNG / JPEG 文件；HEIC / HEIF 需要系统支持解码，原图模式保留分辨率并转换格式。单张上传最大 8 MB，超出时请选择压缩。': 'Saved automatically for future images. Original keeps PNG / JPEG files; HEIC / HEIF needs system decoding support and is converted at full resolution. Each upload is limited to 8 MB; choose compression for larger images.',
  '发送按键': 'Send button',
  '默认 · 文字与回车一起发送': 'Default · Send text with Enter',
  '发送并直接 Enter': 'Send, then press Enter',
  '「发送并直接 Enter」等待文字发送成功后再单独发送回车；/命令也会提交。是否执行由当前终端程序决定。': '"Send, then press Enter" waits until the text is delivered, then sends Enter separately; /commands are submitted too. Whether it runs is up to the terminal program.',
  '新建会话': 'New session',
  '终端配置': 'Terminal profiles',
  '选项来自电脑端「设置 → 终端 → 终端配置」；启动命令在当前项目环境（本机、WSL 或远端）中执行。': 'Options come from "Settings → Terminal → Terminal profiles" on the computer; startup commands run in the project environment (local, WSL, or remote).',
  '图片未能上传': 'Images not uploaded',
  '可重新选择未上传的图片；压缩等级在设置中调整。已插入的图片会保留在草稿中。': 'Select the remaining images again; change compression in Settings. Inserted images stay in the draft.',
  '终端操作': 'Terminal actions',
  '展开编辑指令': 'Expand editor',
  '最近提交与项目草稿': 'Recent submissions and drafts',
  '阅读与搜索输出': 'Read and search output',
  '会话列表': 'Sessions',
  '返回项目列表': 'Back to projects',
  '编辑指令': 'Edit instruction',
  '收起': 'Collapse',
  '完整指令': 'Full instruction',
  '输入需求、代码或日志；回车换行': 'Enter requirements, code, or logs; Enter adds a newline',
  '草稿保存在手机，输入法回车只换行。图片上传后的路径会加入指令。': 'Drafts are saved on the phone; the keyboard Enter only adds a newline. Uploaded image paths are added to the instruction.',
  '添加图片': 'Add images',
  '提交与草稿': 'Submissions and drafts',
  '“电脑已接收”表示终端收到输入。结果未知时先核对输出，内容不会自动重发。': '"Received by computer" means the terminal got the input. If the result is unknown, check the output first; nothing is resent automatically.',
  '保留的原文': 'Saved text',
  '此会话暂无提交记录或其他项目草稿': 'No submissions in this session and no drafts from other sessions',
  '复制原文': 'Copy text',
  '加入当前草稿': 'Add to current draft',
  '输出阅读': 'Output reader',
  '阅读范围': 'Range',
  '当前终端缓存': 'Current terminal buffer',
  '已加载历史': 'Loaded history',
  '搜索此页内容': 'Search this page',
  '搜索输出': 'Search output',
  '上一个匹配': 'Previous match',
  '下一个匹配': 'Next match',
  '自动换行': 'Wrap lines',
  '只读快照，最多保留末尾 60 万字符。实时输出不会改变阅读位置；刷新后才更新。': 'Read-only snapshot of up to the last 600,000 characters. Live output does not move your position; refresh to update.',
  '只读输出': 'Read-only output',
  '勾选的键显示在终端底部，按这里的顺序排列；取消勾选的键移到「更多」顶部。「更多」按钮固定在最右侧。只保存在这台手机上。': 'Checked keys appear at the bottom of the terminal in this order; unchecked keys move to the top of "More". The "More" button stays at the far right. Saved on this phone only.',
  '快捷键顺序与显示': 'Shortcut order and visibility',
  '恢复默认': 'Reset',
  '完成': 'Done',
  '终端链接': 'Terminal link',
  '复制链接': 'Copy link',
  '在浏览器打开': 'Open in browser',

  // —— 鼠标模式 ——
  '鼠标': 'Mouse',
  '鼠标模式': 'Mouse mode',
  '退出鼠标模式': 'Exit mouse mode',
  '鼠标模式：拖动鼠标移动指针，按住左键滑动选中，右键打开菜单；点「鼠标」退出': 'Mouse mode: drag the mouse to move the pointer, slide on the left button to select, tap the right button for a menu; tap "Mouse" to exit',
  '发送右键': 'Send right click',
  '鼠标左键': 'Left click',
  '鼠标右键': 'Right click',
  '拖动以移动鼠标指针': 'Drag to move the pointer',
  '选中': 'Select',
  '粘贴': 'Paste',
  '剪贴板为空': 'Clipboard is empty',
  '已退出鼠标模式': 'Mouse mode off',

  // —— 在线更新 ——
  '应用更新': 'App updates',
  '检查更新': 'Check for updates',
  '每天自动检查更新': 'Check for updates daily',
  '发现新版本': 'Update available',
  '点按查看更新内容并安装': 'Tap to see what is new and install',
  '安装包来自 GitHub / Gitee 发布页，安装前核对签名与版本；需要在系统中允许 QingCode 安装应用。': 'Packages come from the GitHub / Gitee release pages; the signature and version are checked before install. Allow QingCode to install apps in system settings.',
  '跳过此版本': 'Skip this version',
  '下载并安装': 'Download and install',
  '在浏览器查看': 'View in browser',
  '稍后': 'Later',
  '更新说明': 'Release notes',
  ' · 测试版': ' · Beta',
  '新版本 {version}，当前 {current}': 'Version {version} (current {current})',
  '此版本没有更新说明。': 'No release notes for this version.',
  '取消下载': 'Cancel download',
  '安装': 'Install',
  '当前版本 {version}': 'Current version {version}',
  '正在检查更新…': 'Checking for updates…',
  '发现新版本 {version}': 'Version {version} is available',
  '已是最新版本。': 'You are on the latest version.',
  '正在准备下载…': 'Preparing download…',
  '正在下载 {percent}% · {received} / {total}': 'Downloading {percent}% · {received} / {total}',
  '正在下载 {received}': 'Downloading {received}',
  '正在打开系统安装…': 'Opening the system installer…',
  '请在系统设置中允许 QingCode 安装应用，返回后点「安装」。': 'Allow QingCode to install apps in system settings, then come back and tap "Install".',
  '下载完成，安装包已通过校验。': 'Download complete; the package passed verification.',
  '已取消下载。': 'Download canceled.',
  '请在系统界面确认安装。': 'Confirm the installation in the system dialog.',
  '安装完成，请重新打开 QingCode。': 'Installed. Reopen QingCode.',
  '已跳过 {version}，可随时手动检查更新。': 'Skipped {version}. You can check for updates manually at any time.',
  '更新地址不受信任，已停止下载。': 'Untrusted update address; download stopped.',
  '已有更新正在下载。': 'An update is already downloading.',
  '无法保存更新包。': 'Cannot save the update package.',
  '下载失败，请检查网络后重试。': 'Download failed. Check the network and try again.',
  '下载的安装包无效，请重新下载。': 'The downloaded package is invalid. Download it again.',
  '安装包不属于 QingCode，已拒绝安装。': 'The package is not QingCode; installation refused.',
  '安装包版本不高于当前版本，无需更新。': 'The package is not newer than the installed version.',
  '安装包签名与当前应用不一致，已拒绝安装。': 'The package signature does not match this app; installation refused.',
  '更新包已失效，请重新下载。': 'The update package expired. Download it again.',
  '无法打开系统安装设置，请在系统设置中允许 QingCode 安装应用。': 'Cannot open install settings. Allow QingCode to install apps in system settings.',
  '无法启动系统安装，请重新下载后重试。': 'Cannot start the system installer. Download again and retry.',
  '无法打开系统安装确认，请重试。': 'Cannot open the install confirmation. Try again.',
  '已取消安装。': 'Installation canceled.',
  '安装失败，请重新下载后重试。': 'Installation failed. Download again and retry.',
  '无法连接 GitHub 或 Gitee 检查更新，请检查网络后重试。': 'Cannot reach GitHub or Gitee to check for updates. Check the network and try again.',
  '更新地址跳转过多，已停止下载。': 'Too many redirects; download stopped.',
  '更新包大小异常，已停止下载。': 'Unexpected package size; download stopped.',
  '更新包下载不完整，请重试。': 'The package download is incomplete. Try again.',

  // —— Android 原生层返回的错误 ——
  '读取图片选择失败。': 'Failed to read the selected images.',
  '无法读取图片': 'Cannot read the image',
  '图片不能超过 8 MB': 'Images cannot exceed 8 MB',
  '图片分辨率过大，请在设置中启用图片压缩。': 'Image resolution is too high. Enable image compression in Settings.',
  '系统无法解码此图片；HEIC / HEIF 需要手机支持，请先转换为 JPEG 后重试。': 'The system cannot decode this image. HEIC / HEIF needs phone support; convert it to JPEG and try again.',
  '图片解码失败': 'Image decoding failed',
  '转换后的图片超过 8 MB，请在设置中提高图片压缩等级。': 'The converted image exceeds 8 MB. Raise the compression level in Settings.',
  '请求失败。': 'Request failed.',
  '请求过大。': 'Request too large.',
  '请求无效。': 'Invalid request.',
  '仅支持打开 HTTP / HTTPS 网页链接。': 'Only HTTP / HTTPS links can be opened.',
  '无法打开链接，请复制后在浏览器中访问。': 'Cannot open the link. Copy it and open it in a browser.',
  '请先完成当前图片选择。': 'Finish the current image selection first.',
  '无法打开系统图片选择器。': 'Cannot open the system image picker.',
  '图片选择已失效，请重新选择。': 'The image selection expired. Select again.',
  '无法打开手机剪贴板。': 'Cannot open the phone clipboard.',
  '复制失败，请重试。': 'Copy failed. Try again.',
  '内存不足，请选择较小图片或提高压缩等级。': 'Out of memory. Choose a smaller image or raise the compression level.',
  '连接超时，请确认电脑在线并允许局域网访问。': 'Connection timed out. Make sure the computer is online and allows LAN access.',
  'Windows 身份校验失败，请重新核对证书指纹。': 'Windows identity check failed. Verify the certificate fingerprint again.',
  '连接名称须为 1–48 个字符。': 'Connection name must be 1–48 characters.',
  '请先完成密码配对。': 'Complete password pairing first.',
  '已存在使用该地址和端口的连接。': 'A connection with this address and port already exists.',
  '未知操作。': 'Unknown operation.',
  '证书指纹格式无效。': 'Invalid certificate fingerprint format.',
  '请输入有效的 Windows IPv4 地址和端口。': 'Enter a valid Windows IPv4 address and port.',
  'Windows IPv4 地址无效。': 'Invalid Windows IPv4 address.',
  'Windows 响应过大。': 'Windows response too large.',
  '电脑端无法识别图片上传请求，请更新并重启电脑端 QingCode 后重试；仅更新 Android APK 不够。': 'The computer does not recognize image upload requests. Update and restart QingCode on the computer; updating only the Android APK is not enough.',
  '电脑延迟响应无效。': 'Invalid latency response from the computer.',
  '请求已取消或超时，操作结果未知，请核对电脑端。': 'Request canceled or timed out; the result is unknown. Check the computer.',
  '应用已关闭。': 'The app was closed.',
  '请求队列已满或应用已关闭，请稍后重试。': 'The request queue is full or the app was closed. Try again later.',
  '请求已取消，操作结果未知，请核对电脑端。': 'Request canceled; the result is unknown. Check the computer.',

  // —— 电脑端返回的错误 ——
  'Windows QingCode 未及时响应。若电脑上弹出确认（如远端主机指纹），请在电脑上处理后重试。': 'Windows QingCode did not respond in time. If the computer shows a prompt (such as a remote host fingerprint), handle it there and try again.',
  'Windows QingCode 未及时响应，请确认主窗口和远程连接可用。': 'Windows QingCode did not respond in time. Make sure the main window and remote connection are available.',
  'Windows 端已停止移动连接。': 'Mobile connection was stopped on Windows.',
  'Windows 端操作中断。': 'The operation was interrupted on Windows.',
  '仅支持 PNG / JPEG 图片；其他格式请选择压缩后发送。': 'Only PNG / JPEG images are supported; choose a compression level for other formats.',
  '会话名称最多 80 个字符，不能包含控制字符。': 'Session names can have at most 80 characters and no control characters.',
  '单次终端输入超过 16 KiB。': 'A single terminal input exceeds 16 KiB.',
  '图片不能超过 8 MB。': 'Images cannot exceed 8 MB.',
  '图片编码无效。': 'Invalid image encoding.',
  '密码不正确。': 'Incorrect password.',
  '密码尝试过多，请在一分钟后重试。': 'Too many password attempts. Try again in a minute.',
  '已配对设备已达上限，请先在 Windows 端移除不用的设备。': 'The paired device limit is reached. Remove unused devices on Windows first.',
  '当前设备没有可用的终端会话。': 'This device has no available terminal sessions.',
  '无法识别 WSL 发行版。': 'Cannot identify the WSL distribution.',
  '电脑端返回的终端配置无效，请更新 Windows QingCode 后重试。': 'The computer returned invalid terminal profiles. Update Windows QingCode and try again.',
  '移动连接尚未设置密码。': 'No password is set for the mobile connection.',
  '移动连接已停止。': 'Mobile connection stopped.',
  '移动连接已停止或设备已移除。': 'Mobile connection stopped or this device was removed.',
  '终端不存在。': 'Terminal not found.',
  '终端已结束或正在启动。': 'The terminal has ended or is starting.',
  '终端数量已达上限，请结束闲置会话。': 'Terminal limit reached. End idle sessions.',
  '终端正在启动或关闭。': 'The terminal is starting or closing.',
  '请求传输中断，请检查网络后重试。': 'Request transfer interrupted. Check the network and try again.',
  '请求格式无效。': 'Invalid request format.',
  '请求过大，请提高图片压缩等级后重试。': 'Request too large. Raise the image compression level and try again.',
  '读取上传请求超时，请检查手机到电脑的网络后重试。': 'Reading the upload timed out. Check the phone-to-computer network and try again.',
  '配对处理失败。': 'Pairing failed.',
  '配对已失效，请重新配对。': 'Pairing expired. Pair again.',
  '配对链接无效。': 'Invalid pairing link.',
  '离开应用时，要在程序停下后': 'Get an ',
  '通知你': 'alert',
  '吗？可随时在设置中更改。': ' when a program stops after you leave the app? You can change this in Settings.',
  '开启': 'Turn on',
  '不用': 'No thanks',
  '后台提醒': 'Background alerts',
  '程序停下时通知我': 'Alert me when a program stops',
  '离开应用后继续留意运行中的会话，程序停下或会话结束时发通知；没有会话运行时自动停止。依据程序标题判断，普通 Shell 命令没有运行状态，需要手机能连上电脑，会增加耗电。': 'Keeps watching running sessions after you leave the app and alerts you when a program stops or a session ends. Stops automatically when nothing is running. Detection relies on the program title, so plain shell commands have no running state. The phone must be able to reach the computer, and battery use increases.',
  '硬件加速渲染': 'Hardware-accelerated rendering',
  '开启 · 全屏程序更流畅': 'On · smoother full-screen programs',
  '画面花屏或闪烁时可关闭。设备不支持时自动使用普通渲染。': 'Turn off if the screen glitches or flickers. Standard rendering is used automatically on unsupported devices.',
  '终端手势': 'Terminal gestures',
  '上下滑动': 'Swipe up or down',
  '查看历史输出，滑回底部继续跟随': 'Read earlier output. Swipe back to the bottom to follow again.',
  '长按文字': 'Long-press text',
  '选中后可复制，拖动两端调整范围': 'Select and copy. Drag the handles to adjust.',
  '双指缩放': 'Pinch',
  '调整终端字号': 'Change the terminal font size',
  '左右拖动输入框': 'Drag the input box sideways',
  '移动光标': 'Move the cursor',
  '按住右侧滑块': 'Hold the right-side slider',
  '进入鼠标模式，用于点击全屏程序': 'Enter mouse mode to click in full-screen programs',
  '未获得通知权限，请在系统设置中允许 QingCode 发送通知': 'Notifications are not allowed. Allow them for QingCode in system settings.',
  '当前电脑不支持后台提醒，请更新电脑端 QingCode': "This computer doesn't support background alerts. Update QingCode on the computer.",
  '附件不在当前 WSL 项目内。': 'The attachment is not inside the current WSL project.',
  '项目位置已变化，请重新打开终端后发送图片。': 'The project location changed. Reopen the terminal before sending images.',
});

let current = 'zh';
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** 偏好 + 系统语言 → 实际语言；只要中英文，非中文系统一律英文。 */
export function resolveLocale(preference, systemLanguages = []) {
  if (preference === 'zh' || preference === 'en') return preference;
  const first = [systemLanguages].flat().find(Boolean);
  return !first || /^zh\b/i.test(first) ? 'zh' : 'en';
}

export function setLocale(value) { current = value === 'en' ? 'en' : 'zh'; }
export function locale() { return current; }
/** 供日期与排序使用的 BCP 47 标签。 */
export function dateLocale() { return current === 'en' ? 'en-US' : 'zh-CN'; }

/** 翻译：中文原文为 key，未收录时原样返回（因此对已翻译文本或电脑端原始消息也安全）。 */
export function t(key, vars) {
  const text = current === 'en' && has(EN, key) ? EN[key] : key;
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (has(vars, name) ? String(vars[name]) : match)) : text;
}

export function loadLocalePreference(storage) {
  try {
    const value = storage?.getItem(LOCALE_KEY);
    return LOCALE_CHOICES.includes(value) ? value : 'auto';
  } catch { return 'auto'; }
}

export function saveLocalePreference(storage, value) {
  try {
    if (value === 'auto') storage.removeItem(LOCALE_KEY);
    else storage.setItem(LOCALE_KEY, value);
  } catch { /* 保存失败时本次仍然切换。 */ }
}

const ATTRIBUTES = ['placeholder', 'aria-label', 'alt'];
// 终端画面、脚本与样式不参与界面翻译（终端输出里恰好出现的中文不能被改写）。
const SKIP_SELECTOR = '.xterm, script, style, [data-i18n-skip]';
const DATA_KEY = /^[a-z]+:[\w-]+$/;

// 记录被翻成英文的节点原本的中文，切回中文时优先精确还原（同一英文可能对应多个中文）。
const textOrigins = new WeakMap(); // Text → { zh, en }
const dataOrigins = new WeakMap(); // Element → { zh, en }
const attrOrigins = new WeakMap(); // Element → { [name]: { zh, en } }
let reverse = null;

/** 英文 → 中文：用于还原启动后才以英文生成、没有原始记录的整句文案；data-i18n 专用 key 不参与。 */
function reverseEntries() {
  if (reverse) return reverse;
  reverse = new Map();
  for (const [zh, en] of Object.entries(EN)) {
    if (!DATA_KEY.test(zh) && zh !== en && !reverse.has(en)) reverse.set(en, zh);
  }
  return reverse;
}

function swapTrimmed(raw, from, to) {
  const start = raw.indexOf(from);
  return raw.slice(0, start) + to + raw.slice(start + from.length);
}

function skipped(node) {
  return !!node.parentElement?.closest(SKIP_SELECTOR);
}

/**
 * 按当前语言翻译页面静态文案，可反复调用、可在中英之间来回切换：
 * 文本节点按去除首尾空白后的整句匹配（保留原有空白），data-i18n 用专用 key，并翻译常用属性。
 * 带占位符的动态文案不在此处理，由各视图重新渲染。
 */
export function translateDocument(root) {
  const toEn = current === 'en';
  const back = reverseEntries();
  // data-i18n 先处理：其文字可能同时是普通 key，避免被文本遍历抢先改写后丢失中文原文。
  for (const element of root.querySelectorAll('[data-i18n]')) {
    const key = element.dataset.i18n;
    if (!has(EN, key)) continue;
    if (toEn) {
      if (element.textContent === EN[key]) continue;
      dataOrigins.set(element, { zh: element.textContent, en: EN[key] });
      element.textContent = EN[key];
    } else {
      const origin = dataOrigins.get(element);
      if (origin && element.textContent === origin.en) element.textContent = origin.zh;
      dataOrigins.delete(element);
    }
  }
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const raw = node.nodeValue;
    const key = raw.trim();
    if (!key || skipped(node)) continue;
    if (toEn) {
      if (!has(EN, key) || EN[key] === key) continue;
      const next = swapTrimmed(raw, key, EN[key]);
      textOrigins.set(node, { zh: raw, en: next });
      node.nodeValue = next;
    } else {
      const origin = textOrigins.get(node);
      if (origin && raw === origin.en) node.nodeValue = origin.zh;
      else if (back.has(key)) node.nodeValue = swapTrimmed(raw, key, back.get(key));
      textOrigins.delete(node);
    }
  }
  for (const element of root.querySelectorAll(ATTRIBUTES.map(name => `[${name}]`).join(','))) {
    if (element.closest('.xterm, [data-i18n-skip]')) continue;
    const origins = attrOrigins.get(element) ?? {};
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (!value) continue;
      if (toEn) {
        if (!has(EN, value) || EN[value] === value) continue;
        origins[name] = { zh: value, en: EN[value] };
        element.setAttribute(name, EN[value]);
      } else {
        const origin = origins[name];
        if (origin && value === origin.en) element.setAttribute(name, origin.zh);
        else if (back.has(value)) element.setAttribute(name, back.get(value));
        delete origins[name];
      }
    }
    attrOrigins.set(element, origins);
  }
}

/** 页面启动时调用：按保存的偏好与系统语言确定语言（其余模块只在函数内调用 t，不在导入时求值）。 */
export function initLocale(storage, nav) {
  setLocale(resolveLocale(loadLocalePreference(storage), nav?.languages?.length ? nav.languages : [nav?.language]));
  return current;
}
