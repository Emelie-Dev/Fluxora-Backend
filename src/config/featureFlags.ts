import crypto from 'crypto';
import fs from 'fs';
import { z } from 'zod';

const FLAG_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const DEFAULT_BUCKETS = 10000;

const FlagDefinitionSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().default(true),
    percentage: z.number().min(0).max(100).default(0),
  }).strict(),
]);

const FeatureFlagsSchema = z.record(
  z.string().regex(FLAG_NAME_PATTERN, 'flag names may contain letters, numbers, dot, colon, underscore, and dash'),
  FlagDefinitionSchema,
);

export type FeatureFlagDefinition = boolean | {
  enabled?: boolean;
  percentage?: number;
};

export type FeatureFlagMap = Record<string, FeatureFlagDefinition>;

export interface FeatureFlagContext {
  apiKey?: string | undefined;
  ip?: string | undefined;
}

type NormalizedFlag = {
  enabled: boolean;
  percentage: number;
};

type CachedFileFlags = {
  path: string;
  mtimeMs: number;
  flags: FeatureFlagMap;
};

let cachedFileFlags: CachedFileFlags | null = null;

/**
 * Parse FEATURE_FLAGS_JSON or FEATURE_FLAGS_FILE content into validated flag definitions.
 *
 * Supported shape:
 * `{ "streams.response_balances": { "enabled": true, "percentage": 25 } }`
 *
 * Boolean shorthand is also accepted: `{ "flag.name": true }`.
 *
 * @param raw Raw JSON object text from an environment variable or file.
 * @throws Error when JSON is malformed or flag definitions are invalid.
 */
export function parseFeatureFlags(raw: string): FeatureFlagMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Feature flag configuration must be valid JSON');
  }

  const result = FeatureFlagsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Feature flag configuration is invalid: ${result.error.issues[0]?.message ?? 'unknown error'}`);
  }

  return result.data;
}

/**
 * Load feature flag definitions from environment/config.
 *
 * FEATURE_FLAGS_JSON takes precedence over FEATURE_FLAGS_FILE. File-backed
 * configuration is re-read when its mtime changes, allowing percentage changes
 * without restarting the service. Missing configuration means all flags are off.
 *
 * @param env Environment object, defaults to process.env.
 * @returns Validated feature flag definitions.
 */
export function loadFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlagMap {
  const inlineJson = env.FEATURE_FLAGS_JSON;
  if (inlineJson && inlineJson.trim() !== '') {
    return parseFeatureFlags(inlineJson);
  }

  const filePath = env.FEATURE_FLAGS_FILE;
  if (!filePath || filePath.trim() === '') {
    return {};
  }

  const stat = fs.statSync(filePath);
  if (cachedFileFlags && cachedFileFlags.path === filePath && cachedFileFlags.mtimeMs === stat.mtimeMs) {
    return cachedFileFlags.flags;
  }

  const flags = parseFeatureFlags(fs.readFileSync(filePath, 'utf8'));
  cachedFileFlags = { path: filePath, mtimeMs: stat.mtimeMs, flags };
  return flags;
}

/**
 * Compute a deterministic rollout bucket for a flag/requester pair.
 *
 * The requester key is never persisted or logged here; only its SHA-256 digest
 * is used to derive a bucket in the range 0..9999.
 *
 * @param flagName Stable flag identifier.
 * @param requesterKey Stable requester identifier, preferably API key, then IP.
 * @returns Integer bucket in the rollout range.
 */
export function getFeatureFlagBucket(flagName: string, requesterKey: string): number {
  const digest = crypto
    .createHash('sha256')
    .update(`${flagName}:${requesterKey}`, 'utf8')
    .digest();
  return digest.readUInt32BE(0) % DEFAULT_BUCKETS;
}

/**
 * Evaluate a feature flag for a requester using LaunchDarkly-style percentage rollout.
 *
 * @param flagName Name of the flag to evaluate.
 * @param context Request-scoped identity. API key is preferred; IP is fallback.
 * @param env Environment object, defaults to process.env.
 * @returns True when the flag is enabled for this requester.
 */
export function isFeatureEnabled(
  flagName: string,
  context: FeatureFlagContext,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flags = loadFeatureFlags(env);
  const rawFlag = flags[flagName];
  if (rawFlag === undefined) return false;

  const normalized = normalizeFlag(rawFlag);
  if (!normalized.enabled || normalized.percentage <= 0) return false;
  if (normalized.percentage >= 100) return true;

  const requesterKey = context.apiKey?.trim() || context.ip?.trim();
  if (!requesterKey) return false;

  return getFeatureFlagBucket(flagName, requesterKey) < normalized.percentage * 100;
}

/**
 * Clear feature flag file cache for tests.
 *
 * @internal
 */
export function _resetFeatureFlagsForTest(): void {
  cachedFileFlags = null;
}

function normalizeFlag(flag: FeatureFlagDefinition): NormalizedFlag {
  if (typeof flag === 'boolean') {
    return { enabled: flag, percentage: flag ? 100 : 0 };
  }

  return {
    enabled: flag.enabled ?? true,
    percentage: flag.percentage ?? 0,
  };
}
