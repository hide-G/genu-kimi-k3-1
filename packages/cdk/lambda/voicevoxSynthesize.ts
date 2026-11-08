import { v4 as uuidv4 } from 'uuid';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  buildVoicevoxCredit,
  findVoicevoxSpeaker,
} from '@generative-ai-use-cases/common';
import type {
  VoicevoxNotReadyResponse,
  VoicevoxSynthesizeRequest,
  VoicevoxSynthesizeResponse,
} from 'generative-ai-use-cases';
import {
  VoicevoxNotReadyError,
  getEngineAccess,
  loadVoicevoxConfig,
  synthesizeWav,
  validateVoicevoxRequest,
} from './utils/voicevoxMicrovm';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

// Stop before API Gateway's 29s integration timeout
const SYNTHESIS_TIMEOUT_MS = 25000;

/**
 * POST /voicevox/synthesize
 * Same shape as Polly: store the audio in the file bucket and return a
 * presigned GET URL (the audio itself is not in the response body).
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const config = loadVoicevoxConfig();
  if (!config) {
    return json(404, { message: 'VOICEVOX is not enabled.' });
  }

  let req: Partial<VoicevoxSynthesizeRequest>;
  try {
    req = JSON.parse(event.body ?? '');
  } catch {
    return json(400, { message: 'Request body must be valid JSON.' });
  }
  const validationError = validateVoicevoxRequest(req);
  if (validationError) {
    return json(400, { message: validationError });
  }
  const { text, styleId, speed } = req as VoicevoxSynthesizeRequest;
  const speaker = findVoicevoxSpeaker(styleId)!;

  try {
    const access = await getEngineAccess(config);
    const wav = await synthesizeWav(
      access,
      text,
      styleId,
      speed,
      AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS)
    );

    const fileName = `voicevox-${styleId}.wav`;
    const key = `${uuidv4()}/${fileName}`;
    const s3 = new S3Client({});
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        Body: wav,
        ContentType: 'audio/wav',
      })
    );
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        ResponseContentType: 'audio/wav',
        ResponseContentDisposition: `attachment; filename="${fileName}"`,
      }),
      { expiresIn: 3600 }
    );

    const response: VoicevoxSynthesizeResponse = {
      key,
      fileName,
      url,
      contentType: 'audio/wav',
      characters: Array.from(text).length,
      credit: buildVoicevoxCredit(speaker),
    };
    return json(200, response);
  } catch (error) {
    if (error instanceof VoicevoxNotReadyError) {
      const body: VoicevoxNotReadyResponse = {
        message: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
      };
      return {
        statusCode: 503,
        headers: { ...headers, 'Retry-After': String(error.retryAfterSeconds) },
        body: JSON.stringify(body),
      };
    }
    if ((error as Error)?.name === 'TimeoutError') {
      return json(504, {
        message: 'Synthesis timed out. Try a shorter text.',
      });
    }
    console.log(error);
    return json(500, { message: 'Internal Server Error' });
  }
};
