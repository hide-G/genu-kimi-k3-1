import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiDownloadSimple, PiSpeakerHigh } from 'react-icons/pi';
import {
  PollyEngine,
  PollyOutputFormat,
  SynthesizeSpeechResponse,
} from 'generative-ai-use-cases';
import Card from '../components/Card';
import Button from '../components/Button';
import Alert from '../components/Alert';
import useTextToSpeechApi from '../hooks/useTextToSpeechApi';
import { getLanguageLabel } from '../utils/pollyLanguageLabel';

// Maximum characters per synchronous Polly request
const MAX_TEXT_LENGTH = 3000;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.0;
const ENGINE_PRIORITY: PollyEngine[] = [
  'generative',
  'long-form',
  'neural',
  'standard',
];
const OUTPUT_FORMATS: PollyOutputFormat[] = ['mp3', 'ogg_vorbis'];
// UI language -> Polly language code
const UI_LANGUAGE_TO_POLLY: Record<string, string> = {
  ja: 'ja-JP',
  en: 'en-US',
  ko: 'ko-KR',
  th: 'th-TH',
  vi: 'vi-VN',
  zh: 'cmn-CN',
};

const selectClassName =
  'w-full rounded border border-black/30 bg-white px-2 py-1.5 focus:outline-none';

const TextToSpeechPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { listVoices, synthesize } = useTextToSpeechApi();

  const [text, setText] = useState('');
  const [languageCode, setLanguageCode] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [engine, setEngine] = useState<PollyEngine | ''>('');
  const [speed, setSpeed] = useState(1);
  const [outputFormat, setOutputFormat] = useState<PollyOutputFormat>('mp3');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SynthesizeSpeechResponse | null>(null);

  const { data: languageData, error: languageError } = listVoices();
  const { data: voiceData, error: voiceError } = listVoices(
    languageCode || null
  );

  const languageDisplayNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([i18n.language], { type: 'language' });
    } catch {
      return null;
    }
  }, [i18n.language]);

  const languageOptions = useMemo(
    () =>
      (languageData?.languages ?? []).map((l) => ({
        value: l.code,
        label: getLanguageLabel(languageDisplayNames, l.code, l.name),
      })),
    [languageData, languageDisplayNames]
  );

  // Default language follows the UI language
  useEffect(() => {
    if (languageCode || !languageData || languageData.languages.length === 0) {
      return;
    }
    const preferred = UI_LANGUAGE_TO_POLLY[i18n.language.split('-')[0]];
    const codes = languageData.languages.map((l) => l.code);
    setLanguageCode(
      codes.includes(preferred)
        ? preferred
        : codes.includes('en-US')
          ? 'en-US'
          : codes[0]
    );
  }, [languageCode, languageData, i18n.language]);

  const voices = useMemo(() => {
    const list = voiceData?.voices ?? [];
    // Voices of the preferred engine come first
    const rank = (engines: PollyEngine[] = []) => {
      const ranks = engines
        .map((e) => ENGINE_PRIORITY.indexOf(e))
        .filter((r) => r >= 0);
      return ranks.length > 0 ? Math.min(...ranks) : ENGINE_PRIORITY.length;
    };
    return [...list].sort(
      (a, b) =>
        rank(a.supportedEngines) - rank(b.supportedEngines) ||
        (a.name ?? a.id).localeCompare(b.name ?? b.id)
    );
  }, [voiceData]);

  // Default voice is the first one for the language
  useEffect(() => {
    if (voices.length === 0) return;
    if (!voices.some((v) => v.id === voiceId)) {
      setVoiceId(voices[0].id);
    }
  }, [voices, voiceId]);

  const selectedVoice = useMemo(
    () => voices.find((v) => v.id === voiceId),
    [voices, voiceId]
  );

  const engines = useMemo(
    () =>
      ENGINE_PRIORITY.filter((e) =>
        selectedVoice?.supportedEngines?.includes(e)
      ),
    [selectedVoice]
  );

  // Default engine is the best one available for the voice
  useEffect(() => {
    if (engines.length === 0) return;
    if (!engine || !engines.includes(engine)) {
      setEngine(engines[0]);
    }
  }, [engines, engine]);

  const characters = useMemo(() => Array.from(text).length, [text]);
  const overLimit = characters > MAX_TEXT_LENGTH;
  const disabledExec =
    loading ||
    text.trim().length === 0 ||
    overLimit ||
    !languageCode ||
    !voiceId ||
    !engine;

  const onClickExec = useCallback(async () => {
    if (disabledExec || !engine) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await synthesize({
          text,
          voiceId,
          engine,
          languageCode,
          outputFormat,
          speed,
        })
      );
    } catch (e) {
      const message =
        (e as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? (e as Error)?.message;
      setError(message || t('error'));
    } finally {
      setLoading(false);
    }
  }, [
    disabledExec,
    engine,
    synthesize,
    text,
    voiceId,
    languageCode,
    outputFormat,
    speed,
    t,
  ]);

  const loadError = languageError || voiceError;

  const statusMessage = loading
    ? t('textToSpeech.status_generating')
    : error
      ? ''
      : result
        ? t('textToSpeech.status_done')
        : '';

  return (
    <div className="grid grid-cols-12">
      <div className="invisible col-span-12 my-0 flex h-0 items-center justify-center text-xl font-semibold lg:visible lg:my-5 lg:h-min print:visible print:my-5 print:h-min">
        {t('textToSpeech.title')}
      </div>
      <div className="col-span-12 col-start-1 mx-2 lg:col-span-10 lg:col-start-2 xl:col-span-10 xl:col-start-2">
        <Card label={t('textToSpeech.input_text')}>
          <label className="sr-only" htmlFor="tts-text">
            {t('textToSpeech.input_text')}
          </label>
          <textarea
            id="tts-text"
            className="w-full resize-y rounded border border-black/30 p-1.5 outline-none"
            rows={8}
            value={text}
            placeholder={t('textToSpeech.text_placeholder')}
            aria-describedby="tts-counter"
            aria-invalid={overLimit}
            onChange={(e) => setText(e.target.value)}
          />
          <div
            id="tts-counter"
            className={`mb-4 text-right text-sm ${overLimit ? 'font-bold text-red-600' : 'text-gray-500'}`}>
            {t('textToSpeech.character_count', {
              current: characters,
              max: MAX_TEXT_LENGTH,
            })}
            {overLimit && ` ${t('textToSpeech.too_long')}`}
          </div>

          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="text-sm" htmlFor="tts-language">
                {t('textToSpeech.language')}
              </label>
              <select
                id="tts-language"
                className={selectClassName}
                value={languageCode}
                onChange={(e) => {
                  setLanguageCode(e.target.value);
                  setVoiceId('');
                  setEngine('');
                }}>
                {languageOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm" htmlFor="tts-voice">
                {t('textToSpeech.voice')}
              </label>
              <select
                id="tts-voice"
                className={selectClassName}
                value={voiceId}
                onChange={(e) => {
                  setVoiceId(e.target.value);
                  setEngine('');
                }}>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.gender ? `${v.name} (${v.gender})` : v.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm" htmlFor="tts-engine">
                {t('textToSpeech.engine')}
              </label>
              <select
                id="tts-engine"
                className={selectClassName}
                value={engine}
                onChange={(e) => setEngine(e.target.value as PollyEngine)}>
                {engines.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm" htmlFor="tts-speed">
                {t('textToSpeech.speed', { speed: speed.toFixed(2) })}
              </label>
              <input
                id="tts-speed"
                type="range"
                className="w-full"
                min={MIN_SPEED}
                max={MAX_SPEED}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(Number.parseFloat(e.target.value))}
              />
            </div>
            <div>
              <label className="text-sm" htmlFor="tts-format">
                {t('textToSpeech.format')}
              </label>
              <select
                id="tts-format"
                className={selectClassName}
                value={outputFormat}
                onChange={(e) =>
                  setOutputFormat(e.target.value as PollyOutputFormat)
                }>
                {OUTPUT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f === 'mp3' ? 'mp3' : 'ogg (Vorbis)'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              disabled={disabledExec}
              loading={loading}
              onClick={onClickExec}>
              <PiSpeakerHigh className="mr-2" />
              {t('textToSpeech.generate')}
            </Button>
          </div>

          <div role="status" aria-live="polite" className="sr-only">
            {statusMessage}
          </div>

          {(error || loadError) && (
            <Alert
              severity="error"
              title={t('error')}
              className="mt-4"
              onDissmiss={error ? () => setError('') : undefined}>
              <div role="alert">
                {error || t('textToSpeech.load_voices_error')}
              </div>
            </Alert>
          )}

          {result && (
            <div className="mt-4 flex flex-col gap-3 border-t pt-4">
              <audio
                key={result.key}
                className="w-full"
                controls
                src={result.url}
                aria-label={t('textToSpeech.audio_label')}
              />
              <div className="flex justify-end">
                <a
                  href={result.url}
                  download={result.fileName}
                  className="bg-aws-smile flex items-center rounded-lg border p-1 px-3 text-white hover:brightness-75">
                  <PiDownloadSimple className="mr-2" />
                  {t('textToSpeech.download')}
                </a>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

export default TextToSpeechPage;
