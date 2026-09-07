# QingCode patch of tao 0.35.3

Vendored from crates.io `tao 0.35.3` (`d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`).

Two Windows heap-corruption fixes. Keep this crate at 0.35.3 so it continues
to satisfy Tauri 2's tao requirement. When upgrading Tauri/tao, replay both
changes or drop them if upstream has equivalents.

## 1. EventLoopRunnerShared: Rc → Arc

`EventLoopRunnerShared` was a non-atomic `Rc`. tauri-runtime-wry clones
`EventLoopWindowTarget` (and therefore this handle) onto tokio workers via
`unsafe impl Send` context types. Concurrent `Rc::clone` on the UI thread and
`Rc::drop` off-thread desyncs the refcount, so the runner is freed while the
event loop is still running.

Observed as sporadic `STATUS_HEAP_CORRUPTION (0xc0000374)`, often detected
later on `tokio-rt-worker` / `notify-rs` thread exit (`RtlFreeHeap`) or on the
main thread inside the window subclass / WebView2 path. Same class of bug as
tauri-apps/tao#1290 and tauri-apps/tauri#15408.

## 2. reset_runner does not drop the boxed event callback

`event_handler.set(None)` drops a ~608-byte `Box<dyn FnMut>` (Tauri's run
closure). That Drop re-enters Win32 window/WebView teardown and has been
observed as `HEAP_FAILURE_BLOCK_NOT_BUSY` / double-free on Windows. `EventLoop::run`
calls `process::exit` immediately after `run_return`, so leaking until process
exit is equivalent to skipping a destructor the OS is about to reclaim.
