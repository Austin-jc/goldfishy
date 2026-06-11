//! Loader for `prompts/prompts.json` — the single source of truth for every
//! LLM prompt, JSON schema, token cap and truncation limit — plus a runtime
//! override layer that makes prompt text (and max_tokens) user-tunable from
//! Settings. Overrides persist as the `prompt_overrides` settings-table key
//! (loaded at startup in `lib.rs`, validated + written by
//! `commands::set_prompt_overrides`) and win field-by-field over the built-in
//! defaults. Schemas and truncation limits stay code-owned. The benchmark
//! harness (`bench/src/prompts.ts`) reads the defaults file, so evals measure
//! the defaults — not user edits. Bump `version` in the JSON whenever the
//! defaults change.

use std::sync::{LazyLock, RwLock};

use serde_json::Value;

static DEFAULTS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../prompts/prompts.json"))
        .expect("prompts/prompts.json must be valid JSON")
});

/// User overrides, shaped like a sparse prompts.json: `{task: {field: value}}`.
static OVERRIDES: LazyLock<RwLock<Value>> = LazyLock::new(|| RwLock::new(Value::Null));

pub fn defaults() -> &'static Value {
    LazyLock::force(&DEFAULTS)
}

pub fn overrides() -> Value {
    OVERRIDES.read().unwrap().clone()
}

pub fn set_overrides(v: Value) {
    *OVERRIDES.write().unwrap() = v;
}

fn task(name: &str) -> &'static Value {
    let t = &defaults()[name];
    assert!(!t.is_null(), "prompts.json: missing task '{name}'");
    t
}

/// A template or fixed string belonging to a task (e.g. "system", "user").
/// A well-typed user override wins; anything else falls back to the default.
pub fn text(task_name: &str, field: &str) -> String {
    if let Some(s) = OVERRIDES.read().unwrap()[task_name][field].as_str() {
        return s.to_string();
    }
    task(task_name)[field]
        .as_str()
        .unwrap_or_else(|| panic!("prompts.json: {task_name}.{field} must be a string"))
        .to_string()
}

pub fn max_tokens(task_name: &str) -> u32 {
    if let Some(n) = OVERRIDES.read().unwrap()[task_name]["max_tokens"].as_u64() {
        return n.clamp(16, 8192) as u32;
    }
    task(task_name)["max_tokens"]
        .as_u64()
        .unwrap_or_else(|| panic!("prompts.json: {task_name}.max_tokens must be a number"))
        as u32
}

/// A named truncation/size limit (character counts unless stated otherwise).
/// Defaults only — limits are code-owned, not user-tunable.
pub fn limit(task_name: &str, name: &str) -> usize {
    task(task_name)["limits"][name]
        .as_u64()
        .unwrap_or_else(|| panic!("prompts.json: {task_name}.limits.{name} must be a number"))
        as usize
}

/// The task's JSON schema wrapped as an OpenAI-style `response_format` value.
/// Defaults only — schemas are code-owned, not user-tunable.
pub fn response_format(task_name: &str) -> Value {
    let t = task(task_name);
    assert!(
        !t["schema"].is_null(),
        "prompts.json: task '{task_name}' has no schema"
    );
    serde_json::json!({
        "type": "json_schema",
        "json_schema": {
            "name": t["schema_name"],
            "strict": true,
            "schema": t["schema"],
        },
    })
}

/// Replace `{key}` placeholders with the given values in a single left-to-right
/// pass, so substituted values (note content, tag lists) are never re-scanned
/// for placeholders. Unknown `{...}` sequences — like the literal JSON examples
/// in the prompts — pass through untouched.
pub fn fill(template: impl AsRef<str>, vars: &[(&str, &str)]) -> String {
    let template = template.as_ref();
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    'scan: while let Some(start) = rest.find('{') {
        for (k, v) in vars {
            let pattern_len = k.len() + 2;
            if rest[start..].starts_with('{')
                && rest.len() >= start + pattern_len
                && rest[start + 1..].starts_with(k)
                && rest[start + 1 + k.len()..].starts_with('}')
            {
                out.push_str(&rest[..start]);
                out.push_str(v);
                rest = &rest[start + pattern_len..];
                continue 'scan;
            }
        }
        out.push_str(&rest[..=start]);
        rest = &rest[start + 1..];
    }
    out.push_str(rest);
    out
}
