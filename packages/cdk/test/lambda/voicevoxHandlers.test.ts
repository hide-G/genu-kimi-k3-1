/* eslint-disable i18nhelper/no-jp-string -- Japanese text is the target of these tests */
const mockMicrovmSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-lambda-microvms', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda-microvms');
  return {
    ...actual,
    LambdaMicrovmsClient: jest.fn(() => ({ send: mockMicrovmSend })),
  };
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
const IMAGE = 'arn:aws:lambda:ap-northeast-1:111111111111:microvm-image:a';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { handler as warmupHandler } from '../../lambda/voicevoxWarmup';
import { handler as synthesizeHandler } from '../../lambda/voicevoxSynthesize';
import { resetVoicevoxCache } from '../../lambda/utils/voicevoxMicrovm';

const mockFetch = jest.fn();
const event = (body?: unknown) =>
  ({
    body: body === undefined ? null : JSON.stringify(body),
  }) as unknown as APIGatewayProxyEvent;
const validBody = { text: 'こんにちは', styleId: 127, speed: 1.5 };

// Route mocked SDK calls by command name
type SdkCommand = {
  constructor: { name: string };
  input: Record<string, string>;
};
const routeSdk = (
  handlers: Record<string, (input: Record<string, string>) => unknown>
) => {
  mockMicrovmSend.mockImplementation(async (command: SdkCommand) => {
    const name = command.constructor.name;
    if (!handlers[name]) throw new Error(`unexpected command ${name}`);
    return handlers[name](command.input);
  });
};
const sdkCalls = (name: string) =>
  mockMicrovmSend.mock.calls.filter((c) => c[0].constructor.name === name);

beforeEach(() => {
  process.env.VOICEVOX_REGION = 'ap-northeast-1';
  process.env.VOICEVOX_MICROVM_IMAGE_ARN = IMAGE;
  process.env.VOICEVOX_ENGINE_PORT = '50021';
  resetVoicevoxCache();
  mockMicrovmSend.mockReset();
  mockS3Send.mockReset();
  mockFetch.mockReset();
  (LambdaMicrovmsClient as unknown as jest.Mock).mockClear();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('voicevoxWarmup', () => {
  it('returns 404 when VOICEVOX is not configured', async () => {
    delete process.env.VOICEVOX_MICROVM_IMAGE_ARN;
    const res = await warmupHandler();
    expect(res.statusCode).toBe(404);
    expect(mockMicrovmSend).not.toHaveBeenCalled();
  });

  it('starts a MicroVM when none exists, and returns the state at once', async () => {
    routeSdk({
      ListMicrovmsCommand: () => ({ items: [] }),
      RunMicrovmCommand: () => ({
        microvmId: 'microvm-new',
        state: 'PENDING',
      }),
    });
    const res = await warmupHandler();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ state: 'PENDING' });

    // Region is passed explicitly, and the image ARN (not the name) is used
    expect(LambdaMicrovmsClient).toHaveBeenCalledWith({
      region: 'ap-northeast-1',
    });
    const run = sdkCalls('RunMicrovmCommand')[0][0].input;
    expect(run.imageIdentifier).toBe(IMAGE);
    expect(run.ingressNetworkConnectors[0]).toMatch(/:ALL_INGRESS$/);
    expect(run.egressNetworkConnectors[0]).toMatch(/:INTERNET_EGRESS$/);
    expect(run.idlePolicy.autoResumeEnabled).toBe(true);
  });

  it('reuses a MicroVM of the same image (items key) without RunMicrovm', async () => {
    routeSdk({
      ListMicrovmsCommand: () => ({
        items: [
          { microvmId: 'microvm-other', state: 'RUNNING', imageArn: 'x' },
          { microvmId: 'microvm-1', state: 'SUSPENDED', imageArn: IMAGE },
        ],
      }),
      GetMicrovmCommand: (i) => ({
        microvmId: i.microvmIdentifier,
        state: 'SUSPENDED',
        endpoint: 'h.example.com',
      }),
    });
    const res = await warmupHandler();
    expect(JSON.parse(res.body)).toEqual({ state: 'SUSPENDED' });
    expect(sdkCalls('RunMicrovmCommand')).toHaveLength(0);
    expect(sdkCalls('GetMicrovmCommand')[0][0].input.microvmIdentifier).toBe(
      'microvm-1'
    );
  });
});

