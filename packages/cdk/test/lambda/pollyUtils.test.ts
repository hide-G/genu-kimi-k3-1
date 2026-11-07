import {
  MAX_TEXT_LENGTH,
  buildSpeechInput,
  escapeXml,
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
