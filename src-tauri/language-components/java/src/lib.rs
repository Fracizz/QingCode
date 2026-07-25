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
pub extern "C" fn qingcode_java_language() -> *const () {
    unsafe { tree_sitter_java::LANGUAGE.into_raw()() }
}

#[no_mangle]
pub extern "C" fn qingcode_java_tags() -> ComponentBytes {
    bytes(tree_sitter_java::TAGS_QUERY)
}

#[no_mangle]
pub extern "C" fn qingcode_java_locals() -> ComponentBytes {
    bytes("")
}
