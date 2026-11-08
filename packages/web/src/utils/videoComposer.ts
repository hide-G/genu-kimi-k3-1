/**
 * Compose a video (image or text background + audio + credit) in the browser
 * with canvas / Web Audio / MediaRecorder, for posting to X.
 * No server-side ffmpeg is used.
 *
 * The pure functions (wrapText, fitTextLayout, fitImageRect, pickVideoMime,
 * buildCreditLabel, buildVideoFileName) are unit tested. createVideoBlob
 * depends on browser APIs and is UNVERIFIED outside the browsers listed in
 * the PR description (MP4 output was confirmed on Edge 156 only).
 */

export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const VIDEO_FPS = 30;
export const LEAD_SILENCE_SEC = 0.3;
export const TAIL_SILENCE_SEC = 0.6;
// UNVERIFIED: X's length limit for standard accounts (2 min 20 s).
export const X_MAX_VIDEO_SECONDS = 140;

const CREDIT_BAND_HEIGHT = 64;
const PROGRESS_BAR_HEIGHT = 8;
const TEXT_PADDING_X = 80;
const TEXT_PADDING_Y = 56;
const MIN_FONT_SIZE = 22;
const MAX_FONT_SIZE = 64;
const LINE_HEIGHT_RATIO = 1.45;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export type MeasureText = (text: string) => number;

/**
 * Wrap text character by character (Japanese has no word separators).
 * Explicit line breaks are kept. Returns null when the number of lines
 * exceeds maxLines.
 */
export const wrapText = (
  text: string,
  maxWidth: number,
  measure: MeasureText,
  maxLines: number = Number.POSITIVE_INFINITY
): string[] | null => {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let current = '';
    for (const ch of Array.from(paragraph)) {
      if (current !== '' && measure(current + ch) > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    lines.push(current);
    if (lines.length > maxLines) return null;
  }
  return lines.length > maxLines ? null : lines;
};

export type TextLayout = {
  fontSize: number;
  lines: string[];
  truncated: boolean;
};

/**
 * Find the largest font size where the text fits in the box. When it does not
 * fit even at the minimum size, the tail is cut and "…" is appended.
 * `measureAt(fontSize)` returns a measure function for that size.
 */
export const fitTextLayout = (
  text: string,
  box: { width: number; height: number },
  measureAt: (fontSize: number) => MeasureText,
  options: {
    minFontSize?: number;
    maxFontSize?: number;
    lineHeightRatio?: number;
  } = {}
): TextLayout => {
  const minFont = options.minFontSize ?? MIN_FONT_SIZE;
  const maxFont = options.maxFontSize ?? MAX_FONT_SIZE;
  const ratio = options.lineHeightRatio ?? LINE_HEIGHT_RATIO;
  const maxLinesAt = (size: number) =>
    Math.max(1, Math.floor(box.height / (size * ratio)));

  for (let size = maxFont; size >= minFont; size--) {
    const lines = wrapText(text, box.width, measureAt(size), maxLinesAt(size));
    if (lines) return { fontSize: size, lines, truncated: false };
  }

  // Does not fit at the minimum size: truncate with an ellipsis
  const measure = measureAt(minFont);
  const maxLines = maxLinesAt(minFont);
  const all = wrapText(text, box.width, measure) ?? [];
  const lines = all.slice(0, maxLines);
  let last = lines[lines.length - 1] ?? '';
  const chars = Array.from(last);
  while (chars.length > 0 && measure(chars.join('') + '…') > box.width) {
    chars.pop();
  }
  last = chars.join('') + '…';
  lines[Math.max(0, lines.length - 1)] = last;
  return { fontSize: minFont, lines, truncated: true };
};

export type Rect = { x: number; y: number; width: number; height: number };

/** Fit (contain) an image into a box, keeping the aspect ratio. */
export const fitImageRect = (
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Rect => {
  if (srcWidth <= 0 || srcHeight <= 0) {
    return { x: 0, y: 0, width: dstWidth, height: dstHeight };
  }
  const scale = Math.min(dstWidth / srcWidth, dstHeight / srcHeight);
  const width = srcWidth * scale;
  const height = srcHeight * scale;
  return {
    x: (dstWidth - width) / 2,
    y: (dstHeight - height) / 2,
    width,
    height,
  };
};

export const VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
] as const;

/** Pick the first supported MIME type. Returns null if none is supported. */
export const pickVideoMime = (
  isTypeSupported: (mime: string) => boolean
): { mime: string; isMp4: boolean; extension: 'mp4' | 'webm' } | null => {
  for (const mime of VIDEO_MIME_CANDIDATES) {
    if (isTypeSupported(mime)) {
      const isMp4 = mime.startsWith('video/mp4');
      return { mime, isMp4, extension: isMp4 ? 'mp4' : 'webm' };
    }
  }
  return null;
};

export const VOICEVOX_CREDIT_PREFIX = 'VOICEVOX:';
export const POLLY_CREDIT = 'Voice: Amazon Polly';

/**
 * Text in the credit band. VOICEVOX voices must always carry
 * "VOICEVOX:<character name>"; Polly shows where the voice comes from.
 */
export const buildCreditLabel = (voicevoxCredit?: string | null): string =>
  voicevoxCredit ? voicevoxCredit : POLLY_CREDIT;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** speech-<voice>-YYYYMMDD_HHMMSS.<ext> (local time) */
export const buildVideoFileName = (
  prefix: string,
  date: Date,
  extension: string = 'mp4'
): string =>
  `${prefix}-${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}.${extension}`;

export const estimateVideoSeconds = (audioSeconds: number): number =>
  LEAD_SILENCE_SEC + audioSeconds + TAIL_SILENCE_SEC;

// ---------------------------------------------------------------------------
// Browser-only
// ---------------------------------------------------------------------------

export class VideoComposeError extends Error {
  code: 'fetch' | 'decode' | 'unsupported' | 'record' | 'aborted';
  constructor(code: VideoComposeError['code'], message: string) {
    super(message);
    this.name = 'VideoComposeError';
    this.code = code;
  }
}

export type CreateVideoOptions = {
  audioUrl: string;
  text: string;
  credit: string;
  // Background image (optional). Its object URL is managed by the caller.
  image?: HTMLImageElement | ImageBitmap | null;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
};

export type CreatedVideo = {
  blob: Blob;
  mime: string;
  isMp4: boolean;
  extension: 'mp4' | 'webm';
  durationSec: number;
};

const FONT_FAMILY =
  '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif';

const drawCreditBand = (ctx: CanvasRenderingContext2D, credit: string) => {
  const y = VIDEO_HEIGHT - CREDIT_BAND_HEIGHT;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(0, y, VIDEO_WIDTH, CREDIT_BAND_HEIGHT);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 30px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(credit, VIDEO_WIDTH / 2, y + CREDIT_BAND_HEIGHT / 2);
};

const imageSize = (image: HTMLImageElement | ImageBitmap) =>
  image instanceof HTMLImageElement
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };

