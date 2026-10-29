//! Workspace work must not consume every request slot with bulk transfers or
//! long-running commands. Used by both the HTTP client and the server.
use tokio::sync::{Semaphore, SemaphorePermit};

pub const MAX_REQUESTS: usize = 16;
pub const MAX_BULK_REQUESTS: usize = 8;
pub const MAX_EXEC_REQUESTS: usize = 4;

pub struct RequestBudget {
    all: Semaphore,
    bulk: Semaphore,
    exec: Semaphore,
}

pub struct RequestPermit<'a> {
    _all: SemaphorePermit<'a>,
    _class: Option<SemaphorePermit<'a>>,
}

impl Default for RequestBudget {
    fn default() -> Self {
        Self {
            all: Semaphore::new(MAX_REQUESTS),
            bulk: Semaphore::new(MAX_BULK_REQUESTS),
            exec: Semaphore::new(MAX_EXEC_REQUESTS),
        }
    }
}

impl RequestBudget {
    pub async fn acquire(&self, op: &str) -> Result<RequestPermit<'_>, String> {
        let class = match op {
            "read_at" | "write_at" | "close" => Some(&self.bulk),
            "exec" => Some(&self.exec),
            _ => None,
        };
        // Acquire the class slot first. Waiting uploads must not hold all of
        // the shared slots while metadata requests queue behind them.
        let class = match class {
            Some(class) => Some(class.acquire().await.map_err(|_| "工作区请求队列已关闭")?),
            None => None,
        };
        let all = self
            .all
            .acquire()
            .await
            .map_err(|_| "工作区请求队列已关闭")?;
        Ok(RequestPermit {
            _all: all,
            _class: class,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn bulk_and_exec_leave_four_slots_for_metadata_and_release_on_cancellation() {
        let budget = RequestBudget::default();
        let mut held = Vec::new();
        for _ in 0..MAX_BULK_REQUESTS {
            held.push(budget.acquire("write_at").await.unwrap());
        }
        for _ in 0..MAX_EXEC_REQUESTS {
            held.push(budget.acquire("exec").await.unwrap());
        }
        for op in ["read_at", "write_at", "close", "exec"] {
            assert!(
                tokio::time::timeout(Duration::from_millis(10), budget.acquire(op))
                    .await
                    .is_err()
            );
        }
        for _ in 0..4 {
            held.push(
                tokio::time::timeout(Duration::from_secs(1), budget.acquire("metadata"))
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        assert_eq!(budget.all.available_permits(), 0);
        drop(held);
        assert_eq!(budget.all.available_permits(), MAX_REQUESTS);
        assert_eq!(budget.bulk.available_permits(), MAX_BULK_REQUESTS);
        assert_eq!(budget.exec.available_permits(), MAX_EXEC_REQUESTS);
    }

    #[tokio::test]
    async fn cancelling_after_class_admission_releases_the_class_permit() {
        let budget = RequestBudget::default();
        let mut held = Vec::new();
        for _ in 0..MAX_REQUESTS {
            held.push(budget.acquire("metadata").await.unwrap());
        }
        for op in ["write_at", "exec"] {
            assert!(
                tokio::time::timeout(Duration::from_millis(10), budget.acquire(op))
                    .await
                    .is_err()
            );
        }
        assert_eq!(budget.bulk.available_permits(), MAX_BULK_REQUESTS);
        assert_eq!(budget.exec.available_permits(), MAX_EXEC_REQUESTS);
        drop(held);
        budget.acquire("write_at").await.unwrap();
    }
}
