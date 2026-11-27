export {}

declare global {
  interface Window {
    qn: {
      openFile(kind?: 'sshKey' | 'legacyDb'): Promise<string | null>
      downloadFile(targetId: string, root: string, path: string, openAfterDownload?: boolean): Promise<boolean>
      version(): Promise<string>
      smokeDone(): void
      requestPort(): void
      isSmoke: boolean
      platform: string
      pathForFile?: (file: File) => string
      /** 让主进程把系统窗口按钮（titleBarOverlay）和窗口底色切到对应主题 */
      setTheme?: (theme: 'dark' | 'gray' | 'light') => void
      setLocale?: (locale: 'zh' | 'en') => void
    }
  }
}
