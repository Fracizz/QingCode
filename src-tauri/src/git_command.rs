use std::io;
use std::path::Path;
use std::process::{Command, Output, Stdio};

/// Build a non-interactive Git command with the desktop process policy applied.
pub fn command(root: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn output(root: &Path, args: &[&str]) -> io::Result<Output> {
    command(root, args).output()
}
