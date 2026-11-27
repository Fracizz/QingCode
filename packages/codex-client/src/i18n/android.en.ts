// 键为中文原文，值为英文。
// 对应 apps/mobile/android 原生层经桥传给 Web 的提示；原生自己显示的文字在 Android 资源里。
export default {
  // 桥请求与参数
  '请求格式错误': 'Invalid request format',
  '请求参数格式错误': 'Invalid request parameters',
  '请求失败': 'Request failed',
  '原生桥请求失败': 'Native bridge request failed',
  '不支持的原生方法': 'Unsupported native method',
  '应用已关闭': 'The app is closed',
  '缺少 {name} 参数': 'Missing {name} parameter',
  '缺少整数 {key} 参数': 'Missing integer {key} parameter',
  '缺少 stream 参数': 'Missing stream parameter',
  '后台连接设置无效': 'Invalid background connection setting',
  '屏幕常亮设置无效': 'Invalid keep-screen-on setting',
  '系统栏外观设置无效': 'Invalid system bar appearance setting',
  '存储键格式不正确': 'Invalid storage key format',

  // 本地存储与剪贴板
  '本地加密存储不可用，请重新配对': 'Encrypted local storage is unavailable. Pair again',
  '本地存储数据无法解密，请重新配对': 'Cannot decrypt local data. Pair again',
  '剪贴板文本过长或格式不正确': 'Clipboard text is too long or in an invalid format',
  '系统剪贴板不可用': 'The system clipboard is unavailable',
  '请在应用前台使用剪贴板': 'Use the clipboard while the app is in the foreground',
  '应用已关闭，无法访问剪贴板': 'The app is closed and cannot access the clipboard',
  '访问剪贴板超时': 'Clipboard access timed out',
  '访问剪贴板被中断': 'Clipboard access was interrupted',
  '无法访问剪贴板，请在前台重试': 'Cannot access the clipboard. Try again in the foreground',

  // 连接与配对
  '缺少电脑地址': 'Missing computer address',
  '电脑地址过长': 'The computer address is too long',
  '电脑地址格式不正确': 'Invalid computer address',
  'IPv6 地址格式不正确': 'Invalid IPv6 address',
  '端口格式不正确': 'Invalid port format',
  '端口超出范围': 'Port out of range',
  '证书指纹格式不正确': 'Invalid certificate fingerprint format',
  '缺少连接令牌': 'Missing connection token',
  '令牌格式不正确': 'Invalid token format',
  '缺少配对密码': 'Missing pairing password',
  '配对响应格式不正确': 'Invalid pairing response',
  '电脑未返回配对令牌': 'The computer did not return a pairing token',
  '未能读取电脑证书指纹': "Could not read the computer's certificate fingerprint",
  '地址指向了另一台电脑或证书已重新生成，请从电脑重新复制连接信息':
    'The address points to another computer or the certificate was regenerated. Copy the connection info from the computer again',
  '连接或读取超时，请检查电脑是否在线以及地址/端口是否正确':
    'Connection or read timed out. Check that the computer is online and the address and port are correct',
  '无法连接电脑，请检查地址、端口与网络': 'Cannot connect to the computer. Check the address, port, and network',
  'TLS 连接失败，请重新核对连接信息': 'TLS connection failed. Check the connection info again',
  '网络请求失败，请检查电脑端手机网关是否开启':
    'Network request failed. Check that the mobile gateway is enabled on the computer',
  '数据格式不正确': 'Invalid data format',
  '电脑返回的数据过大': 'The computer returned too much data',
  '电脑返回的数据格式不正确': 'The computer returned data in an invalid format',
  '连接未被电脑授权，请重新配对': 'The computer has not authorized this connection. Pair again',
  '电脑端手机网关未开启或版本不匹配': 'The mobile gateway on the computer is off or its version does not match',
  '电脑端手机网关出错': 'The mobile gateway on the computer encountered an error',
  '电脑返回 HTTP {status}': 'The computer returned HTTP {status}',
  '电脑拒绝了请求': 'The computer rejected the request',

  // 事件流
  '事件流已断开': 'Event stream disconnected',
  '事件流 60 秒无数据，已断开': 'Event stream disconnected after 60 seconds without data',
  '事件格式错误': 'Invalid event format',

  // 系统选择界面与扫码
  '请先关闭当前系统选择界面': 'Close the current system picker first',
  '请回到 QingCode 页面后重试': 'Return to the QingCode screen and try again',
  '无法打开系统选择界面': 'Cannot open the system picker',
  '系统选择界面已超时，请重试': 'The system picker timed out. Try again',
  '打开系统选择界面失败': 'Failed to open the system picker',
  '当前设备无法打开系统文件选择界面': 'This device cannot open the system file picker',
  '当前设备无法打开系统图片选择界面': 'This device cannot open the system photo picker',
  '当前没有可调用的扫码应用。请用系统相机扫描后打开链接，或粘贴电脑端复制的连接信息':
    'No scanner app is available. Scan with the system camera and open the link, or paste the connection info copied from the computer',
  '这不是 QingCode Next 的配对二维码': 'This is not a QingCode Next pairing QR code',

  // 项目文件下载
  '单个文件下载上限为 512 MiB': 'Each file download is limited to 512 MiB',
  '请先完成或取消当前下载': 'Finish or cancel the current download first',
  '当前设备无法打开系统文件保存界面': 'This device cannot open the system save dialog',
  '系统未返回可写入的位置': 'The system did not return a writable location',
  '下载分块大小不正确': 'Invalid download chunk size',
  '下载分块不是有效的 base64': 'The download chunk is not valid base64',
  '无法在下载目录创建文件，请检查存储空间': 'Cannot create the file in Downloads. Check free storage',
  '网络中断或存储写入失败，请检查后重新下载': 'The network dropped or saving failed. Check and download again',
  '电脑返回了无效的文件信息': 'The computer returned invalid file info',
  '文件大小已变化，请刷新文件列表后重试': 'The file size changed. Refresh the list and try again',
  '文件已变化，请重新下载': 'The file has changed. Download it again',
  '保存内容长度不一致': 'Saved length does not match',
  '下载失败': 'Download failed',

  // 应用更新
  '请输入以 HTTPS 开头并直接指向 .apk 的地址': 'Enter an HTTPS URL that points directly to an .apk file',
  '无法下载或读取更新，请检查 HTTPS 地址、网络和手机空间':
    'Cannot download or read the update. Check the HTTPS URL, network, and phone storage',
  '更新地址发生重定向，请填写直接下载 APK 的 HTTPS 地址':
    'The update URL redirects. Enter an HTTPS URL that downloads the APK directly',
  '更新服务器未返回 APK': 'The update server did not return an APK',
  'APK 大小超过 512 MiB': 'The APK is larger than 512 MiB',
  '读取更新超时或已取消': 'Reading the update timed out or was canceled',
  '安装包为空或下载不完整': 'The package is empty or the download is incomplete',
  '正在准备一项更新': 'An update is already being prepared',
  '已检查的更新过期，请重新检查': 'The checked update has expired. Check again',
  '当前设备无法打开系统安装包选择界面': 'This device cannot open the system package picker',
  '系统未返回有效的 APK 文件': 'The system did not return a valid APK file',
  '此文件不是可读取的 Android 安装包': 'This file is not a readable Android package',
  '此安装包不是 QingCode Next': 'This package is not QingCode Next',
  '安装包与当前应用的签名不一致': "The package signature does not match the current app's",
  '请选择版本号高于当前应用的安装包': 'Choose a package with a higher version than the current app',
  '在系统设置允许 QingCode 安装应用后，请重试安装':
    'Allow QingCode to install apps in system settings, then try installing again',
  '无法读取或准备此 APK，请检查文件及手机剩余空间':
    'Cannot read or prepare this APK. Check the file and free phone storage',
} satisfies Record<string, string>
