import { v4 as uuidv4 } from 'uuid';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  PollyClient,
  SynthesizeSpeechCommand,
  VoiceId,
  LanguageCode,
} from '@aws-sdk/client-polly';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  SynthesizeSpeechRequest,
  SynthesizeSpeechResponse,
} from 'generative-ai-use-cases';
import {
  OUTPUT_FORMATS,
  buildSpeechInput,
  validateSynthesizeRequest,
} from './utils/pollyUtils';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const badRequest = (message: string): APIGatewayProxyResult => ({
  statusCode: 400,
  headers,
  body: JSON.stringify({ message }),
});

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    let req: Partial<SynthesizeSpeechRequest>;
    try {
      req = JSON.parse(event.body ?? '');
    } catch {
      return badRequest('Request body must be valid JSON.');
    }

    const validationError = validateSynthesizeRequest(req);
    if (validationError) {
      return badRequest(validationError);
    }
    const { text, voiceId, engine, languageCode, outputFormat, speed } =
      req as SynthesizeSpeechRequest;

    const input = buildSpeechInput(text, speed);
    const format = OUTPUT_FORMATS[outputFormat];

    const polly = new PollyClient({});
    const speech = await polly.send(
      new SynthesizeSpeechCommand({
        Text: input.text,
        TextType: input.textType,
        VoiceId: voiceId as VoiceId,
        Engine: engine,
        LanguageCode: languageCode as LanguageCode,
        OutputFormat: outputFormat,
      })
    );

    if (!speech.AudioStream) {
      throw new Error('Polly returned an empty audio stream.');
    }
    const audio = await speech.AudioStream.transformToByteArray();

    // Same key convention as getFileUploadSignedUrl: XXXXX/filename
    const fileName = `speech-${voiceId.toLowerCase()}.${format.extension}`;
    const key = `${uuidv4()}/${fileName}`;

    const s3 = new S3Client({});
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        Body: audio,
        ContentType: format.contentType,
      })
    );

    // Same presigned GET as getFileDownloadSignedUrl. The attachment
    // disposition makes the browser save it with a proper name, while
    // <audio> playback is not affected by it.
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        ResponseContentType: format.contentType,
        ResponseContentDisposition: `attachment; filename="${fileName}"`,
      }),
      { expiresIn: 3600 }
    );

    const response: SynthesizeSpeechResponse = {
      key,
      fileName,
      url,
      contentType: format.contentType,
      characters: speech.RequestCharacters ?? Array.from(text).length,
    };
    return { statusCode: 200, headers, body: JSON.stringify(response) };
  } catch (error) {
    console.log(error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'Internal Server Error' }),
    };
  }
};
