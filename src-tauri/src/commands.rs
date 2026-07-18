pub mod cmd_fs;
pub mod cmd_scan;
pub mod cmd_search;
pub mod cmd_stat;

// Re-export all command functions so lib.rs can continue using `commands::scan_directory`, etc.
pub use cmd_fs::*;
pub use cmd_scan::*;
pub use cmd_search::*;
pub use cmd_stat::*;
