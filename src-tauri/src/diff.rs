use std::collections::HashMap;

/// Decide whether the text changed enough to justify re-running an AI pipeline.
/// Minor typo fixes (a couple of changed words) are skipped so the queues stay quiet.
pub fn significant_change(last_processed: Option<&str>, new_input: &str) -> bool {
    let Some(old) = last_processed else {
        return true;
    };
    if old == new_input {
        return false;
    }

    let mut counts: HashMap<&str, i64> = HashMap::new();
    let mut old_total: i64 = 0;
    let mut new_total: i64 = 0;
    for w in old.split_whitespace() {
        *counts.entry(w).or_default() += 1;
        old_total += 1;
    }
    for w in new_input.split_whitespace() {
        *counts.entry(w).or_default() -= 1;
        new_total += 1;
    }
    let changed: i64 = counts.values().map(|v| v.abs()).sum();
    let total = old_total.max(new_total).max(1);

    changed >= 4 || (changed as f64 / total as f64) > 0.15
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typo_fix_is_minor() {
        let old = "The quick brown fox jumps over the lazy dog every single morning before breakfast";
        let new = "The quick brown fox jumps over the lazy dog every single morning before brekfast";
        assert!(!significant_change(Some(old), new));
    }

    #[test]
    fn new_sentence_is_significant() {
        let old = "The quick brown fox jumps over the lazy dog";
        let new = "The quick brown fox jumps over the lazy dog. Later it went home and slept all afternoon.";
        assert!(significant_change(Some(old), new));
    }

    #[test]
    fn never_processed_is_significant() {
        assert!(significant_change(None, "anything"));
    }
}
