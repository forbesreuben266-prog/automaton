/**
 * The only bridge between the Phase 1A offline research pipeline and the
 * Phase 0 business research division (approved boundary exception, decision
 * B). It re-exports a reviewed list of names from the division's public index
 * and contains no logic. Every other pipeline module imports the division
 * only through this file; the division's boundary test allows no other file
 * outside it to import or name it, and no other import of it than the public
 * index.
 *
 * Deliberately NOT re-exported: the run budget and the model port
 * (RunBudgetController, DISABLED_MODEL_PORT, InferenceDisabledError,
 * ResearchModelPort). Phase 1A makes no model calls, so the pipeline has no
 * route to inference code.
 */

export {
  // validation helpers
  Issues, SchemaError, arr, bool, checkKeys, id, isPlainObject, isoDate, isoDateTime, oneOf, safeInt, str, uniqueIds,
  // sources and claims
  CLAIM_TYPES, MAX_CITATIONS_PER_CLAIM, MAX_CLAIMS, MAX_SNAPSHOTS, MAX_SNAPSHOT_CHARS, MAX_TOTAL_SNAPSHOT_CHARS, MIN_QUOTE_CHARS,
  createSnapshot, parseSourcesAndClaims, sha256Hex,
  // citations and evidence
  EVIDENCE_GRADES, gradeEvidence, gradeEvidenceSets, originGroups, sourceIdentityConflicts, verifyClaims,
  // finance
  CURRENCIES, SCENARIO_NAMES, UNITS, calculateScenarios, formatMoney, parseAssumptions, parseScenarioDefinitions,
  // scoring
  CRITERIA, HARD_GATES, HIGH_SCORE_MIN_SOURCES, VERDICT_THRESHOLDS, parseScoring, scoreOpportunity,
  // report
  MIN_FAILURE_REASONS, QUOTE_VERIFICATION_LEGEND, ReportValidationError, renderReport, validateReport,
  // proposals (inert)
  ProposalQueue, parseExperimentProposal,
  // output escaping
  escapeInline, renderUrl,
} from "../divisions/business-research/index.js";

export type {
  Assumption, Citation, Claim, ClaimType, ClaimVerification, Competitor, Confidence, CriterionResult, Currency, EvidenceAssessment,
  EvidenceGrade, ExperimentProposal, GateStatus, HardGateResult, ProposalStatus, ReportSections, ReportValidation, ResearchReport,
  ScenarioDefinition, ScenarioName, ScenarioResult, ScoreResult, SourceSnapshot, StoredProposal, Verdict,
} from "../divisions/business-research/index.js";
