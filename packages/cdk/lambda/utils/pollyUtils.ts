import type {
  PollyEngine,
  PollyOutputFormat,
  SynthesizeSpeechRequest,
} from 'generative-ai-use-cases';

// Amazon Polly SynthesizeSpeech accepts up to 3000 billed characters per request
export const MAX_TEXT_LENGTH = 3000;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2.0;

export const ENGINES: PollyEngine[] = [
  'generative',
  'long-form',
  'neural',
  'standard',
];

export const OUTPUT_FORMATS: Record<
  PollyOutputFormat,
  { contentType: string; extension: string }
> = {
  mp3: { contentType: 'audio/mpeg', extension: 'mp3' },
  ogg_vorbis: { contentType: 'audio/ogg', extension: 'ogg' },
};

export const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Build the text sent to Polly.
 * SSML is used only when the speed is not 100%.
 */
export const buildSpeechInput = (
  text: string,
  speed: number
): { text: string; textType: 'text' | 'ssml' } => {
  // Characters that are invalid in XML 1.0 (control characters other than
  // tab, LF and CR) are removed before building the request text
  const cleaned = removeInvalidXmlChars(text);
  const rate = Math.round(speed * 100);
  if (rate === 100) {
    return { text: cleaned, textType: 'text' };
  }
  return {
    text: `<speak><prosody rate="${rate}%">${escapeXml(cleaned)}</prosody></speak>`,
    textType: 'ssml',
  };
};

// Polly limit of the whole request text (tags included) for SynthesizeSpeech
export const MAX_REQUEST_LENGTH = 6000;

export const removeInvalidXmlChars = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

export type PollyErrorResponse = {
  statusCode: number;
  message: string;
  code: string;
};

const ACCESS_DENIED_NAMES = [
  'AccessDeniedException',
  'AccessDenied',
  'UnrecognizedClientException',
  'UnauthorizedException',
  'ExpiredTokenException',
  'InvalidSignatureException',
  'InvalidClientTokenId',
  'MissingAuthenticationToken',
  'CredentialsProviderError',
];

const S3_ERROR_NAMES = ['NoSuchBucket', 'S3ServiceException'];

/**
 * Map an error thrown by the AWS SDK (Polly / S3) to a response that is safe
 * to return to the user. Never includes the raw AWS message.
 * https://docs.aws.amazon.com/polly/latest/dg/API_SynthesizeSpeech.html
 * https://docs.aws.amazon.com/polly/latest/dg/API_DescribeVoices.html
 * https://docs.aws.amazon.com/polly/latest/dg/limits.html
 */
export const mapPollyError = (
  error: unknown,
  options: { storage?: boolean } = {}
): PollyErrorResponse => {
  const e = (error ?? {}) as {
    name?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const name = typeof e.name === 'string' ? e.name : '';
  const status = e.$metadata?.httpStatusCode;

  // S3 failures (including S3 access denied) must not look like Polly ones
  if (options.storage || S3_ERROR_NAMES.includes(name)) {
    return {
      statusCode: 500,
      code: 'STORAGE_ERROR',
      message: 'Failed to save the generated audio file.',
    };
  }
  if (name === 'EngineNotSupportedException') {
    return {
      statusCode: 400,
      code: 'ENGINE_NOT_SUPPORTED',
      message:
        "The selected engine is not compatible with the selected voice, or is not available in this stack's Region (for example, Long-form voices are available only in us-east-1). Choose another engine or voice.",
    };
  }
  if (name === 'LanguageNotSupportedException') {
    return {
      statusCode: 400,
      code: 'LANGUAGE_NOT_SUPPORTED',
      message:
        'The selected language is not supported by the selected voice. Choose another language or voice.',
    };
  }
  if (name === 'InvalidSsmlException') {
    return {
      statusCode: 400,
      code: 'INVALID_SSML',
      message: 'The SSML is invalid. Check the tag syntax and spelling.',
    };
  }
  if (name === 'TextLengthExceededException') {
    return {
      statusCode: 400,
      code: 'TEXT_TOO_LONG',
      message: `The text exceeds the Polly limit (${MAX_REQUEST_LENGTH} characters in total and ${MAX_TEXT_LENGTH} billed characters for SynthesizeSpeech).`,
    };
  }
  if (name === 'InvalidSampleRateException') {
    return {
      statusCode: 400,
      code: 'INVALID_SAMPLE_RATE',
      message: 'The sample rate is not valid for the selected output format.',
    };
  }
  if (name === 'InvalidNextTokenException') {
    return {
      statusCode: 400,
      code: 'INVALID_NEXT_TOKEN',
      message: 'The pagination token is invalid.',
    };
  }
  if (name.includes('Throttl') || status === 429) {
    return {
      statusCode: 429,
      code: 'THROTTLED',
      message:
        'Too many requests to Amazon Polly (about 8 requests per second per account and Region for neural and generative voices). Wait a moment and try again.',
    };
  }
  if (name === 'ServiceFailureException') {
    return {
      statusCode: 502,
      code: 'POLLY_SERVICE_FAILURE',
      message: 'Amazon Polly failed temporarily. Try again later.',
    };
  }
  if (ACCESS_DENIED_NAMES.includes(name)) {
    return {
      statusCode: 500,
      code: 'POLLY_ACCESS_DENIED',
      message:
        'The server is not allowed to call Amazon Polly. Ask the administrator to check the IAM permissions polly:SynthesizeSpeech and polly:DescribeVoices.',
    };
  }
  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal Server Error',
  };
};

/**
 * Validate the request body of POST /polly/synthesize.
 * Returns an error message, or null when the request is valid.
 */
/**
 * Returns true when the final request text (after escaping, tags included)
 * is within the Polly limit.
 */
export const isWithinRequestLimit = (requestText: string): boolean =>
  Array.from(requestText).length <= MAX_REQUEST_LENGTH;

export const validateSynthesizeRequest = (
  req: Partial<SynthesizeSpeechRequest> | null | undefined
): string | null => {
  if (!req || typeof req !== 'object') {
    return 'Request body is required.';
  }
  if (typeof req.text !== 'string' || req.text.trim().length === 0) {
    return 'text is required.';
  }
  // Count by code points (not UTF-16 units) so that it matches what the user sees
  const length = Array.from(req.text).length;
  if (length > MAX_TEXT_LENGTH) {
    return `text must be ${MAX_TEXT_LENGTH} characters or less (received ${length}).`;
  }
  if (
    typeof req.voiceId !== 'string' ||
    !/^[A-Za-z]{1,32}$/.test(req.voiceId)
  ) {
    return 'voiceId is invalid.';
  }
  if (!req.engine || !ENGINES.includes(req.engine)) {
    return `engine must be one of ${ENGINES.join(', ')}.`;
  }
  if (
    typeof req.languageCode !== 'string' ||
    !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(req.languageCode)
  ) {
    return 'languageCode is invalid.';
  }
  if (!req.outputFormat || !(req.outputFormat in OUTPUT_FORMATS)) {
    return `outputFormat must be one of ${Object.keys(OUTPUT_FORMATS).join(', ')}.`;
  }
  if (
    typeof req.speed !== 'number' ||
    !Number.isFinite(req.speed) ||
    req.speed < MIN_SPEED ||
    req.speed > MAX_SPEED
  ) {
    return `speed must be between ${MIN_SPEED} and ${MAX_SPEED}.`;
  }
  return null;
};
