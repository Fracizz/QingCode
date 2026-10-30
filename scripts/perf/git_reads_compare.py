#!/usr/bin/env python3
"""Build a std-only harness from current Rust Git code, then compare old/new reads."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


DRIVER = r'''
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
static SPAWNS: AtomicUsize = AtomicUsize::new(0);
mod git_command;
mod sync_cache;

fn run_git(root: &Path, args: &[&str]) -> Result<Output, String> {
    SPAWNS.fetch_add(1, Ordering::Relaxed);
    git_command::output(root, args).map_err(|error| error.to_string())
}
fn decode_git_text(bytes: &[u8]) -> String { String::from_utf8_lossy(bytes).into_owned() }
fn git_output_text(output: &Output) -> String { decode_git_text(&output.stderr) }

fn old_branches(root: &Path) -> Result<GitBranchList, String> {
    let a = run_git(root, &["for-each-ref", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)", "refs/heads"])?;
    let b = run_git(root, &["for-each-ref", "--format=%(refname:short)", "refs/remotes"])?;
    assert!(a.status.success() && b.status.success());
    let local = decode_git_text(&a.stdout).lines().filter_map(|line| {
        let mut parts = line.splitn(3, '\t');
        let name = parts.next()?.trim();
        let current = parts.next().unwrap_or("") == "*";
        let upstream = parts.next().unwrap_or("").trim();
        Some(GitBranchInfo { name: name.to_string(), current, upstream: (!upstream.is_empty()).then(|| upstream.to_string()) })
    }).collect();
    let remote = decode_git_text(&b.stdout).lines().filter(|name| !name.is_empty() && !name.ends_with("/HEAD")).map(str::to_string).collect();
    Ok(GitBranchList { local, remote })
}
fn full_status(root: &Path, upstream: Option<&str>, optimized: bool) -> Result<(Option<i64>, Option<i64>, Option<i64>), String> {
    let result = run_git(root, &["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=dirty"])?;
    assert!(result.status.success());
    Ok(if optimized { read_sync_times(root, upstream) } else { legacy_read_sync_times(root, upstream) })
}
fn emit(root: &Path, name: &str, samples: usize, operation: impl Fn()) {
    let mut times = Vec::new();
    let mut counts = Vec::new();
    for i in 0..samples + 3 {
        SPAWNS.store(0, Ordering::Relaxed);
        let started = Instant::now();
        operation();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let calls = SPAWNS.load(Ordering::Relaxed);
        if i >= 3 { times.push(elapsed); counts.push(calls); }
    }
    println!("{{\"operation\":\"{name}\",\"samplesMs\":{times:?},\"gitSubprocessCounts\":{counts:?}}}");
    let _ = root;
}
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let root = Path::new(&args[0]);
    let samples = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(25);
    let upstream_result = run_git(root, &["for-each-ref", "--format=%(HEAD)%09%(upstream:short)", "refs/heads"]).unwrap();
    let upstream_text = decode_git_text(&upstream_result.stdout);
    let upstream = upstream_text.lines().find_map(|line| line.strip_prefix("*\t")).filter(|s| !s.is_empty());
    let legacy = old_branches(root).unwrap();
    let current = list_branches(root).unwrap();
    assert_eq!(format!("{legacy:?}"), format!("{current:?}"));
    assert_eq!(legacy_read_sync_times(root, upstream), read_sync_times(root, upstream));
    emit(root, "branches_before", samples, || { old_branches(root).unwrap(); });
    emit(root, "branches_after", samples, || { list_branches(root).unwrap(); });
    emit(root, "full_status_before", samples, || { full_status(root, upstream, false).unwrap(); });
    emit(root, "full_status_after_warm", samples, || { full_status(root, upstream, true).unwrap(); });
    println!("{{\"parity\":true}}");
}
'''


def emit_source(output):
    repo = Path(__file__).resolve().parents[2]
    source = (repo / 'src-tauri/src/git.rs').read_text()
    sync = source[source.index('fn resolve_git_path('):source.index('/// Parse porcelain v1')]
    legacy = sync[sync.index('fn read_sync_times('):]
    legacy = re.sub(r'    if let Some\(times\) = sync_cache::read\(root, upstream\) \{\s*return times;\s*\}\n', '', legacy)
    legacy = legacy.replace('fn read_sync_times(', 'fn legacy_read_sync_times(', 1)
    structs = source[source.index('#[derive(Debug, Serialize, Clone)]\npub struct GitBranchInfo'):source.index('/// Parse `git remote -v`')]
    structs = structs.replace('Serialize, ', '')
    branches = source[source.index('/// Include the full ref'):source.index('fn switch_branch(')]
    output.mkdir(parents=True, exist_ok=True)
    (output / 'main.rs').write_text(DRIVER + sync + legacy + structs + branches, encoding='utf-8')
    for name, original in [('sync_cache.rs', repo / 'src-tauri/src/git/sync_cache.rs'), ('git_command.rs', repo / 'src-tauri/src/git_command.rs')]:
        (output / name).write_bytes(original.read_bytes())
    manifest = {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest() for path in [repo / 'src-tauri/src/git.rs', repo / 'src-tauri/src/git/sync_cache.rs', repo / 'src-tauri/src/git_command.rs']}
    (output / 'source-hashes.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'sourceDirectory': str(output), 'hashes': manifest}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', required=True, type=Path)
    parser.add_argument('--emit-only', action='store_true')
    args = parser.parse_args()
    emit_source(args.source_dir)
    if not args.emit_only:
        subprocess.run(['rustc', '--edition=2021', '-O', str(args.source_dir / 'main.rs'), '-o', str(args.source_dir / 'git-reads-compare')], check=True)


if __name__ == '__main__':
    main()
