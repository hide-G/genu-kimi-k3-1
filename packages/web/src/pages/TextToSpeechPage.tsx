import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { PiDownloadSimple, PiSpeakerHigh } from 'react-icons/pi';
import {
  PollyEngine,
  PollyOutputFormat,
  SynthesizeSpeechResponse,
} from 'generative-ai-use-cases';
import {
  VOICEVOX_MAX_TEXT_LENGTH,
  VOICEVOX_SPEAKERS,
  buildVoicevoxCredit,
} from '@generative-ai-use-cases/common';
import Card from '../components/Card';
import Button from '../components/Button';
import Alert from '../components/Alert';
import useTextToSpeechApi, {
  VoicevoxNotReadyTimeoutError,
} from '../hooks/useTextToSpeechApi';
import { getLanguageLabel } from '../utils/pollyLanguageLabel';
import {
  VideoComposeError,
  X_MAX_VIDEO_SECONDS,
  buildCreditLabel,
  buildVideoFileName,
  createVideoBlob,
  estimateVideoSeconds,
} from '../utils/videoComposer';

// VOICEVOX is shown only when the CDK parameter "voicevox" is enabled
// (and never in closed network mode; the CDK side already guarantees that).
const voicevoxEnabled: boolean =
  import.meta.env.VITE_APP_VOICEVOX_ENABLED === 'true';
const COBACO_STYLE_ID = 127;

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
// VOICEVOX ENGINE always returns WAV
const VOICEVOX_OUTPUT_FORMATS = ['wav'] as const;

type ResultInfo = {
  text: string;
  // "VOICEVOX:<character name>" for VOICEVOX, null for Polly
  credit: string | null;
  // File name prefix of the MP4: speech-<voice> / voicevox-<styleId>
  namePrefix: string;
  styleId: number | null;
};

