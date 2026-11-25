//! 远端主机 CPU / 内存的配置与实时占用，供客户端「远程连接」概览按需轮询。
//! 只读、无参数；CPU 占用率需要两次采样之差，因此跨请求复用同一个 `System`。
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

struct Sampler {
    system: System,
    last: Instant,
}

fn sampler() -> &'static Mutex<Option<Sampler>> {
    static SAMPLER: OnceLock<Mutex<Option<Sampler>>> = OnceLock::new();
    SAMPLER.get_or_init(|| Mutex::new(None))
}

pub fn snapshot() -> Result<Value, String> {
    let mut guard = sampler().lock().map_err(|_| "系统指标状态不可用")?;
    let sampler = guard.get_or_insert_with(|| {
        let system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::everything()),
        );
        Sampler {
            system,
            last: Instant::now(),
        }
    });
    // 距上次采样不足最小间隔时，占用率会是 0 或失真：补等到最小间隔再采。
    let elapsed = sampler.last.elapsed();
    if elapsed < sysinfo::MINIMUM_CPU_UPDATE_INTERVAL {
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL - elapsed);
    }
    sampler
        .system
        .refresh_cpu_specifics(CpuRefreshKind::nothing().with_cpu_usage());
    sampler.system.refresh_memory();
    sampler.last = Instant::now();
    Ok(describe(&sampler.system))
}

fn describe(system: &System) -> Value {
    let total = system.total_memory();
    // Windows/macOS 上 used 不含可回收缓存；统一用 total - available 表示实际占用。
    let used = total.saturating_sub(system.available_memory());
    json!({
        "cpuThreads": system.cpus().len(),
        "cpuCores": system.physical_core_count(),
        "cpuBaseMhz": base_frequency_mhz(system),
        "cpuUsage": round(system.global_cpu_usage()),
        "memoryTotal": total,
        "memoryUsed": used,
    })
}

/// CPU 标称主频（MHz）：只取一次的配置值，不随睿频/降频变化。
fn base_frequency_mhz(system: &System) -> Option<u64> {
    static BASE: OnceLock<Option<u64>> = OnceLock::new();
    *BASE.get_or_init(|| {
        platform_base_mhz()
            .or_else(|| system.cpus().iter().find_map(|cpu| brand_mhz(cpu.brand())))
            .filter(|mhz| *mhz > 0)
    })
}

/// 解析型号里的「@ 2.10GHz」。
fn brand_mhz(brand: &str) -> Option<u64> {
    let tail = brand
        .rsplit('@')
        .next()
        .filter(|_| brand.contains('@'))?
        .trim();
    let number = tail
        .strip_suffix("GHz")
        .or_else(|| tail.strip_suffix("Ghz"))?
        .trim();
    number
        .parse::<f64>()
        .ok()
        .map(|ghz| (ghz * 1000.0).round() as u64)
}

#[cfg(target_os = "linux")]
fn platform_base_mhz() -> Option<u64> {
    // base_frequency（intel_pstate）优先；否则退回 cpuinfo_max_freq；单位均为 kHz。
    ["base_frequency", "cpuinfo_max_freq"]
        .iter()
        .find_map(|name| {
            std::fs::read_to_string(format!("/sys/devices/system/cpu/cpu0/cpufreq/{name}"))
                .ok()?
                .trim()
                .parse::<u64>()
                .ok()
                .map(|khz| khz / 1000)
        })
}

#[cfg(windows)]
fn platform_base_mhz() -> Option<u64> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD,
    };
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let key = wide(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
    let value = wide("~MHz");
    let mut mhz: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: 指针均指向本函数内存活的缓冲区，size 与 mhz 的大小一致。
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut mhz as *mut u32).cast(),
            &mut size,
        )
    };
    (status == 0 && mhz > 0).then_some(u64::from(mhz))
}

#[cfg(not(any(target_os = "linux", windows)))]
fn platform_base_mhz() -> Option<u64> {
    None
}

fn round(value: f32) -> f64 {
    if value.is_finite() {
        (f64::from(value.clamp(0.0, 100.0)) * 10.0).round() / 10.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reports_cpu_and_memory() {
        let first = snapshot().unwrap();
        let second = snapshot().unwrap();
        for value in [&first, &second] {
            assert!(value["cpuThreads"].as_u64().unwrap() > 0);
            assert!(value["memoryTotal"].as_u64().unwrap() > 0);
            assert!(
                value["memoryUsed"].as_u64().unwrap() <= value["memoryTotal"].as_u64().unwrap()
            );
            let usage = value["cpuUsage"].as_f64().unwrap();
            assert!((0.0..=100.0).contains(&usage));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_reads_registry_base_frequency() {
        assert!(platform_base_mhz().is_some_and(|mhz| mhz > 100));
    }

    #[test]
    fn brand_mhz_reads_nominal_clock() {
        assert_eq!(
            brand_mhz("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz"),
            Some(2400)
        );
        assert_eq!(brand_mhz("AMD Ryzen 9 7950X 16-Core Processor"), None);
    }

    #[test]
    fn round_clamps_invalid_usage() {
        assert_eq!(round(f32::NAN), 0.0);
        assert_eq!(round(150.0), 100.0);
        assert_eq!(round(12.34), 12.3);
    }
}
