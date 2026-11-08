import {
  MAX_TEXT_LENGTH,
  buildSpeechInput,
  escapeXml,
  isWithinRequestLimit,
  mapPollyError,
  removeInvalidXmlChars,
  validateSynthesizeRequest,
} from '../../lambda/utils/pollyUtils';

const validRequest = {
  text: 'Hello',
  voiceId: 'Joanna',
  engine: 'neural' as const,
  languageCode: 'en-US',
  outputFormat: 'mp3' as const,
  speed: 1,
};

describe('escapeXml', () => {
  it('escapes XML special characters', () => {
    expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;'
    );
  });
});

describe('buildSpeechInput', () => {
  it('uses plain text at 100% speed', () => {
    expect(buildSpeechInput('a < b', 1)).toEqual({
      text: 'a < b',
      textType: 'text',
    });
  });

  it('wraps escaped text with prosody when speed is not 100%', () => {
    expect(buildSpeechInput('a < b & c', 1.25)).toEqual({
      text: '<speak><prosody rate="125%">a &lt; b &amp; c</prosody></speak>',
      textType: 'ssml',
    });
    expect(buildSpeechInput('x', 0.5).text).toContain('rate="50%"');
  });
});

describe('validateSynthesizeRequest', () => {
  it('accepts a valid request', () => {
    expect(validateSynthesizeRequest(validRequest)).toBeNull();
  });

  it('accepts exactly the maximum length and rejects one more', () => {
    expect(
      validateSynthesizeRequest({
        ...validRequest,
        text: 'a'.repeat(MAX_TEXT_LENGTH),
      })
    ).toBeNull();
    expect(
      validateSynthesizeRequest({
        ...validRequest,
        text: 'a'.repeat(MAX_TEXT_LENGTH + 1),
      })
    ).toContain('3000 characters or less');
  });

  it('counts characters by code point', () => {
    expect(
      validateSynthesizeRequest({
        ...validRequest,
        text: '😀'.repeat(MAX_TEXT_LENGTH),
      })
    ).toBeNull();
  });

  it('rejects empty text, bad engine, format, speed and ids', () => {
    expect(validateSynthesizeRequest(null)).not.toBeNull();
    expect(validateSynthesizeRequest({ ...validRequest, text: '  ' })).toMatch(
      /text is required/
    );
    expect(
      validateSynthesizeRequest({
        ...validRequest,
        engine: 'foo' as never,
      })
    ).toMatch(/engine/);
    expect(
      validateSynthesizeRequest({
        ...validRequest,
        outputFormat: 'wav' as never,
      })
    ).toMatch(/outputFormat/);
    expect(validateSynthesizeRequest({ ...validRequest, speed: 2.5 })).toMatch(
      /speed/
    );
    expect(validateSynthesizeRequest({ ...validRequest, speed: 0.4 })).toMatch(
      /speed/
    );
    expect(
      validateSynthesizeRequest({ ...validRequest, voiceId: 'a/b' })
    ).toMatch(/voiceId/);
    expect(
      validateSynthesizeRequest({ ...validRequest, languageCode: '??' })
    ).toMatch(/languageCode/);
  });
});

describe('removeInvalidXmlChars / request limit', () => {
  it('removes control characters except tab, LF and CR', () => {
    expect(removeInvalidXmlChars('a\u0000b\u0008c\td\ne\rf\u001Fg\u000B')).toBe(
      'abc\td\ne\rfg'
    );
    expect(buildSpeechInput('a\u0001b', 1).text).toBe('ab');
    expect(buildSpeechInput('a\u0001<b', 1.5).text).toContain('a&lt;b');
  });

  it('checks the final request text including escaping and tags', () => {
    expect(isWithinRequestLimit('a'.repeat(6000))).toBe(true);
    expect(isWithinRequestLimit('a'.repeat(6001))).toBe(false);
    // 2000 "&" are 2000 chars as text but 10000 chars once escaped
    expect(
      isWithinRequestLimit(buildSpeechInput('&'.repeat(2000), 1.5).text)
    ).toBe(false);
  });
});

describe('mapPollyError', () => {
  const err = (name: string, httpStatusCode?: number) => ({
    name,
    message: 'arn:aws:iam::123456789012:user/secret failed',
    $metadata: { httpStatusCode },
  });

  it.each([
    ['EngineNotSupportedException', 400, 400, 'ENGINE_NOT_SUPPORTED'],
    ['LanguageNotSupportedException', 400, 400, 'LANGUAGE_NOT_SUPPORTED'],
    ['InvalidSsmlException', 400, 400, 'INVALID_SSML'],
    ['TextLengthExceededException', 400, 400, 'TEXT_TOO_LONG'],
    ['InvalidSampleRateException', 400, 400, 'INVALID_SAMPLE_RATE'],
    ['ThrottlingException', 400, 429, 'THROTTLED'],
    ['TooManyRequestsException', 429, 429, 'THROTTLED'],
    ['SomethingThrottledError', 500, 429, 'THROTTLED'],
    ['InvalidNextTokenException', 400, 400, 'INVALID_NEXT_TOKEN'],
    ['ServiceFailureException', 500, 502, 'POLLY_SERVICE_FAILURE'],
    ['AccessDeniedException', 403, 500, 'POLLY_ACCESS_DENIED'],
    ['UnrecognizedClientException', 400, 500, 'POLLY_ACCESS_DENIED'],
  ])('%s (HTTP %s) -> %s %s', (name, http, statusCode, code) => {
    const res = mapPollyError(err(name, http));
    expect(res.statusCode).toBe(statusCode);
    expect(res.code).toBe(code);
    expect(res.message).not.toContain('arn:aws');
    expect(res.message).not.toContain('123456789012');
  });

  it('mentions the required IAM permissions for access denied', () => {
    const { message } = mapPollyError(err('AccessDeniedException', 403));
    expect(message).toContain('polly:SynthesizeSpeech');
    expect(message).toContain('polly:DescribeVoices');
  });

  it('maps S3 errors while saving to STORAGE_ERROR, even if access denied', () => {
    expect(mapPollyError(err('NoSuchBucket', 404)).code).toBe('STORAGE_ERROR');
    const res = mapPollyError(err('AccessDenied', 403), { storage: true });
    expect(res).toMatchObject({ statusCode: 500, code: 'STORAGE_ERROR' });
  });

  it('returns INTERNAL_ERROR without the original message for unknown errors', () => {
    for (const e of [
      new Error('secret-bucket arn:aws:s3:::x'),
      err('SomethingElse', 418),
      null,
      undefined,
      'string error',
    ]) {
      const res = mapPollyError(e);
      expect(res).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal Server Error',
      });
    }
  });
});
