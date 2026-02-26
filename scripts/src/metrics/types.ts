export interface MetricsReport {
  metrics_schema_version: "1.0.0";
  runId: string;

  // M1
  schema_valid?: number;
  // M2
  apply_success?: number;
  // M3
  blocked_reason?: string;
  // M4
  yaml_hash?: string;

  // M5
  anchor_compliance_accepted_nontrivial?: number;
  accepted_nontrivial_count?: number;
  accepted_nontrivial_with_anchor_count?: number;

  // M6
  anchor_resolvability_rate_accepted?: number;
  resolvable_anchor_count?: number;
  total_evaluated_anchor_count?: number;

  // M7
  anchored_field_coverage_leaf?: number;
  populated_leaf_count?: number;
  populated_leaf_anchored_count?: number;

  // M9
  facts_total?: number;

  // M10
  gate_ok_count?: number;
  gate_warn_count?: number;
  gate_require_count?: number;
  gate_ok_pct?: number;
  gate_warn_pct?: number;
  gate_require_pct?: number;

  // M11
  provenance_extracted_count?: number;
  provenance_inferred_count?: number;
  provenance_manual_count?: number;
  provenance_extracted_pct?: number;
  provenance_inferred_pct?: number;
  provenance_manual_pct?: number;

  // M12
  decision_accepted_count?: number;
  decision_edited_count?: number;
  decision_rejected_count?: number;
  decision_undecided_count?: number;
  decision_accepted_pct?: number;
  decision_edited_pct?: number;
  decision_rejected_pct?: number;
  decision_undecided_pct?: number;

  // M13
  apply_attempts_until_success?: number;

  // M14
  msc_diff_lines?: number;
  added_lines?: number;
  removed_lines?: number;

  // M15
  expected_section_hit_rate?: number;
  expected_sections?: string[];
  touched_sections?: string[];

  // M16
  off_target_section_count?: number;
  off_target_path_count?: number;
  off_target_sections?: string[];

  // ── Telemetry (aggregated across all LLM passes) ──
  total_latency_ms?: number;
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_tokens?: number;
  total_retries?: number;
  estimated_cost_usd?: number;

  // ── Per-pass breakdown ──
  pass_extractor_latency_ms?: number;
  pass_extractor_prompt_tokens?: number;
  pass_extractor_completion_tokens?: number;
  pass_reasoner_latency_ms?: number;
  pass_reasoner_prompt_tokens?: number;
  pass_reasoner_completion_tokens?: number;
  pass_verifier_latency_ms?: number;
  pass_verifier_prompt_tokens?: number;
  pass_verifier_completion_tokens?: number;
  pass_notes_latency_ms?: number;
  pass_notes_prompt_tokens?: number;
  pass_notes_completion_tokens?: number;

  // ── LLM provenance ──
  llm_model?: string;
  generated_at?: string;

  // Pointers
  proposal_path?: string;
  decisions_path?: string;
  receipt_path?: string;
  msc_commit_sha?: string;
}
