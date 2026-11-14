use super::*;

fn fixture() -> (PathBuf, FileAccess) {
    let root = std::env::temp_dir().join(format!("qingcode-mobile-files-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let access = FileAccess {
        path: root.to_string_lossy().into_owned(),
        excludes: vec!["**/excluded".into()],
        exclude_git_ignore: false,
    };
    (root, access)
}

#[test]
fn project_relative_paths_reject_escape_and_platform_paths() {
    for path in [
        "../secret",
        "x/../secret",
        "/etc/passwd",
        "C:/secret",
        "x\\secret",
        "x//secret",
        "./secret",
        "x/",
        "x\0y",
    ] {
        assert!(validate_relative(path).is_err(), "{path:?}");
    }
    for path in ["", "src/index.ts", "中文/文件.txt", ".env"] {
        assert!(validate_relative(path).is_ok());
    }
}

#[test]
fn browse_and_search_apply_the_same_hidden_and_excluded_rules() {
    let (root, access) = fixture();
    fs::create_dir_all(root.join("src/deep")).unwrap();
    fs::create_dir_all(root.join("excluded")).unwrap();
    fs::write(root.join("src/deep/中文.rs"), b"rust").unwrap();
    fs::write(root.join("excluded/中文.rs"), b"excluded").unwrap();
    fs::write(root.join(".中文.rs"), b"hidden").unwrap();
    let list = local_operate(&access, &FileRequest::list("".into(), false)).unwrap();
    assert_eq!(list["entries"].as_array().unwrap().len(), 1);
    let result = local_operate(
        &access,
        &FileRequest::search("".into(), "中文".into(), false),
    )
    .unwrap();
    assert_eq!(result["entries"].as_array().unwrap().len(), 1);
    assert_eq!(result["entries"][0]["path"], "src/deep/中文.rs");
    let hidden = local_operate(
        &access,
        &FileRequest::search("".into(), "中文".into(), true),
    )
    .unwrap();
    assert_eq!(hidden["entries"].as_array().unwrap().len(), 2);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn search_honors_query_root_and_marks_result_limit() {
    let (root, access) = fixture();
    fs::create_dir(root.join("sub")).unwrap();
    fs::write(root.join("outside.txt"), b"x").unwrap();
    for i in 0..=SEARCH_LIMIT {
        fs::write(root.join(format!("sub/{i}.txt")), b"x").unwrap();
    }
    let value = local_operate(
        &access,
        &FileRequest::search("sub".into(), ".txt".into(), true),
    )
    .unwrap();
    assert_eq!(value["entries"].as_array().unwrap().len(), SEARCH_LIMIT);
    assert_eq!(value["truncated"], true);
    assert!(value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["path"].as_str().unwrap().starts_with("sub/")));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn binary_download_is_bounded_and_detects_changed_files() {
    let (root, access) = fixture();
    let bytes = vec![0xff; CHUNK_LIMIT as usize + 19];
    fs::write(root.join("binary.dat"), &bytes).unwrap();
    let stat = local_operate(&access, &FileRequest::stat("binary.dat".into())).unwrap();
    let version = stat["version"].as_str().unwrap().to_string();
    let chunk = local_operate(
        &access,
        &FileRequest::chunk("binary.dat".into(), version.clone(), 0, CHUNK_LIMIT),
    )
    .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(chunk["data"].as_str().unwrap())
            .unwrap(),
        bytes[..CHUNK_LIMIT as usize]
    );
    assert_eq!(chunk["nextOffset"], CHUNK_LIMIT);
    assert_eq!(chunk["eof"], false);
    let tail = local_operate(
        &access,
        &FileRequest::chunk(
            "binary.dat".into(),
            version.clone(),
            CHUNK_LIMIT,
            CHUNK_LIMIT,
        ),
    )
    .unwrap();
    assert_eq!(tail["eof"], true);
    fs::write(root.join("binary.dat"), b"changed").unwrap();
    assert!(local_operate(
        &access,
        &FileRequest::chunk("binary.dat".into(), version, 0, CHUNK_LIMIT)
    )
    .unwrap_err()
    .contains("已变化"));
    assert!(local_operate(
        &access,
        &FileRequest::chunk("binary.dat".into(), "version".into(), 0, CHUNK_LIMIT + 1)
    )
    .is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn zero_byte_download_returns_eof_without_allocating_a_full_chunk() {
    let (root, access) = fixture();
    fs::write(root.join("empty"), b"").unwrap();
    let stat = local_operate(&access, &FileRequest::stat("empty".into())).unwrap();
    let value = local_operate(
        &access,
        &FileRequest::chunk(
            "empty".into(),
            stat["version"].as_str().unwrap().into(),
            0,
            CHUNK_LIMIT,
        ),
    )
    .unwrap();
    assert_eq!(value["data"], "");
    assert_eq!(value["nextOffset"], 0);
    assert_eq!(value["eof"], true);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn symlink_cannot_escape_selected_project_even_to_a_sibling_project() {
    let (root, access) = fixture();
    let outside = root.with_extension("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), b"no").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
    assert!(local_operate(&access, &FileRequest::stat("escape/secret".into())).is_err());
    let list = local_operate(&access, &FileRequest::list("".into(), true)).unwrap();
    assert!(list["entries"].as_array().unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[cfg(unix)]
#[test]
fn download_rejects_non_regular_files_before_opening() {
    let (root, access) = fixture();
    assert!(local_operate(&access, &FileRequest::stat("".into()))
        .unwrap_err()
        .contains("普通文件"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn source_replacement_is_rejected_after_open_even_when_length_is_unchanged() {
    let (root, access) = fixture();
    let path = root.join("source");
    fs::write(&path, b"before").unwrap();
    let opened = File::open(&path).unwrap();
    let version = local_stamp(&path, &opened.metadata().unwrap());
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"after!").unwrap();
    assert!(local_source_unchanged(&root, "source", &path, &version).is_err());
    assert!(local_operate(
        &access,
        &FileRequest::chunk("source".into(), version, 0, CHUNK_LIMIT)
    )
    .is_err());
    drop(opened);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn source_swapped_to_outside_symlink_is_rejected_after_open() {
    let (root, _) = fixture();
    let outside = root.with_extension("outside");
    fs::write(&outside, b"secret").unwrap();
    let path = root.join("source");
    fs::write(&path, b"inside").unwrap();
    let opened = File::open(&path).unwrap();
    let version = local_stamp(&path, &opened.metadata().unwrap());
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(local_source_unchanged(&root, "source", &path, &version).is_err());
    drop(opened);
    fs::remove_dir_all(root).unwrap();
    fs::remove_file(outside).unwrap();
}

#[test]
fn relative_path_rules_allow_posix_colons_and_reject_windows_streams() {
    assert!(validate_platform_relative("notes:2026.txt", false).is_ok());
    assert!(validate_platform_relative("sub/notes:2026.txt", false).is_ok());
    assert!(validate_platform_relative("sub/notes:2026.txt", true).is_err());
    for path in ["C:secret", "C:/secret", "z:relative"] {
        assert!(validate_platform_relative(path, false).is_err());
    }
}

#[cfg(unix)]
#[test]
fn posix_colon_names_browse_search_and_download_without_poisoning_the_directory() {
    let (root, access) = fixture();
    fs::write(root.join("notes:2026.txt"), b"colon contents").unwrap();
    // Other POSIX names remain unsupported by the portable relative-path contract;
    // they must not make normal entries disappear behind a directory error.
    fs::write(root.join("C:drive-style"), b"unsupported").unwrap();
    fs::write(root.join("back\\slash"), b"unsupported").unwrap();
    let list = local_operate(&access, &FileRequest::list("".into(), false)).unwrap();
    assert_eq!(list["entries"].as_array().unwrap().len(), 1);
    assert_eq!(list["entries"][0]["name"], "notes:2026.txt");
    assert_eq!(list["truncated"], true);
    let search = local_operate(
        &access,
        &FileRequest::search("".into(), "notes:2026".into(), false),
    )
    .unwrap();
    assert_eq!(search["entries"][0]["path"], "notes:2026.txt");
    let stat = local_operate(&access, &FileRequest::stat("notes:2026.txt".into())).unwrap();
    let chunk = local_operate(
        &access,
        &FileRequest::chunk(
            "notes:2026.txt".into(),
            stat["version"].as_str().unwrap().into(),
            0,
            CHUNK_LIMIT,
        ),
    )
    .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(chunk["data"].as_str().unwrap())
            .unwrap(),
        b"colon contents"
    );
    fs::remove_dir_all(root).unwrap();
}
