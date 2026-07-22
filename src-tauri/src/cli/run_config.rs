//! Offline CRUD for `<project>/.qingcode/run.json`.

use super::db::{list_projects, open_db, resolve_project_for_run, run_json_path, ProjectRow};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunTask {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub task_type: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tasks: Vec<RunTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RunConfigFile {
    configs: Vec<RunConfig>,
}

const ALLOWED_TYPES: &[&str] = &["ps1", "bat", "sh", "command", "script"];

fn load_file(path: &Path) -> Result<Vec<RunConfig>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let configs = parsed
        .get("configs")
        .cloned()
        .unwrap_or(serde_json::Value::Array(vec![]));
    let list: Vec<RunConfig> =
        serde_json::from_value(configs).map_err(|e| format!("invalid configs: {e}"))?;
    Ok(list
        .into_iter()
        .filter(|c| !c.id.is_empty() && !c.name.is_empty())
        .map(normalize_config)
        .collect())
}

fn normalize_config(mut c: RunConfig) -> RunConfig {
    c.tasks = c
        .tasks
        .into_iter()
        .filter(|t| !t.id.is_empty() && !t.target.is_empty())
        .map(|mut t| {
            if !ALLOWED_TYPES.contains(&t.task_type.as_str()) {
                t.task_type = "command".into();
            }
            if let Some(cwd) = t.cwd.as_mut() {
                let trimmed = cwd.trim();
                if trimmed.is_empty() {
                    t.cwd = None;
                } else {
                    *cwd = trimmed.to_string();
                }
            }
            t.target = t.target.trim().to_string();
            t
        })
        .collect();
    c
}

fn save_file(path: &Path, configs: &[RunConfig]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let file = RunConfigFile {
        configs: configs.to_vec(),
    };
    let content =
        serde_json::to_string_pretty(&file).map_err(|e| format!("encode run.json: {e}"))?;
    fs::write(path, content + "\n").map_err(|e| format!("write {}: {e}", path.display()))
}

fn resolve_config<'a>(configs: &'a [RunConfig], query: &str) -> Result<&'a RunConfig, String> {
    let q = query.trim();
    if let Some(c) = configs.iter().find(|c| c.id == q) {
        return Ok(c);
    }
    let by_name: Vec<_> = configs.iter().filter(|c| c.name == q).collect();
    if by_name.len() == 1 {
        return Ok(by_name[0]);
    }
    if by_name.len() > 1 {
        return Err(format!("ambiguous run config name '{q}'"));
    }
    Err(format!("run config not found: {q}"))
}

fn project_for(query: Option<&str>) -> Result<ProjectRow, String> {
    let conn = open_db()?;
    let projects = list_projects(&conn)?;
    resolve_project_for_run(&projects, query)
}

pub fn list(project: Option<&str>) -> Result<serde_json::Value, String> {
    let project = project_for(project)?;
    let path = run_json_path(&project.path);
    let configs = load_file(&path)?;
    Ok(serde_json::json!({
        "project": { "id": project.id, "name": project.name, "path": project.path },
        "path": path.to_string_lossy(),
        "configs": configs,
    }))
}

pub fn get(query: &str, project: Option<&str>) -> Result<serde_json::Value, String> {
    let project = project_for(project)?;
    let path = run_json_path(&project.path);
    let configs = load_file(&path)?;
    let config = resolve_config(&configs, query)?;
    Ok(serde_json::json!({
        "project": { "id": project.id, "name": project.name, "path": project.path },
        "config": config,
    }))
}

fn read_json_source(source: &str) -> Result<String, String> {
    if source == "-" {
        let mut buf = String::new();
        io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| format!("read stdin: {e}"))?;
        return Ok(buf);
    }
    fs::read_to_string(source).map_err(|e| format!("read {source}: {e}"))
}

fn parse_upsert_body(raw: &str) -> Result<RunConfig, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid json: {e}"))?;
    // Allow either a bare config object or `{ "config": {...} }`.
    let mut obj = if value.get("name").is_some() || value.get("tasks").is_some() {
        value
    } else {
        value
            .get("config")
            .cloned()
            .ok_or_else(|| "json must be a run config object".to_string())?
    };
    let map = obj
        .as_object_mut()
        .ok_or_else(|| "json must be a run config object".to_string())?;
    if map
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        map.insert(
            "id".into(),
            serde_json::Value::String(uuid::Uuid::new_v4().to_string()),
        );
    }
    if let Some(tasks) = map.get_mut("tasks").and_then(|v| v.as_array_mut()) {
        for task in tasks {
            let Some(t) = task.as_object_mut() else {
                continue;
            };
            if t.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .is_empty()
            {
                t.insert(
                    "id".into(),
                    serde_json::Value::String(uuid::Uuid::new_v4().to_string()),
                );
            }
            if t.get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .is_empty()
            {
                t.insert("type".into(), serde_json::Value::String("command".into()));
            }
        }
    }
    let config: RunConfig =
        serde_json::from_value(obj).map_err(|e| format!("invalid run config: {e}"))?;
    if config.name.trim().is_empty() {
        return Err("config.name is required".into());
    }
    for task in &config.tasks {
        if task.target.trim().is_empty() {
            return Err("each task.target is required".into());
        }
    }
    Ok(normalize_config(config))
}

pub fn upsert(json_source: &str, project: Option<&str>) -> Result<serde_json::Value, String> {
    let project = project_for(project)?;
    let path = run_json_path(&project.path);
    let mut configs = load_file(&path)?;
    let incoming = parse_upsert_body(&read_json_source(json_source)?)?;

    let action = if let Some(idx) = configs.iter().position(|c| c.id == incoming.id) {
        configs[idx] = incoming.clone();
        "updated"
    } else if let Some(idx) = configs.iter().position(|c| c.name == incoming.name) {
        let mut next = incoming.clone();
        next.id = configs[idx].id.clone();
        configs[idx] = next.clone();
        save_file(&path, &configs)?;
        return Ok(serde_json::json!({
            "project": { "id": project.id, "name": project.name, "path": project.path },
            "action": "updated",
            "config": next,
        }));
    } else {
        configs.push(incoming.clone());
        "created"
    };
    save_file(&path, &configs)?;
    Ok(serde_json::json!({
        "project": { "id": project.id, "name": project.name, "path": project.path },
        "action": action,
        "config": incoming,
    }))
}

pub fn remove(query: &str, project: Option<&str>) -> Result<serde_json::Value, String> {
    let project = project_for(project)?;
    let path = run_json_path(&project.path);
    let mut configs = load_file(&path)?;
    let target = resolve_config(&configs, query)?.clone();
    configs.retain(|c| c.id != target.id);
    save_file(&path, &configs)?;
    Ok(serde_json::json!({
        "project": { "id": project.id, "name": project.name, "path": project.path },
        "removed": target,
    }))
}