describe('voicevoxSynthesize', () => {
  const runningMicrovm = {
    ListMicrovmsCommand: () => ({
      items: [{ microvmId: 'microvm-1', state: 'RUNNING', imageArn: IMAGE }],
    }),
    GetMicrovmCommand: () => ({
      microvmId: 'microvm-1',
      state: 'RUNNING',
      endpoint: 'h.example.com',
    }),
    CreateMicrovmAuthTokenCommand: () => ({
      authToken: { 'X-aws-proxy-auth': 'tok' },
    }),
  };

  it('returns 400 for a styleId outside the allow list', async () => {
    const res = await synthesizeHandler(event({ ...validBody, styleId: 13 }));
    expect(res.statusCode).toBe(400);
    expect(mockMicrovmSend).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 for text over the limit', async () => {
    const res = await synthesizeHandler(
      event({ ...validBody, text: 'a'.repeat(501) })
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('500');
    expect(mockMicrovmSend).not.toHaveBeenCalled();
  });

  it('synthesizes, stores the WAV in S3 and returns a presigned url', async () => {
    routeSdk(runningMicrovm);
    mockS3Send.mockResolvedValue({});
    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ speedScale: 1, other: 'x' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });

    const res = await synthesizeHandler(event(validBody));
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body).toEqual({
      key: '00000000-0000-4000-8000-000000000000/voicevox-127.wav',
      fileName: 'voicevox-127.wav',
      url: 'https://example.com/signed',
      contentType: 'audio/wav',
      characters: 5,
      credit: 'VOICEVOX:ブイブイ・コバコ',
    });
    expect(mockS3Send.mock.calls[0][0].input.Bucket).toBe('test-bucket');
    expect(mockS3Send.mock.calls[0][0].input.ContentType).toBe('audio/wav');

    // audio_query: encoded text, auth + port headers, no ":50021" in the URL
    const [queryUrl, queryInit] = mockFetch.mock.calls[0];
    expect(queryUrl).toBe(
      `https://h.example.com/audio_query?speaker=127&text=${encodeURIComponent('こんにちは')}`
    );
    expect(queryInit.method).toBe('POST');
    expect(queryInit.headers['X-aws-proxy-auth']).toBe('tok');
    expect(queryInit.headers['X-aws-proxy-port']).toBe('50021');

    // synthesis: speedScale overwritten with the requested speed
    const [synthUrl, synthInit] = mockFetch.mock.calls[1];
    expect(synthUrl).toBe('https://h.example.com/synthesis?speaker=127');
    expect(synthInit.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(synthInit.body)).toEqual({ speedScale: 1.5, other: 'x' });
  });

  it('returns 503 with retryAfterSeconds while the MicroVM is PENDING', async () => {
    routeSdk({
      ...runningMicrovm,
      ListMicrovmsCommand: () => ({ items: [] }),
      RunMicrovmCommand: () => ({ microvmId: 'microvm-2', state: 'PENDING' }),
    });
    const res = await synthesizeHandler(event(validBody));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(503);
    expect(typeof body.retryAfterSeconds).toBe('number');
    expect(typeof body.message).toBe('string');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 503 when ENGINE keeps answering 502', async () => {
    jest.useFakeTimers();
    try {
      routeSdk(runningMicrovm);
      mockFetch.mockResolvedValue({ status: 502, ok: false });
      const promise = synthesizeHandler(event(validBody));
      await jest.runAllTimersAsync();
      const res = await promise;
      expect(res.statusCode).toBe(503);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockS3Send).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
