//! Loader for `prompts/prompts.json` — the single source of truth for every
//! LLM prompt, JSON schema, token cap and truncation limit. The benchmark
//! harness (`bench/src/prompts.ts`) reads the same file, so evals always
//! measure exactly what the app sends. Bump `version` in the JSON whenever
//! anything in it changes.

use std::sync::LazyLock;

use serde_json::Value;

static PROMPTS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../prompts/prompts.json"))
        .expect("prompts/prompts.json must be valid JSON")
});

fn task(name: &str) -> &'static Value {
    let t = &LazyLock::force(&PROMPTS)[name];
    assert!(!t.is_null(), "prompts.json: missing task '{name}'");
    t
}

/// A template or fixed string belonging to a task (e.g. "system", "user").
pub fn text(task_name: &str, field: &str) -> &'static str {
    task(task_name)[field]
        .as_str()
        .unwrap_or_else(|| panic!("prompts.json: {task_name}.{field} must be a string"))
}

pub fn max_tokens(task_name: &str) -> u32 {
    task(task_name)["max_tokens"]
        .as_u64()
        .unwrap_or_else(|| panic!("prompts.json: {task_name}.max_tokens must be a number"))
        as u32
}

/// A named truncation/size limit (character counts unless stated otherwise).
pub fn limit(task_name: &str, name: &str) -> usize {
    task(task_name)["limits"][name]
        .as_u64()
        .unwrap_or_else(|| panic!("prompts.json: {task_name}.limits.{name} must be a number"))
        as usize
}

/// The task's JSON schema wrapped as an OpenAI-style `response_format` value.
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
pub fn fill(template: &str, vars: &[(&str, &str)]) -> String {
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
