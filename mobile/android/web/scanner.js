// Camera acquisition and QR sampling shared by the WebView and scanner tests.
export async function requestScannerCamera(mediaDevices) {
  try {
    return await mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 15, max: 30 },
      },
      audio: false,
    });
  } catch (error) {
    // Some older WebViews reject optional camera constraints. Permission and
    // hardware failures must retain their real error instead of prompting again.
    if (error.name !== 'OverconstrainedError') throw error;
    return mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  }
}

export async function focusScannerCamera(stream) {
  try {
    const track = stream.getVideoTracks()[0];
    if (track?.getCapabilities?.().focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
  } catch {
    // Autofocus controls are optional; retain the camera's default on rejection.
  }
}

/** Keep central QR modules at camera resolution, then cover off-center codes. */
export function scannerRegions(width, height) {
  if (width <= 0 || height <= 0) return [];
  const side = Math.min(width, height);
  const regions = [
    { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side },
  ];
  if (width !== height) regions.push({ x: 0, y: 0, width, height });
  return regions.map(region => {
    const scale = Math.min(1, 1280 / Math.max(region.width, region.height));
    return { ...region, targetWidth: Math.round(region.width * scale), targetHeight: Math.round(region.height * scale) };
  });
}

export function decodeScannerFrame(video, canvas, context, decode) {
  for (const region of scannerRegions(video.videoWidth, video.videoHeight)) {
    canvas.width = region.targetWidth;
    canvas.height = region.targetHeight;
    context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    const found = decode(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
    if (found?.data) return found.data;
  }
  return null;
}
