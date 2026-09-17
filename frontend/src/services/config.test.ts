import { describe, it, expect, beforeEach } from 'vitest';
import { isConfigured, isHistoryConfigured, isValidHttpUrl } from './config';

/**
 * Tests for issue #20: setup must not accept a missing Conversation History API
 * endpoint and then proceed to a chat whose sidebar is broken. `isConfigured`
 * now requires BOTH Cognito auth and the history endpoint, and `isValidHttpUrl`
 * backs the setup-form validation.
 */

const COGNITO = {
  userPoolId: 'us-east-1_test',
  userPoolClientId: 'client',
  identityPoolId: 'us-east-1:pool',
  region: 'us-east-1',
};

function writeConfig(config: unknown): void {
  localStorage.setItem('appConfig', JSON.stringify(config));
}

describe('config.isConfigured (issue #20)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns false when no config is stored', () => {
    expect(isConfigured()).toBe(false);
  });

  it('returns false when Cognito is set but the history endpoint is missing', () => {
    writeConfig({ cognito: COGNITO, agentcore: { enabled: true } });
    expect(isConfigured()).toBe(false);
  });

  it('returns false when the history endpoint is an empty string', () => {
    writeConfig({ cognito: COGNITO, conversationApi: { endpoint: '' } });
    expect(isConfigured()).toBe(false);
  });

  it('returns true only when both Cognito and the history endpoint are present', () => {
    writeConfig({
      cognito: COGNITO,
      conversationApi: { endpoint: 'https://api.example.com/prod' },
    });
    expect(isConfigured()).toBe(true);
  });

  it('returns false on malformed JSON', () => {
    localStorage.setItem('appConfig', '{not json');
    expect(isConfigured()).toBe(false);
  });
});

describe('config.isHistoryConfigured (issue #20)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is false without an endpoint and true with one', () => {
    writeConfig({ cognito: COGNITO });
    expect(isHistoryConfigured()).toBe(false);
    writeConfig({ cognito: COGNITO, conversationApi: { endpoint: 'https://api.example.com' } });
    expect(isHistoryConfigured()).toBe(true);
  });
});

describe('config.isValidHttpUrl (issue #20)', () => {
  it('accepts http and https URLs', () => {
    expect(isValidHttpUrl('https://xxxx.execute-api.us-east-1.amazonaws.com/prod')).toBe(true);
    expect(isValidHttpUrl('http://localhost:3000')).toBe(true);
    expect(isValidHttpUrl('  https://api.example.com/prod  ')).toBe(true);
  });

  it('rejects empty, non-URL, and non-http(s) values', () => {
    expect(isValidHttpUrl('')).toBe(false);
    expect(isValidHttpUrl('   ')).toBe(false);
    expect(isValidHttpUrl('not a url')).toBe(false);
    expect(isValidHttpUrl('ftp://example.com')).toBe(false);
    expect(isValidHttpUrl('example.com/prod')).toBe(false);
  });
});
