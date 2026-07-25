#[repr(C)]
pub struct ComponentBytes {
    ptr: *const u8,
    len: usize,
}

fn bytes(value: &'static str) -> ComponentBytes {
    ComponentBytes {
        ptr: value.as_ptr(),
        len: value.len(),
    }
}

#[no_mangle]
pub extern "C" fn qingcode_language_component_abi() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn qingcode_javascript_language() -> *const () {
    unsafe { tree_sitter_javascript::LANGUAGE.into_raw()() }
}

#[no_mangle]
pub extern "C" fn qingcode_javascript_tags() -> ComponentBytes {
    bytes(tree_sitter_javascript::TAGS_QUERY)
}

#[no_mangle]
pub extern "C" fn qingcode_javascript_locals() -> ComponentBytes {
    bytes(tree_sitter_javascript::LOCALS_QUERY)
}

#[no_mangle]
pub extern "C" fn qingcode_typescript_language() -> *const () {
    unsafe { tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into_raw()() }
}

#[no_mangle]
pub extern "C" fn qingcode_typescript_tags() -> ComponentBytes {
    bytes(tree_sitter_typescript::TAGS_QUERY)
}

#[no_mangle]
pub extern "C" fn qingcode_typescript_locals() -> ComponentBytes {
    bytes(tree_sitter_typescript::LOCALS_QUERY)
}

#[no_mangle]
pub extern "C" fn qingcode_tsx_language() -> *const () {
    unsafe { tree_sitter_typescript::LANGUAGE_TSX.into_raw()() }
}

#[no_mangle]
pub extern "C" fn qingcode_tsx_tags() -> ComponentBytes {
    bytes(tree_sitter_typescript::TAGS_QUERY)
}

#[no_mangle]
pub extern "C" fn qingcode_tsx_locals() -> ComponentBytes {
    bytes(tree_sitter_typescript::LOCALS_QUERY)
}
