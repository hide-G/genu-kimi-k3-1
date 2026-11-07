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
  const rate = Math.round(speed * 100);
  if (rate === 100) {
    return { text, textType: 'text' };
  }
  return {
    text: `<speak><prosody rate="${rate}%">${escapeXml(text)}</prosody></speak>`,
    textType: 'ssml',
  };
};

/**
 * Validate the request body of POST /polly/synthesize.
 * Returns an error message, or null when the request is valid.
 */
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
