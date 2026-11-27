export {}

declare global {
  interface Window {
    qn: {
      openFile(kind?: 'sshKey' | 'legacyDb'): Promise<string | null>
      downloadFile(targetId: string, root: string, path: string): Promise<boolean>
      version(): Promise<string>
      smokeDone(): void
      requestPort(): void
      isSmoke: boolean
      platform: string
      pathForFile?: (file: File) => string
    }
  }
}
