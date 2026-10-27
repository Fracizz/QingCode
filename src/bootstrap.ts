import { isWebTest } from './lib/webTestMode'

// Install before importing App or any stores: module initialization reads settings.
async function bootstrap() {
  if (import.meta.env.DEV && import.meta.env.MODE === 'web-test' && isWebTest()) {
    const { installWebTestRuntime } = await import('./dev/webTestRuntime')
    await installWebTestRuntime()
  }
  await import('./main')
}

void bootstrap().catch(error => {
  console.error('Application bootstrap failed:', error)
  const splash = document.getElementById('startup-splash')
  splash?.remove()
  const root = document.getElementById('root')
  if (root) root.textContent = `启动失败：${String(error)}`
})
