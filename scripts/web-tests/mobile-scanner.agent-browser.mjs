import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const session = `mobile-scanner-${process.pid}`
const directory = resolve('.dev/web-tests/mobile-scanner')
mkdirSync(directory, { recursive: true })
const results = []
const qrFixture = JSON.parse(readFileSync(resolve('web-tests/fixtures/mobile-pairing-qr.json'), 'utf8'))
const run = (...args) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 })
const check = (name, expression) => { run('wait', '--fn', expression); results.push({ name, passed: true }) }
const capture = name => run('screenshot', resolve(directory, `${name}.png`))

try {
  run('set', 'viewport', '430', '900')
  run('open', 'http://127.0.0.1:38439/mobile-android/')
  run('wait', '--fn', `!!window.__mobileFixture && typeof window.jsQR === 'function'`)
  run('eval', `document.querySelector('#add-host').click()`)
  run('click', '#pair-scan')
  check('permission denial is visible inside the scanner', `document.querySelector('#scan-dialog').open && document.querySelector('#scan-error').textContent.includes('相机权限')`)
  run('click', '#scan-dialog [data-close]')
  run('eval', `(async () => {
    const fixture = ${JSON.stringify(qrFixture)};
    const canvas = document.createElement('canvas');
    canvas.width = 1920; canvas.height = 1080;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(15);
    const track = stream.getVideoTracks()[0];
    const state = window.__scannerTest = { fixture, canvas, stream, track, requests: [], focus: [] };
    track.getCapabilities = () => ({ focusMode: ['continuous'] });
    track.applyConstraints = async constraints => { state.focus.push(constraints); };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
      state.requests.push(constraints); return stream;
    }});
    state.draw = (left = 0) => {
      context.fillStyle = '#fff'; context.fillRect(0, 0, 1920, 1080);
      const scale = 3, extent = (fixture.size + 8) * scale;
      const x = left || Math.floor((1920 - extent) / 2), y = Math.floor((1080 - extent) / 2);
      context.fillStyle = '#000';
      for (let row = 0; row < fixture.size; row++) for (let col = 0; col < fixture.size; col++) {
        if (fixture.modules[row * fixture.size + col] === '1') context.fillRect(x + (col + 4) * scale, y + (row + 4) * scale, scale, scale);
      }
      track.requestFrame?.();
    };
    window.__mobileFixture.state.cameraGranted = true;
  })()`)
  run('click', '#pair-scan')
  check('scanner requests high resolution and continuous autofocus', `window.__scannerTest.requests[0]?.video.width.ideal === 1920 && window.__scannerTest.focus[0]?.advanced[0].focusMode === 'continuous' && document.querySelector('#scan-video').videoWidth === 1920`)
  check('preview retains the entire frame without cover magnification', `getComputedStyle(document.querySelector('#scan-video')).objectFit === 'contain'`)
  capture('camera-preview')
  run('eval', `window.__scannerTest.draw(); window.__scannerTest.realDecoder = window.jsQR; window.__scannerTest.attempts = 0;
    window.jsQR = (...args) => { if (++window.__scannerTest.attempts === 1) throw new Error('Temporary frame error'); return window.__scannerTest.realDecoder(...args); };`)
  check('real dense QR survives a frame exception and opens prefilled pairing', `!document.querySelector('#scan-dialog').open && document.querySelector('#pair-name').value === 'SCAN-TEST' && document.querySelector('#pair-host').value === '192.168.1.8' && document.querySelector('#pair-port').value === '48764'`)
  check('recognition releases the camera', `window.__scannerTest.track.readyState === 'ended' && document.querySelector('#scan-video').srcObject === null`)
  check('the scanned fingerprint stays pinned and the password remains empty', `!document.querySelector('#pair-link-state').hidden && document.querySelector('#pair-code').value === ''`)
  capture('recognized-qr')
  run('eval', `(async () => {
    const { decodeScannerFrame } = await import('/mobile-android/scanner.js');
    const state = window.__scannerTest;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const source = document.querySelector('#scan-video');
    const stream = state.canvas.captureStream(15);
    source.srcObject = stream;
    const playing = source.play(); state.draw(); await playing;
    canvas.width = 720; canvas.height = 405;
    context.drawImage(source, 0, 0, 720, 405);
    const frame = context.getImageData(0, 0, 720, 405);
    state.oldResult = state.realDecoder(frame.data, 720, 405, { inversionAttempts: 'dontInvert' })?.data ?? null;
    state.newResult = decodeScannerFrame(source, canvas, context, state.realDecoder);
    for (const track of stream.getTracks()) track.stop(); source.srcObject = null;
  })()`)
  check('central high resolution decodes detail lost by the former 720px sampling', `window.__scannerTest.oldResult === null && window.__scannerTest.newResult === window.__scannerTest.fixture.link`)
  run('eval', `window.jsQR = window.__scannerTest.realDecoder;
    window.__scannerTest.late = window.__scannerTest.canvas.captureStream(15);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => new Promise(resolve => { window.__scannerTest.resolveCamera = resolve; }) });`)
  run('click', '#pair-scan')
  check('camera acquisition can be cancelled before it resolves', `document.querySelector('#scan-dialog').open && !!window.__scannerTest.resolveCamera`)
  run('click', '#scan-dialog [data-close]')
  run('eval', `window.__scannerTest.resolveCamera(window.__scannerTest.late)`)
  check('late camera completion is released without reopening the scanner', `!document.querySelector('#scan-dialog').open && window.__scannerTest.late.getVideoTracks()[0].readyState === 'ended'`)
} catch (error) {
  results.push({ name: String(error), passed: false })
  capture('failure')
  process.exitCode = 1
} finally {
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({ engine: 'agent-browser', physicalCamera: false, results }, null, 2))
  writeFileSync(resolve(directory, 'browser-errors.json'), run('errors', '--json'))
  run('close')
}
console.log(`${results.filter(result => result.passed).length}/${results.length} browser checks passed. ${directory}`)
