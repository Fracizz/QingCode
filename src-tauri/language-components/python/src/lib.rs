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
pub extern "C" fn qingcode_python_language() -> *const () {
    unsafe { tree_sitter_python::LANGUAGE.into_raw()() }
}

#[no_mangle]
pub extern "C" fn qingcode_python_tags() -> ComponentBytes {
    bytes(tree_sitter_python::TAGS_QUERY)
}

#[no_mangle]
pub extern "C" fn qingcode_python_locals() -> ComponentBytes {
    bytes("")
}
