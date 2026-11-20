use qingcode_contracts::*;
use std::{env, fs, path::Path};
use ts_rs::{Config, TS};

fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    assert!(
        args.is_empty() || args == ["--check"],
        "usage: export-file-ipc [--check]"
    );
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/lib/generated/fileIpc.ts");
    let mut output = String::from(
        "// Generated from qingcode-contracts by ts-rs. Do not edit.\n\
         // Regenerate: pnpm ipc:generate\n\
         // u64 maps to JSON number; file commands operate within safe integer limits.\n\n",
    );
    // 固定使用默认配置，避免 TS_RS_* 环境变量影响生成结果
    let cfg = Config::new();
    for declaration in [
        FileNode::decl(&cfg),
        FileStat::decl(&cfg),
        FileSlice::decl(&cfg),
        LineOffsetResult::decl(&cfg),
        RemoteFileNode::decl(&cfg),
        RemoteFileSlice::decl(&cfg),
    ] {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    if args == ["--check"] {
        let existing = fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert_eq!(
            existing, output,
            "File IPC bindings are stale. Run pnpm ipc:generate"
        );
    } else {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, output).unwrap();
    }
}
