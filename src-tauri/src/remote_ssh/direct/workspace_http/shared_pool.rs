//! Share HTTPS connections and admission across short-lived filesystem,
//! metadata and command clients with the same pinned server and credential.
use super::*;
use qingcode_server::workspace::budget::RequestBudget;

const MAX_POOLS: usize = 64;
const POOL_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Eq, PartialEq, Hash)]
struct PoolKey {
    authority: String,
    fingerprint: String,
    credential_hash: [u8; 32],
}

pub(super) struct SharedPool {
    pub(super) config: DirectConnectionConfig,
    pub(super) idle: Mutex<Vec<(Instant, TlsStream<TcpStream>)>>,
    pub(super) budget: RequestBudget,
}

#[derive(Default)]
struct PoolRegistry {
    // Weak entries preserve one budget for every live identity even when its
    // idle-cache entry is evicted. Dead entries are pruned on the next lookup.
    live: HashMap<PoolKey, Weak<SharedPool>>,
    cached: HashMap<PoolKey, (Instant, Arc<SharedPool>)>,
}
static POOLS: OnceLock<Mutex<PoolRegistry>> = OnceLock::new();

impl SharedPool {
    pub(super) fn get(config: DirectConnectionConfig) -> Arc<Self> {
        POOLS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(config)
    }
}

impl PoolRegistry {
    fn get(&mut self, config: DirectConnectionConfig) -> Arc<SharedPool> {
        let key = PoolKey {
            authority: endpoint(&config.endpoint)
                .map(|endpoint| endpoint.authority)
                .unwrap_or_else(|_| config.endpoint.clone()),
            fingerprint: normalized_fingerprint(&config.certificate_fingerprint)
                .unwrap_or_else(|_| config.certificate_fingerprint.clone()),
            credential_hash: Sha256::digest(config.token.as_bytes()).into(),
        };
        self.cached.retain(|_, (used, _)| used.elapsed() < POOL_TTL);
        self.live.retain(|_, pool| pool.strong_count() > 0);
        let pool = self
            .live
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                Arc::new(SharedPool {
                    config,
                    idle: Mutex::new(Vec::new()),
                    budget: RequestBudget::default(),
                })
            });
        self.live.insert(key.clone(), Arc::downgrade(&pool));
        if !self.cached.contains_key(&key) && self.cached.len() >= MAX_POOLS {
            let oldest = self
                .cached
                .iter()
                .min_by_key(|(_, (used, _))| *used)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.cached.remove(&oldest);
            }
        }
        self.cached.insert(key, (Instant::now(), Arc::clone(&pool)));
        pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicting_cached_identities_keeps_the_same_budget_for_live_clients() {
        let mut registry = PoolRegistry::default();
        let config = DirectConnectionConfig {
            endpoint: "https://127.0.0.1:48763".into(),
            certificate_fingerprint: "a".repeat(64),
            token: "test-token".into(),
        };
        let first = registry.get(config.clone());
        let mut clients = Vec::new();
        for index in 1..=MAX_POOLS {
            clients.push(registry.get(DirectConnectionConfig {
                endpoint: format!("https://127.0.0.1:{}", 48763 + index),
                ..config.clone()
            }));
        }
        assert_eq!(registry.cached.len(), MAX_POOLS);
        assert_eq!(registry.live.len(), MAX_POOLS + 1);
        assert!(!registry
            .cached
            .values()
            .any(|(_, pool)| Arc::ptr_eq(&first, pool)));
        assert!(Arc::ptr_eq(&first, &registry.get(config)));
        assert_eq!(registry.cached.len(), MAX_POOLS);
    }
}
