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

## Patch files and re-vendoring

Both changes live as patch files in `src-tauri/vendor/tao-patches/`
(`0001-windows-runner-arc.patch`, `0002-windows-reset-runner-leak-handler.patch`).
Regenerate this directory with:

```
pnpm vendor:tao --version <x.y.z> [--skip 0001] [--check]
```

The script verifies the crates.io sha256, strips `examples/`, applies the
patches with `git apply` (strict, no fuzz) and keeps this file. Replaying on
0.35.3 reproduces the current tree byte-for-byte (modulo CRLF).

## Upstream status (checked 2026-11-25)

- Patch 1: tao did not take the Rc → Arc change (tao#1290 / #1334 closed
  unmerged; maintainers: `EventLoopWindowTarget` was never meant to cross
  threads). The root cause is fixed in Tauri by tauri#15411 ("keep tao
  window_target in main thread"), merged 2026-11-24, shipping in
  **tauri-runtime-wry 2.13.0** (pending release PR tauri#16570). Not in 2.12.x.
- Patch 2: still `event_handler.set(None)` in tao 0.37.3 and 0.38.0. A
  2026-11 report on tauri#15408 (tauri 2.12.5 / tao 0.37.2) shows the same
  drop-of-`Box<dyn FnMut>` crash, so keep it.
- `0001` no longer applies to tao 0.38 (import context changed); `0002`
  applies cleanly and tao 0.38.0 + `0002` passes `cargo check`.

## Tauri 2.13 upgrade checklist

1. Bump `tauri` / `tauri-build` / plugins to 2.13 and front-end
   `@tauri-apps/*` to the matching minor; tauri-runtime-wry 2.13 (dev branch)
   requires `tao 0.38` and `wry 0.58.1`.
2. `pnpm vendor:tao --version <tao version required by 2.13> --skip 0001`,
   then update the version/sha256 at the top of this file.
3. 2.13 breaking change: `WryHandle::display_handle` now goes through the event
   loop and blocks off the main thread. As of this note QingCode's Rust code
   has no `display_handle` / `window_handle` / `hwnd()` / `run_on_main_thread`
   calls; re-grep before upgrading.
4. Stress test on Windows (rapid window open/close, terminal + file watcher
   churn, exit while busy). Only if `0xc0000374` reappears, refresh `0001`
   for the new tao and re-enable it.
