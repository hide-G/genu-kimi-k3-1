const mockPollySend = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-polly', () => {
  const actual = jest.requireActual('@aws-sdk/client-polly');
  return { ...actual, PollyClient: jest.fn(() => ({ send: mockPollySend })) };
});
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn(() => ({ send: mockS3Send })) };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://example.com/signed'),
}));

jest.mock('uuid', () => ({
  v4: () => '00000000-0000-4000-8000-000000000000',
}));

process.env.BUCKET_NAME = 'test-bucket';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as voicesHandler } from '../../lambda/pollyVoices';
import { handler as synthesizeHandler } from '../../lambda/pollySynthesize';

beforeEach(() => {
  mockPollySend.mockReset();
  mockS3Send.mockReset();
});

describe('pollyVoices', () => {
  it('maps throttling to 429 THROTTLED', async () => {
    mockPollySend.mockRejectedValueOnce(
      Object.assign(new Error('x'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const res = await voicesHandler({
      queryStringParameters: null,
    } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).code).toBe('THROTTLED');
  });

  it('follows NextToken and returns languages and voices', async () => {
    mockPollySend
      .mockResolvedValueOnce({
        Voices: [
          {
            Id: 'Joanna',
            Name: 'Joanna',
            Gender: 'Female',
            LanguageCode: 'en-US',
            LanguageName: 'US English',
            SupportedEngines: ['neural', 'standard'],
          },
        ],
        NextToken: 'next',
      })
      .mockResolvedValueOnce({
        Voices: [
          {
            Id: 'Kazuha',
            Name: 'Kazuha',
            Gender: 'Female',
            LanguageCode: 'ja-JP',
            AdditionalLanguageCodes: ['en-US'],
            SupportedEngines: ['neural'],
          },
        ],
      });

    const res = await voicesHandler({
      queryStringParameters: null,
    } as unknown as APIGatewayProxyEvent);
    const body = JSON.parse(res.body);

    expect(mockPollySend).toHaveBeenCalledTimes(2);
    expect(mockPollySend.mock.calls[1][0].input.NextToken).toBe('next');
    expect(
      mockPollySend.mock.calls[0][0].input.IncludeAdditionalLanguageCodes
    ).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(body.languages.map((l: { code: string }) => l.code)).toEqual([
      'en-US',
      'ja-JP',
    ]);
    expect(body.voices).toHaveLength(2);
  });

  it('rejects an invalid languageCode', async () => {
    const res = await voicesHandler({
      queryStringParameters: { languageCode: '!!' },
    } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(400);
    expect(mockPollySend).not.toHaveBeenCalled();
  });
});

describe('pollySynthesize', () => {
  const event = (body: unknown) =>
    ({ body: JSON.stringify(body) }) as unknown as APIGatewayProxyEvent;

  it('returns 400 for text over the limit without calling Polly', async () => {
    const res = await synthesizeHandler(
      event({
        text: 'a'.repeat(3001),
        voiceId: 'Joanna',
        engine: 'neural',
        languageCode: 'en-US',
        outputFormat: 'mp3',
        speed: 1,
      })
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('3000');
    expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
    expect(mockPollySend).not.toHaveBeenCalled();
  });

  it('returns TEXT_TOO_LONG when the escaped SSML exceeds 6000 characters', async () => {
    const res = await synthesizeHandler(
      event({
        text: '&'.repeat(2000),
        voiceId: 'Joanna',
        engine: 'neural',
        languageCode: 'en-US',
        outputFormat: 'mp3',
        speed: 1.5,
      })
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('TEXT_TOO_LONG');
    expect(mockPollySend).not.toHaveBeenCalled();
  });

  it('maps Polly errors to a detailed response', async () => {
    mockPollySend.mockRejectedValueOnce(
      Object.assign(new Error('raw aws text'), {
        name: 'EngineNotSupportedException',
        $metadata: { httpStatusCode: 400 },
      })
    );
    const res = await synthesizeHandler(
      event({
        text: 'Hello',
        voiceId: 'Joanna',
        engine: 'long-form',
        languageCode: 'en-US',
        outputFormat: 'mp3',
        speed: 1,
      })
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('ENGINE_NOT_SUPPORTED');
    expect(body.message).not.toContain('raw aws text');
  });

  it('returns STORAGE_ERROR when saving to S3 fails', async () => {
    mockPollySend.mockResolvedValueOnce({
      AudioStream: { transformToByteArray: async () => new Uint8Array([1]) },
    });
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error('denied arn:aws:s3:::b'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      })
    );
    const res = await synthesizeHandler(
      event({
        text: 'Hello',
        voiceId: 'Joanna',
        engine: 'neural',
        languageCode: 'en-US',
        outputFormat: 'mp3',
        speed: 1,
      })
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).code).toBe('STORAGE_ERROR');
  });

  it('synthesizes, stores in S3 and returns a presigned url', async () => {
    mockPollySend.mockResolvedValue({
      AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2]) },
      RequestCharacters: 5,
    });
    mockS3Send.mockResolvedValue({});

    const res = await synthesizeHandler(
      event({
        text: 'Hello',
        voiceId: 'Joanna',
        engine: 'neural',
        languageCode: 'en-US',
        outputFormat: 'mp3',
        speed: 1.5,
      })
    );
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(mockPollySend.mock.calls[0][0].input.TextType).toBe('ssml');
    expect(mockS3Send.mock.calls[0][0].input.Bucket).toBe('test-bucket');
    expect(body.url).toBe('https://example.com/signed');
    expect(body.contentType).toBe('audio/mpeg');
    expect(body.characters).toBe(5);
    expect(body.key).toMatch(/^[0-9a-f-]{36}\/speech-joanna\.mp3$/);
  });
});
