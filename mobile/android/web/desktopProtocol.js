export const MOBILE_PROTOCOL_VERSION = 1;

/** Capabilities are cached by certificate identity, never by an error from a business write. */
export function createDesktopProtocol(remote) {
  const hosts = new Map();
  function capabilities(profile) {
    const key = profile.id + '/' + profile.fingerprint;
    if (!hosts.has(key)) {
      const pending = remote('capabilities', {}, profile.id).then(value => {
        if (value?.protocolVersion !== MOBILE_PROTOCOL_VERSION || !Array.isArray(value.features)
          || !value.features.every(item => typeof item === 'string')) {
          throw new Error('电脑端移动协议不兼容，请更新电脑端和 Android APK。');
        }
        return value;
      }).catch(error => {
        // One dedicated read-only probe is the compatibility path for old desktops.
        if (error.unsupported || error.message === '请求格式无效。' || error.message === '未知操作。') return null;
        hosts.delete(key);
        throw error;
      });
      hosts.set(key, pending);
    }
    return hosts.get(key);
  }
  return {
    capabilities,
    invalidate(profile) { hosts.delete(profile.id + '/' + profile.fingerprint); },
  };
}
