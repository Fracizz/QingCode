use super::*;
#[test]
fn refuses_another_user_or_gateway_before_stopping_processes() {
    let direct = DirectConnectionConfig {
        endpoint: "https://host:48763".into(),
        certificate_fingerprint: "a".repeat(64),
        token: "secret".into(),
        tunnel: None,
    };
    let mut info = DirectInfo {
        hostname: "0.0.0.0".into(),
        port: 48763,
        certificate_sha256: "a".repeat(64),
        server_version: "old".into(),
        protocol: 1,
        pid: 123,
        previous_ports: vec![],
        token: Some("secret".into()),
    };
    assert!(check_identity(&info, &direct).is_ok());
    info.token = Some("other".into());
    assert!(check_identity(&info, &direct).is_err());
    info.token = Some("secret".into());
    info.port = 51234;
    assert!(check_identity(&info, &direct).is_err());
    info.port = 48763;
    info.certificate_sha256 = "b".repeat(64);
    assert!(check_identity(&info, &direct).is_err());
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::process::Command;

    const SERVER: &str =
        r"C:\Users\Gateway Tests\.qingcode\server\old\qingcode-server-windows-x86_64.exe";
    const STATE: &str = r"C:\Users\Gateway Tests\.qingcode\server\run";

    /// Execute the generated maintenance script with process operations mocked, so
    /// a rejected identity or path must fail before reaching Stop-Process.
    fn run_stop_script(
        executable: &str,
        arguments: &str,
        identity_matches: bool,
    ) -> std::process::Output {
        let info = DirectInfo {
            hostname: "0.0.0.0".into(),
            port: 48763,
            certificate_sha256: "test-fingerprint".into(),
            server_version: "old".into(),
            protocol: 1,
            pid: 1234,
            previous_ports: Vec::new(),
            token: None,
        };
        let script = format!(
            r#"$global:stopped = $false
    function Read-TestGateway {{
        $global:LASTEXITCODE = 0
        '{{"pid":{pid},"port":48763,"certificateSha256":"test-fingerprint"}}'
    }}
    function Get-CimInstance {{
        [pscustomobject]@{{ ExecutablePath = {executable}; CommandLine = {command_line} }}
    }}
    function Stop-Process {{
        param($Id, $ErrorAction)
        if ($Id -ne 1234) {{ throw 'Unexpected process ID' }}
        $global:stopped = $true
    }}
    function Wait-Process {{ param($Id, $Timeout, $ErrorAction) }}
    try {{
        & {{
    {stop}
        }}
        if (!$global:stopped) {{ throw 'Stop-Process was not called' }}
        exit 0
    }} catch {{
        [Console]::Error.WriteLine($_.Exception.Message)
        [Console]::Error.WriteLine('stopped=' + $global:stopped)
        exit 1
    }}
    "#,
            pid = if identity_matches { 1234 } else { 9999 },
            executable = quote(executable),
            command_line = quote(&format!("\"{executable}\" {arguments}")),
            stop = stop_script("Read-TestGateway", &info),
        );
        // Exercise both shells used by Windows SSH hosts.
        let shell = std::env::var("QC_TEST_POWERSHELL").unwrap_or_else(|_| "powershell.exe".into());
        Command::new(shell)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ])
            .env("USERPROFILE", r"C:\Users\Gateway Tests")
            .output()
            .expect("run Windows gateway stop regression script")
    }

    fn assert_rejected(executable: &str, arguments: &str, identity_matches: bool, reason: &str) {
        let output = run_stop_script(executable, arguments, identity_matches);
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success(),
            "unexpectedly accepted {arguments}"
        );
        assert!(error.contains(reason), "{error}");
        assert!(error.contains("stopped=False"), "{error}");
    }

    #[test]
    fn gateway_stop_accepts_default_and_verbatim_state_paths() {
        for arguments in [
            "direct --port 48763".to_string(),
            format!("direct --state-dir \"{STATE}\""),
            format!(r#"direct --state-dir "\\?\{STATE}""#),
            format!(r#"direct --state-dir "\\?\{}""#, STATE.to_lowercase()),
        ] {
            let output = run_stop_script(SERVER, &arguments, true);
            assert!(
                output.status.success(),
                "{arguments}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn gateway_stop_rejects_custom_state_paths() {
        for state in [
            format!(r"{STATE}\custom"),
            format!(r"\\?\{STATE}\custom"),
            format!("{STATE}-other"),
            format!(r"D:{}", &STATE[2..]),
            r"\\other-host\share\run".into(),
        ] {
            assert_rejected(
                SERVER,
                &format!("direct --state-dir \"{state}\""),
                true,
                "Refusing to stop an unrecognized gateway",
            );
        }
    }

    #[test]
    fn gateway_stop_preserves_process_and_pairing_identity_checks() {
        for (executable, arguments, identity_matches, reason) in [
            (SERVER, "direct", false, "Direct identity changed"),
            (
                r"C:\Users\Gateway Tests\.qingcode\server-other\qingcode-server-windows-x86_64.exe",
                "direct",
                true,
                "Refusing to stop an unrecognized gateway",
            ),
            (
                r"C:\Users\Gateway Tests\.qingcode\server\old\other.exe",
                "direct",
                true,
                "Refusing to stop an unrecognized gateway",
            ),
            (
                SERVER,
                "daemon",
                true,
                "Refusing to stop an unrecognized gateway",
            ),
        ] {
            assert_rejected(executable, arguments, identity_matches, reason);
        }
    }
}
