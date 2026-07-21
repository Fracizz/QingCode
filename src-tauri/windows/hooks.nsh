; QingCode NSIS installer hooks.
; When WebView2 is missing: try auto-download first; on failure, offer a
; one-click browser jump to the Evergreen Bootstrapper (or product page).
;
; Requires webviewInstallMode.type = "skip" so Tauri does not Abort before
; this hook runs. See tauri.conf.json → bundle.windows.

!define QING_WEBVIEW2_GUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
; Evergreen Bootstrapper — browser navigates here and downloads the setup exe.
!define QING_WEBVIEW2_BOOTSTRAPPER_URL "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
; Product page (offline installers / docs) if the bootstrapper link is blocked.
!define QING_WEBVIEW2_PAGE_URL "https://developer.microsoft.com/microsoft-edge/webview2/"

!macro QingReadWebView2Version
  StrCpy $R9 ""
  ${If} ${RunningX64}
    ReadRegStr $R9 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${QING_WEBVIEW2_GUID}" "pv"
  ${Else}
    ReadRegStr $R9 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${QING_WEBVIEW2_GUID}" "pv"
  ${EndIf}
  ${If} $R9 == ""
    ReadRegStr $R9 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${QING_WEBVIEW2_GUID}" "pv"
  ${EndIf}
!macroend

!macro QingTryInstallWebView2Bootstrapper
  DetailPrint "WebView2 not found — downloading Evergreen Bootstrapper..."
  Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
  NSISdl::download "${QING_WEBVIEW2_BOOTSTRAPPER_URL}" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
  Pop $0
  ${If} $0 == "success"
    DetailPrint "Installing WebView2..."
    ExecWait '"$TEMP\MicrosoftEdgeWebview2Setup.exe" /install' $1
    ${If} $1 = 0
      !insertmacro QingReadWebView2Version
      ${If} $R9 != ""
        DetailPrint "WebView2 installed successfully."
      ${Else}
        DetailPrint "WebView2 setup returned success but runtime is still missing."
      ${EndIf}
    ${Else}
      DetailPrint "WebView2 install failed (exit $1)."
    ${EndIf}
  ${Else}
    DetailPrint "WebView2 download failed: $0"
  ${EndIf}
!macroend

!macro QingOfferWebView2Download
  ${If} ${Silent}
    Abort "Microsoft Edge WebView2 Runtime is required. Install it from ${QING_WEBVIEW2_BOOTSTRAPPER_URL} and re-run the installer."
  ${EndIf}

  ; Yes → bootstrapper download · No → product page · Cancel → exit only.
  MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION \
    "未检测到 Microsoft Edge WebView2 运行时。$\r$\n$\r$\nQingCode 需要 WebView2 才能运行。$\r$\n$\r$\n• 是：打开引导程序下载（浏览器将下载安装包）$\r$\n• 否：打开 WebView2 产品说明页$\r$\n• 取消：退出安装$\r$\n$\r$\nMicrosoft Edge WebView2 Runtime was not found.$\r$\nYes = download bootstrapper · No = product page · Cancel = exit" \
    IDYES qing_wv2_dl IDNO qing_wv2_page IDCANCEL qing_wv2_cancel

  qing_wv2_dl:
    ExecShell "open" "${QING_WEBVIEW2_BOOTSTRAPPER_URL}"
    Goto qing_wv2_after_open

  qing_wv2_page:
    ExecShell "open" "${QING_WEBVIEW2_PAGE_URL}"
    Goto qing_wv2_after_open

  qing_wv2_after_open:
    MessageBox MB_OK|MB_ICONINFORMATION \
      "请完成 WebView2 安装后，重新运行本安装程序。$\r$\n$\r$\nAfter WebView2 is installed, run this installer again."
    Abort

  qing_wv2_cancel:
    Abort "需要安装 WebView2 才能继续。 / WebView2 is required to continue."
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro QingReadWebView2Version
  ${If} $R9 == ""
    !insertmacro QingTryInstallWebView2Bootstrapper
    ${If} $R9 == ""
      !insertmacro QingOfferWebView2Download
    ${EndIf}
  ${EndIf}
!macroend
