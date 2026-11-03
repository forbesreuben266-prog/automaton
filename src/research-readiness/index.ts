/**
 * Public entry point of the real-world readiness checks (milestone R1).
 * Offline, pure and deterministic: no files, network, processes, clocks,
 * models or trading. Nothing here approves real-world input or feeds the
 * existing research engines.
 */

export {
  CHECK_STATUSES, MAX_DETAILS, READINESS_NOTICE, REAL_WORLD_INPUT_ENABLED, assertRealWorldInputApproved, overallOf, renderReadiness,
  type CheckStatus, type OverallStatus, type ReadinessCheck, type ReadinessResult, type ReadinessSubject,
} from "./readiness.js";
export {
  ASPECTS, ATTESTATION_STATUSES, BASES, SOURCE_CLASSES, contentMatches, trustSummary,
  type Aspect, type Attestation, type AttestationStatus, type Basis, type SourceClass, type SourceRecord, type TrustSummary,
} from "./provenance.js";
export {
  CLAIM_KINDS, FINANCIAL_BASES, MAX_SOURCE_AGE_DAYS_LIMIT, UNSUPPORTED_FINANCIAL_LABEL, assessBusinessEvidence, parseBusinessEvidence,
  type BusinessEvidenceBundle, type BusinessReadiness, type ClaimStanding, type EvidenceClaim, type Standing, type Support,
} from "./business.js";
export {
  EARLIEST_SUPPORTED_DATE, EXCHANGES, MARKET_ASSET_CLASSES, MARKET_FX_CURRENCIES, MAX_MARKET_BARS, STALE_RUN_BARS, assessMarketData,
  expectedCloseUtc, parseMarketData, type MarketBar, type MarketDataRecord, type MarketInstrument,
} from "./market-data.js";
export { ID_PATTERN, ReadinessInputError, UNSAFE_TEXT } from "./validation.js";
