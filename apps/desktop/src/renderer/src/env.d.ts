export {}

declare global {
  interface Window {
    qn: {
      openFile(kind?: 'sshKey' | 'legacyDb'): Promise<string | null>
      version(): Promise<string>
      smokeDone(): void
      requestPort(): void
      isSmoke: boolean
      platform: string
    }
  }
}
