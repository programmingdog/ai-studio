pub fn can_transition(from: &str, to: &str) -> bool {
    if matches!(
        to,
        "FAILED"
            | "CANCELLED"
            | "PAUSED"
            | "WAITING_NETWORK"
            | "WAITING_CREDIT"
            | "WAITING_LICENSE"
    ) {
        return !matches!(from, "COMPLETED" | "FAILED" | "CANCELLED");
    }
    matches!(
        (from, to),
        ("PENDING", "PREPARING")
            | ("PENDING", "RUNNING")
            | ("PREPARING", "RUNNING")
            | ("RUNNING", "UPLOADING")
            | ("RUNNING", "POST_PROCESSING")
            | ("RUNNING", "COMPLETED")
            | ("UPLOADING", "REMOTE_PROCESSING")
            | ("REMOTE_PROCESSING", "DOWNLOADING")
            | ("DOWNLOADING", "POST_PROCESSING")
            | ("POST_PROCESSING", "QC")
            | ("POST_PROCESSING", "COMPLETED")
            | ("QC", "COMPLETED")
            | ("PAUSED", "PENDING")
            | ("FAILED", "PENDING")
            | ("WAITING_NETWORK", "PENDING")
            | ("WAITING_CREDIT", "PENDING")
            | ("WAITING_LICENSE", "PENDING")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_jobs_cannot_restart_implicitly() {
        assert!(!can_transition("COMPLETED", "RUNNING"));
        assert!(can_transition("FAILED", "PENDING"));
    }
}