// Static background (everything except the progress bar and credit)
const renderBackground = (
  options: Pick<CreateVideoOptions, 'text' | 'image'>
): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new VideoComposeError('unsupported', 'Canvas is unavailable');

  const { image, text } = options;
  if (image) {
    const { width, height } = imageSize(image);
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    // Blurred, cover-scaled copy fills the margins (falls back to dark
    // fill where ctx.filter is unsupported, e.g. Safari)
    if ('filter' in ctx) {
      const scale = Math.max(VIDEO_WIDTH / width, VIDEO_HEIGHT / height);
      ctx.save();
      ctx.filter = 'blur(32px) brightness(0.6)';
      ctx.drawImage(
        image,
        (VIDEO_WIDTH - width * scale) / 2,
        (VIDEO_HEIGHT - height * scale) / 2,
        width * scale,
        height * scale
      );
      ctx.restore();
    }
    const rect = fitImageRect(
      width,
      height,
      VIDEO_WIDTH,
      VIDEO_HEIGHT - CREDIT_BAND_HEIGHT
    );
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, VIDEO_HEIGHT);
    gradient.addColorStop(0, '#1f2a44');
    gradient.addColorStop(1, '#0e1424');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

    const layout = fitTextLayout(
      text,
      {
        width: VIDEO_WIDTH - TEXT_PADDING_X * 2,
        height:
          VIDEO_HEIGHT -
          CREDIT_BAND_HEIGHT -
          PROGRESS_BAR_HEIGHT -
          TEXT_PADDING_Y * 2,
      },
      (size) => {
        ctx.font = `500 ${size}px ${FONT_FAMILY}`;
        return (s) => ctx.measureText(s).width;
      }
    );
    ctx.font = `500 ${layout.fontSize}px ${FONT_FAMILY}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const lineHeight = layout.fontSize * LINE_HEIGHT_RATIO;
    const areaTop = PROGRESS_BAR_HEIGHT + TEXT_PADDING_Y;
    const areaHeight =
      VIDEO_HEIGHT -
      CREDIT_BAND_HEIGHT -
      PROGRESS_BAR_HEIGHT -
      TEXT_PADDING_Y * 2;
    const top =
      areaTop +
      Math.max(0, (areaHeight - lineHeight * layout.lines.length) / 2);
    layout.lines.forEach((line, i) => {
      ctx.fillText(line, TEXT_PADDING_X, top + i * lineHeight);
    });
  }
  return canvas;
};

const decodeAudio = async (
  audioCtx: AudioContext,
  url: string,
  signal?: AbortSignal
): Promise<AudioBuffer> => {
  let data: ArrayBuffer;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.arrayBuffer();
  } catch (e) {
    if (signal?.aborted) throw new VideoComposeError('aborted', 'Aborted');
    throw new VideoComposeError('fetch', (e as Error).message);
  }
  try {
    return await audioCtx.decodeAudioData(data);
  } catch (e) {
    // e.g. ogg_vorbis in Safari (UNVERIFIED)
    throw new VideoComposeError('decode', (e as Error)?.message ?? 'decode');
  }
};

/**
 * Record the video in real time (takes as long as the audio).
 * Drawing uses setInterval, not requestAnimationFrame, which stops in
 * background tabs.
 */
export const createVideoBlob = async (
  options: CreateVideoOptions
): Promise<CreatedVideo> => {
  const { audioUrl, credit, onProgress, signal } = options;

  if (
    typeof MediaRecorder === 'undefined' ||
    typeof HTMLCanvasElement.prototype.captureStream !== 'function'
  ) {
    throw new VideoComposeError('unsupported', 'MediaRecorder is unavailable');
  }
  const picked = pickVideoMime((m) => MediaRecorder.isTypeSupported(m));
  if (!picked) {
    throw new VideoComposeError('unsupported', 'No supported video format');
  }

  const audioCtx = new AudioContext();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stream: MediaStream | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await audioCtx.resume().catch(() => undefined);
    const buffer = await decodeAudio(audioCtx, audioUrl, signal);
    const durationSec = estimateVideoSeconds(buffer.duration);

    const background = renderBackground(options);
    const canvas = document.createElement('canvas');
    canvas.width = VIDEO_WIDTH;
    canvas.height = VIDEO_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx)
      throw new VideoComposeError('unsupported', 'Canvas is unavailable');

    let startedAt = 0;
    const draw = () => {
      const ratio = startedAt
        ? Math.min(1, (performance.now() - startedAt) / 1000 / durationSec)
        : 0;
      ctx.drawImage(background, 0, 0);
      if (!options.image) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fillRect(0, 0, VIDEO_WIDTH, PROGRESS_BAR_HEIGHT);
        ctx.fillStyle = '#4fc3f7';
        ctx.fillRect(0, 0, VIDEO_WIDTH * ratio, PROGRESS_BAR_HEIGHT);
      }
      drawCreditBand(ctx, credit);
      return ratio;
    };
    draw();

    // Audio goes to the recorder only (not to the speakers)
    const destination = audioCtx.createMediaStreamDestination();
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);

    stream = new MediaStream([
      ...canvas.captureStream(VIDEO_FPS).getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ]);
    const recorder = new MediaRecorder(stream, {
      mimeType: picked.mime,
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 128_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const finished = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () =>
        resolve(new Blob(chunks, { type: picked.mime.split(';')[0] }));
      recorder.onerror = () =>
        reject(new VideoComposeError('record', 'MediaRecorder error'));
      onAbort = () => {
        if (recorder.state !== 'inactive') recorder.stop();
        reject(new VideoComposeError('aborted', 'Aborted'));
      };
      signal?.addEventListener('abort', onAbort);
    });

    recorder.start(1000);
    startedAt = performance.now();
    source.start(audioCtx.currentTime + LEAD_SILENCE_SEC);
    timer = setInterval(() => {
      const ratio = draw();
      onProgress?.(ratio);
      if (ratio >= 1 && recorder.state === 'recording') recorder.stop();
    }, 1000 / VIDEO_FPS);

    const blob = await finished;
    onProgress?.(1);
    return {
      blob,
      mime: picked.mime,
      isMp4: picked.isMp4,
      extension: picked.extension,
      durationSec,
    };
  } finally {
    if (timer) clearInterval(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    stream?.getTracks().forEach((t) => t.stop());
    await audioCtx.close().catch(() => undefined);
  }
};
