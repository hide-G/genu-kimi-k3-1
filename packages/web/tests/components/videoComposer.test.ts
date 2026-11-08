/* eslint-disable i18nhelper/no-jp-string -- Japanese is the target of the text wrapping tests */
import { describe, it, expect } from 'vitest';
import {
  buildCreditLabel,
  buildVideoFileName,
  fitImageRect,
  fitTextLayout,
  pickVideoMime,
  wrapText,
} from '../../src/utils/videoComposer';

// Every character is 10px wide
const measure10 = (s: string) => Array.from(s).length * 10;

describe('wrapText', () => {
  it('wraps per character', () => {
    expect(wrapText('あいうえおかきく', 30, measure10)).toEqual([
      'あいう',
      'えおか',
      'きく',
    ]);
  });
  it('keeps explicit line breaks and empty lines', () => {
    expect(wrapText('ab\n\ncd', 100, measure10)).toEqual(['ab', '', 'cd']);
  });
  it('does not split surrogate pairs', () => {
    expect(wrapText('😀😀😀', 20, measure10)).toEqual(['😀😀', '😀']);
  });
  it('returns null when over maxLines', () => {
    expect(wrapText('あいうえおかきく', 30, measure10, 2)).toBeNull();
    expect(wrapText('あいうえおかきく', 30, measure10, 3)).toHaveLength(3);
  });
  it('returns null when explicit breaks exceed maxLines', () => {
    expect(wrapText('a\nb\nc', 100, measure10, 2)).toBeNull();
  });
});

describe('fitTextLayout', () => {
  // width of a char = fontSize
  const measureAt = (size: number) => (s: string) =>
    Array.from(s).length * size;

  it('uses the largest font size that fits', () => {
    const layout = fitTextLayout(
      'あ'.repeat(10),
      { width: 100, height: 100 },
      measureAt,
      { minFontSize: 10, maxFontSize: 50, lineHeightRatio: 1 }
    );
    // 50px: 2 chars/line -> 5 lines*50 > 100. 25px: 4/line -> 3 lines = 75 OK
    // 33px: 3/line -> 4 lines = 132 > 100. 28px: 3/line -> 4 lines = 112 > 100
    // 25px is the first that fits
    expect(layout.fontSize).toBe(25);
    expect(layout.truncated).toBe(false);
    expect(layout.lines.join('')).toBe('あ'.repeat(10));
  });
  it('truncates with an ellipsis when it cannot fit at the minimum size', () => {
    const layout = fitTextLayout(
      'あ'.repeat(100),
      { width: 100, height: 40 },
      measureAt,
      { minFontSize: 10, maxFontSize: 20, lineHeightRatio: 1 }
    );
    expect(layout.truncated).toBe(true);
    expect(layout.fontSize).toBe(10);
    expect(layout.lines).toHaveLength(4);
    const last = layout.lines[layout.lines.length - 1];
    expect(last.endsWith('…')).toBe(true);
    expect(Array.from(last).length * 10).toBeLessThanOrEqual(100);
  });
});

describe('fitImageRect', () => {
  it('fits a wide image by width', () => {
    expect(fitImageRect(2000, 1000, 1000, 1000)).toEqual({
      x: 0,
      y: 250,
      width: 1000,
      height: 500,
    });
  });
  it('fits a tall image by height', () => {
    expect(fitImageRect(1000, 2000, 1280, 656)).toEqual({
      x: (1280 - 328) / 2,
      y: 0,
      width: 328,
      height: 656,
    });
  });
  it('upscales a small image and keeps the aspect ratio', () => {
    const r = fitImageRect(100, 100, 400, 200);
    expect(r).toEqual({ x: 100, y: 0, width: 200, height: 200 });
  });
  it('falls back to the full box for invalid sizes', () => {
    expect(fitImageRect(0, 0, 10, 20)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 20,
    });
  });
});

describe('pickVideoMime', () => {
  it('prefers H.264 + AAC MP4', () => {
    expect(pickVideoMime(() => true)).toEqual({
      mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      isMp4: true,
      extension: 'mp4',
    });
  });
  it('falls through the candidates in order', () => {
    expect(pickVideoMime((m) => m === 'video/mp4')?.mime).toBe('video/mp4');
    expect(pickVideoMime((m) => m.startsWith('video/webm'))?.mime).toBe(
      'video/webm;codecs=vp9,opus'
    );
  });
  it('flags WebM as not MP4', () => {
    const r = pickVideoMime((m) => m === 'video/webm');
    expect(r).toEqual({
      mime: 'video/webm',
      isMp4: false,
      extension: 'webm',
    });
  });
  it('returns null when nothing is supported', () => {
    expect(pickVideoMime(() => false)).toBeNull();
  });
});

describe('buildCreditLabel', () => {
  it('uses the VOICEVOX credit as-is', () => {
    expect(buildCreditLabel('VOICEVOX:ブイブイ・コバコ')).toBe(
      'VOICEVOX:ブイブイ・コバコ'
    );
  });
  it('shows Amazon Polly otherwise', () => {
    expect(buildCreditLabel(undefined)).toBe('Voice: Amazon Polly');
    expect(buildCreditLabel(null)).toBe('Voice: Amazon Polly');
    expect(buildCreditLabel('')).toBe('Voice: Amazon Polly');
  });
});

describe('buildVideoFileName', () => {
  it('formats as <prefix>-YYYYMMDD_HHMMSS.mp4', () => {
    const d = new Date(2026, 10, 8, 9, 5, 3);
    expect(buildVideoFileName('speech-joanna', d)).toBe(
      'speech-joanna-20261108_090503.mp4'
    );
    expect(buildVideoFileName('voicevox-127', d)).toBe(
      'voicevox-127-20261108_090503.mp4'
    );
  });
});
