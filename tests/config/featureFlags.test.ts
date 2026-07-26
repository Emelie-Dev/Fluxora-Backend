import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  _resetFeatureFlagsForTest,
  getFeatureFlagBucket,
  isFeatureEnabled,
  loadFeatureFlags,
  parseFeatureFlags,
} from '../../src/config/featureFlags.js';

describe('feature flag service', () => {
  afterEach(() => {
    _resetFeatureFlagsForTest();
  });

  it('keeps missing flags disabled', () => {
    expect(isFeatureEnabled('streams.response_balances', { apiKey: 'key-a' }, {})).toBe(false);
  });

  it('supports boolean shorthand definitions', () => {
    const env = { FEATURE_FLAGS_JSON: '{"streams.response_balances":true}' };
    expect(isFeatureEnabled('streams.response_balances', { apiKey: 'key-a' }, env)).toBe(true);
  });

  it('uses deterministic buckets for the same flag and requester', () => {
    const first = getFeatureFlagBucket('streams.response_balances', 'api-key-1');
    const second = getFeatureFlagBucket('streams.response_balances', 'api-key-1');
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(10000);
  });

  it('keeps rollout decisions stable for a fixed percentage', () => {
    const env = {
      FEATURE_FLAGS_JSON: '{"streams.response_balances":{"enabled":true,"percentage":50}}',
    };
    const decision = isFeatureEnabled('streams.response_balances', { apiKey: 'stable-key' }, env);

    expect(isFeatureEnabled('streams.response_balances', { apiKey: 'stable-key' }, env)).toBe(decision);
    expect(isFeatureEnabled('streams.response_balances', { ip: '203.0.113.10' }, env)).toBe(
      isFeatureEnabled('streams.response_balances', { ip: '203.0.113.10' }, env),
    );
  });

  it('honors disabled and zero-percent definitions', () => {
    expect(isFeatureEnabled(
      'flag.off',
      { apiKey: 'key-a' },
      { FEATURE_FLAGS_JSON: '{"flag.off":{"enabled":false,"percentage":100}}' },
    )).toBe(false);

    expect(isFeatureEnabled(
      'flag.zero',
      { apiKey: 'key-a' },
      { FEATURE_FLAGS_JSON: '{"flag.zero":{"enabled":true,"percentage":0}}' },
    )).toBe(false);
  });

  it('validates JSON and percentages', () => {
    expect(() => parseFeatureFlags('{')).toThrow(/valid JSON/);
    expect(() => parseFeatureFlags('{"flag":{"percentage":101}}')).toThrow(/invalid/i);
    expect(() => parseFeatureFlags('{"bad flag":true}')).toThrow(/flag names/i);
  });

  it('loads file-backed flags and refreshes when the file changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-flags-'));
    const file = path.join(dir, 'flags.json');
    fs.writeFileSync(file, '{"streams.response_balances":{"enabled":true,"percentage":0}}');

    const env = { FEATURE_FLAGS_FILE: file };
    expect(loadFeatureFlags(env).streams.response_balances).toEqual({ enabled: true, percentage: 0 });

    _resetFeatureFlagsForTest();
    fs.writeFileSync(file, '{"streams.response_balances":{"enabled":true,"percentage":100}}');

    expect(isFeatureEnabled('streams.response_balances', { apiKey: 'key-a' }, env)).toBe(true);
  });
});
