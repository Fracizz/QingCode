# QingCode patch of tao 0.35.3

Vendored from crates.io `tao 0.35.3` (`d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`).

Windows `EventLoopRunner::reset_runner` no longer drops the boxed event callback.
Dropping that `Box<dyn FnMut>` (~608 bytes) re-enters Win32 window teardown and
double-frees the same heap block (`HEAP_FAILURE_BLOCK_NOT_BUSY` / `0xc0000374`).

Keep this crate at 0.35.3 so it continues to satisfy Tauri 2's tao requirement.
When upgrading Tauri/tao, replay the `reset_runner` change or drop this patch if
upstream has an equivalent fix.