type Mp4Result = { url: string; fileName: string; isMp4: boolean };
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
  const { listVoices, synthesize, voicevoxWarmup, voicevoxSynthesize } =
    useTextToSpeechApi();

  const [text, setText] = useState('');
  const [languageCode, setLanguageCode] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [engine, setEngine] = useState<PollyEngine | ''>('');
  const [speed, setSpeed] = useState(1);
  const [outputFormat, setOutputFormat] = useState<PollyOutputFormat>('mp3');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SynthesizeSpeechResponse | null>(null);
  const [resultInfo, setResultInfo] = useState<ResultInfo | null>(null);
  // VOICEVOX: '' means "do not use" (Amazon Polly)
  const [voicevoxStyleId, setVoicevoxStyleId] = useState('');
  const [waitingVoicevox, setWaitingVoicevox] = useState(false);
  // MP4
  const [imageUrl, setImageUrl] = useState('');
  const [mp4Loading, setMp4Loading] = useState(false);
  const [mp4Progress, setMp4Progress] = useState(0);
  const [mp4Error, setMp4Error] = useState('');
  const [mp4, setMp4] = useState<Mp4Result | null>(null);
  const [audioSeconds, setAudioSeconds] = useState(0);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mp4AbortRef = useRef<AbortController | null>(null);

  const voicevoxSpeaker = useMemo(
    () =>
      voicevoxEnabled
        ? VOICEVOX_SPEAKERS.find((v) => String(v.styleId) === voicevoxStyleId)
        : undefined,
    [voicevoxStyleId]
  );
  const usingVoicevox = !!voicevoxSpeaker;
  const voicevoxCredit = voicevoxSpeaker
    ? buildVoicevoxCredit(voicevoxSpeaker)
    : null;

  // Warm up the MicroVM once when a VOICEVOX character is selected.
  // The API returns immediately; failures are not fatal (synthesis retries).
  const warmupRef = useRef(voicevoxWarmup);
  warmupRef.current = voicevoxWarmup;
  useEffect(() => {
    if (!voicevoxStyleId) return;
    warmupRef.current().catch((e) => console.warn('VOICEVOX warmup failed', e));
  }, [voicevoxStyleId]);

  // Revoke object URLs when they are replaced / on unmount
  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl]
  );
  const mp4Url = mp4?.url;
  useEffect(
    () => () => {
      if (mp4Url) URL.revokeObjectURL(mp4Url);
    },
    [mp4Url]
  );
  useEffect(() => () => mp4AbortRef.current?.abort(), []);

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
  const maxLength = usingVoicevox ? VOICEVOX_MAX_TEXT_LENGTH : MAX_TEXT_LENGTH;
  const overLimit = characters > maxLength;
  const disabledExec =
    loading ||
    text.trim().length === 0 ||
    overLimit ||
    (!usingVoicevox && (!languageCode || !voiceId || !engine));

  const resetMp4 = useCallback(() => {
    mp4AbortRef.current?.abort();
    setMp4(null);
    setMp4Error('');
    setMp4Progress(0);
    setAudioSeconds(0);
  }, []);

  const onClickExec = useCallback(async () => {
    if (disabledExec) return;
    if (!usingVoicevox && !engine) return;
    setLoading(true);
    setError('');
    setResult(null);
    setResultInfo(null);
    resetMp4();
    try {
      if (voicevoxSpeaker) {
        const res = await voicevoxSynthesize(
          { text, styleId: voicevoxSpeaker.styleId, speed },
          { onWaiting: () => setWaitingVoicevox(true) }
        );
        setResult(res);
        setResultInfo({
          text,
          credit: res.credit || buildVoicevoxCredit(voicevoxSpeaker),
          namePrefix: `voicevox-${voicevoxSpeaker.styleId}`,
          styleId: voicevoxSpeaker.styleId,
        });
      } else {
        setResult(
          await synthesize({
            text,
            voiceId,
            engine: engine as PollyEngine,
            languageCode,
            outputFormat,
            speed,
          })
        );
        setResultInfo({
          text,
          credit: null,
          namePrefix: `speech-${voiceId.toLowerCase()}`,
          styleId: null,
        });
      }
    } catch (e) {
      if (e instanceof VoicevoxNotReadyTimeoutError) {
        setError(t('textToSpeech.voicevox_timeout'));
      } else {
        const message =
          (e as { response?: { data?: { message?: string } } })?.response?.data
            ?.message ?? (e as Error)?.message;
        setError(message || t('error'));
      }
    } finally {
      setLoading(false);
      setWaitingVoicevox(false);
    }
  }, [
    disabledExec,
    usingVoicevox,
    voicevoxSpeaker,
    engine,
    resetMp4,
    synthesize,
    voicevoxSynthesize,
    text,
    voiceId,
    languageCode,
    outputFormat,
    speed,
    t,
  ]);

  const onChangeImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setImageUrl(file ? URL.createObjectURL(file) : '');
  };
  const onClearImage = () => {
    setImageUrl('');
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const onClickMp4 = async () => {
    if (!result || !resultInfo || mp4Loading) return;
    const controller = new AbortController();
    mp4AbortRef.current = controller;
    setMp4Loading(true);
    setMp4Error('');
    setMp4Progress(0);
    setMp4(null);
    try {
      const image = imageUrl
        ? await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('image'));
            img.src = imageUrl;
          })
        : null;
      const created = await createVideoBlob({
        audioUrl: result.url,
        text: resultInfo.text,
        credit: buildCreditLabel(resultInfo.credit),
        image,
        signal: controller.signal,
        onProgress: (ratio) => setMp4Progress(Math.floor(ratio * 100)),
      });
      setMp4({
        url: URL.createObjectURL(created.blob),
        fileName: buildVideoFileName(
          resultInfo.namePrefix,
          new Date(),
          created.extension
        ),
        isMp4: created.isMp4,
      });
    } catch (e) {
      const code = e instanceof VideoComposeError ? e.code : 'generic';
      if (code !== 'aborted') {
        setMp4Error(
          t(
            code === 'decode' || code === 'fetch' || code === 'unsupported'
              ? `textToSpeech.mp4_error_${code}`
              : 'textToSpeech.mp4_error_generic'
          )
        );
      }
    } finally {
      setMp4Loading(false);
    }
  };

  const videoSeconds = Math.ceil(estimateVideoSeconds(audioSeconds));
  const tooLongForX = audioSeconds > 0 && videoSeconds > X_MAX_VIDEO_SECONDS;

  const loadError = languageError || voiceError;

  const statusMessage = loading
    ? waitingVoicevox
      ? t('textToSpeech.voicevox_starting')
      : t('textToSpeech.status_generating')
    : mp4Loading
      ? // Announce in 25% steps to keep the live region quiet
        t('textToSpeech.mp4_creating', {
          percent: Math.floor(mp4Progress / 25) * 25,
        })
      : mp4Error || error
        ? ''
        : mp4
          ? t('textToSpeech.mp4_done')
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
              max: maxLength,
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
                disabled={usingVoicevox}
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
              {usingVoicevox && (
                <p className="mt-1 text-xs text-gray-500">
                  {t('textToSpeech.voicevox_disabled_note')}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <label className="text-sm" htmlFor="tts-voice">
                  {t('textToSpeech.voice')}
                </label>
                <select
                  id="tts-voice"
                  className={selectClassName}
                  disabled={usingVoicevox}
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
                {usingVoicevox && (
                  <p className="mt-1 text-xs text-gray-500">
                    {t('textToSpeech.voicevox_disabled_note')}
                  </p>
                )}
              </div>
              {voicevoxEnabled && (
                <div>
                  <label className="text-sm" htmlFor="tts-voicevox">
                    {t('textToSpeech.voicevox_label')}
                  </label>
                  <select
                    id="tts-voicevox"
                    className={selectClassName}
                    value={voicevoxStyleId}
                    onChange={(e) => setVoicevoxStyleId(e.target.value)}>
                    <option value="">{t('textToSpeech.voicevox_none')}</option>
                    {VOICEVOX_SPEAKERS.map((v) => (
                      <option key={v.styleId} value={String(v.styleId)}>
                        {t('textToSpeech.voicevox_option', {
                          character: v.characterName,
                          style: v.styleName,
                        })}
                      </option>
                    ))}
                  </select>
                  {voicevoxSpeaker && voicevoxCredit && (
                    <p className="mt-1 text-xs text-gray-700">
                      {t('textToSpeech.voicevox_credit', {
                        credit: voicevoxCredit,
                      })}{' '}
                      <a
                        href={voicevoxSpeaker.termsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-aws-smile underline">
                        {t('textToSpeech.voicevox_terms', {
                          character: voicevoxSpeaker.characterName,
                        })}
                      </a>
                    </p>
                  )}
                </div>
              )}
            </div>
            <div>
              <label className="text-sm" htmlFor="tts-engine">
                {t('textToSpeech.engine')}
              </label>
              <select
                id="tts-engine"
                className={selectClassName}
                disabled={usingVoicevox}
                value={engine}
                onChange={(e) => setEngine(e.target.value as PollyEngine)}>
                {engines.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
              {usingVoicevox && (
                <p className="mt-1 text-xs text-gray-500">
                  {t('textToSpeech.voicevox_disabled_note')}
                </p>
              )}
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
                value={usingVoicevox ? 'wav' : outputFormat}
                onChange={(e) =>
                  setOutputFormat(e.target.value as PollyOutputFormat)
                }>
                {usingVoicevox
                  ? VOICEVOX_OUTPUT_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))
                  : OUTPUT_FORMATS.map((f) => (
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

          {result && resultInfo && (
            <div className="mt-4 flex flex-col gap-3 border-t pt-4">
              <audio
                key={result.key}
                className="w-full"
                controls
                src={result.url}
                aria-label={t('textToSpeech.audio_label')}
                onLoadedMetadata={(e) =>
                  setAudioSeconds(
                    Number.isFinite(e.currentTarget.duration)
                      ? e.currentTarget.duration
                      : 0
                  )
                }
              />
              {resultInfo.credit && (
                <div className="text-sm text-gray-700">
                  <p className="font-bold">
                    {t('textToSpeech.voicevox_credit', {
                      credit: resultInfo.credit,
                    })}
                  </p>
                  <p>
                    {t('textToSpeech.voicevox_credit_notice', {
                      credit: resultInfo.credit,
                    })}
                  </p>
                  <p>
                    {t('textToSpeech.voicevox_x_notice', {
                      credit: resultInfo.credit,
                    })}
                  </p>
                  {resultInfo.styleId === COBACO_STYLE_ID && (
                    <p>{t('textToSpeech.voicevox_cobaco_illust_notice')}</p>
                  )}
                </div>
              )}
              <div className="flex justify-end">
                <a
                  href={result.url}
                  download={result.fileName}
                  className="bg-aws-smile flex items-center rounded-lg border p-1 px-3 text-white hover:brightness-75">
                  <PiDownloadSimple className="mr-2" />
                  {t('textToSpeech.download')}
                </a>
              </div>

              <div className="flex flex-col gap-3 border-t pt-4">
                <h3 className="font-bold">
                  {t('textToSpeech.mp4_section_title')}
                </h3>
                <p className="text-sm text-gray-700">
                  {t('textToSpeech.mp4_description')}
                </p>
                <div>
                  <label className="text-sm" htmlFor="tts-image">
                    {t('textToSpeech.mp4_image_label')}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="tts-image"
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      disabled={mp4Loading}
                      aria-describedby="tts-image-notice"
                      onChange={onChangeImage}
                    />
                    {imageUrl && (
                      <Button
                        outlined
                        disabled={mp4Loading}
                        onClick={onClearImage}>
                        {t('textToSpeech.mp4_image_clear')}
                      </Button>
                    )}
                  </div>
                  <p
                    id="tts-image-notice"
                    className="mt-1 text-xs text-gray-500">
                    {t('textToSpeech.mp4_image_notice')}
                  </p>
                  {imageUrl && (
                    <img
                      src={imageUrl}
                      alt={t('textToSpeech.mp4_image_alt')}
                      className="mt-2 max-h-40 rounded border"
                    />
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  {t('textToSpeech.mp4_realtime_note')}
                </p>
                {tooLongForX && (
                  <p className="text-sm text-red-600">
                    {t('textToSpeech.mp4_too_long', { seconds: videoSeconds })}
                  </p>
                )}
                <div className="flex items-center justify-end gap-3">
                  {mp4Loading && (
                    <progress
                      className="w-40"
                      max={100}
                      value={mp4Progress}
                      aria-label={t('textToSpeech.mp4_creating', {
                        percent: mp4Progress,
                      })}
                    />
                  )}
                  <Button
                    disabled={mp4Loading}
                    loading={mp4Loading}
                    aria-busy={mp4Loading}
                    onClick={onClickMp4}>
                    {mp4Loading
                      ? t('textToSpeech.mp4_creating', {
                          percent: mp4Progress,
                        })
                      : t('textToSpeech.mp4_create')}
                  </Button>
                </div>
                {mp4Error && (
                  <Alert
                    severity="error"
                    title={t('error')}
                    onDissmiss={() => setMp4Error('')}>
                    <div role="alert">{mp4Error}</div>
                  </Alert>
                )}
                {mp4 && (
                  <div className="flex flex-col gap-3">
                    {!mp4.isMp4 && (
                      <p
                        className="text-sm font-bold text-red-600"
                        role="alert">
                        {t('textToSpeech.mp4_webm_warning')}
                      </p>
                    )}
                    <video
                      key={mp4.url}
                      className="w-full max-w-2xl rounded border"
                      controls
                      src={mp4.url}
                      aria-label={t('textToSpeech.mp4_video_label')}
                    />
                    <div className="flex justify-end">
                      <a
                        href={mp4.url}
                        download={mp4.fileName}
                        className="bg-aws-smile flex items-center rounded-lg border p-1 px-3 text-white hover:brightness-75">
                        <PiDownloadSimple className="mr-2" />
                        {t('textToSpeech.mp4_download')}
                      </a>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

export default TextToSpeechPage;
