/* eslint-disable i18nhelper/no-jp-string -- Japanese text is the target of these tests */
import {
  authTokenToHeaders,
  findReusable,
  toBaseUrl,
  validateVoicevoxRequest,
} from '../../lambda/utils/voicevoxMicrovm';

const IMAGE = 'arn:aws:lambda:ap-northeast-1:111111111111:microvm-image:a';
const OTHER = 'arn:aws:lambda:ap-northeast-1:111111111111:microvm-image:b';

describe('findReusable', () => {
  it('returns undefined for undefined / empty items', () => {
    expect(findReusable(undefined, IMAGE)).toBeUndefined();
    expect(findReusable([], IMAGE)).toBeUndefined();
  });

  it('ignores MicroVMs of other images', () => {
    expect(
      findReusable(
        [{ microvmId: 'microvm-1', state: 'RUNNING', imageArn: OTHER }],
        IMAGE
      )
    ).toBeUndefined();
  });

  it('ignores TERMINATING / TERMINATED / SUSPENDING', () => {
    expect(
      findReusable(
        ['TERMINATING', 'TERMINATED', 'SUSPENDING'].map((state, i) => ({
          microvmId: `microvm-${i}`,
          state,
          imageArn: IMAGE,
        })),
        IMAGE
      )
    ).toBeUndefined();
  });

  it('prefers RUNNING over SUSPENDED, then the newest', () => {
    const picked = findReusable(
      [
        {
          microvmId: 'microvm-susp',
          state: 'SUSPENDED',
          imageArn: IMAGE,
          startedAt: new Date('2026-01-03'),
        },
        {
          microvmId: 'microvm-old',
          state: 'RUNNING',
          imageArn: IMAGE,
          startedAt: new Date('2026-01-01'),
        },
        {
          microvmId: 'microvm-new',
          state: 'RUNNING',
          imageArn: IMAGE,
          startedAt: new Date('2026-01-02'),
        },
      ],
      IMAGE
    );
    expect(picked?.microvmId).toBe('microvm-new');
  });
});

describe('authTokenToHeaders', () => {
  it('expands the map as-is', () => {
    expect(authTokenToHeaders({ 'X-aws-proxy-auth': 'token' })).toEqual({
      'X-aws-proxy-auth': 'token',
    });
  });
  it('throws on empty / missing token', () => {
    expect(() => authTokenToHeaders({})).toThrow();
    expect(() => authTokenToHeaders(undefined)).toThrow();
  });
});

describe('toBaseUrl', () => {
  it('adds https:// to a bare host and trims slashes', () => {
    expect(toBaseUrl('abc.example.com')).toBe('https://abc.example.com');
    expect(toBaseUrl('https://abc.example.com/')).toBe(
      'https://abc.example.com'
    );
  });
  it('rejects non-https schemes and empty values', () => {
    expect(() => toBaseUrl('http://abc.example.com')).toThrow();
    expect(() => toBaseUrl('  ')).toThrow();
  });
});

describe('validateVoicevoxRequest', () => {
  const ok = { text: 'こんにちは', styleId: 127, speed: 1 };
  it('accepts a valid request', () => {
    expect(validateVoicevoxRequest(ok)).toBeNull();
  });
  it('rejects empty text', () => {
    expect(validateVoicevoxRequest({ ...ok, text: '  ' })).toContain('text');
  });
  it('rejects text over 500 characters (code points)', () => {
    expect(
      validateVoicevoxRequest({ ...ok, text: 'あ'.repeat(501) })
    ).toContain('500');
    expect(
      validateVoicevoxRequest({ ...ok, text: '😀'.repeat(500) })
    ).toBeNull();
  });
  it('rejects a styleId that is not in the allow list', () => {
    // 13 is a style of a character that is not in the initial allow list
    expect(validateVoicevoxRequest({ ...ok, styleId: 13 })).toContain(
      'styleId'
    );
    expect(
      validateVoicevoxRequest({ ...ok, styleId: '127' as unknown as number })
    ).toContain('styleId');
  });
  it('rejects an out-of-range speed', () => {
    expect(validateVoicevoxRequest({ ...ok, speed: 0.4 })).toContain('speed');
    expect(validateVoicevoxRequest({ ...ok, speed: 2.1 })).toContain('speed');
    expect(validateVoicevoxRequest({ ...ok, speed: NaN })).toContain('speed');
  });
});
