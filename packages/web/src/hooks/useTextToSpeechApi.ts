import {
  ListPollyVoicesResponse,
  SynthesizeSpeechRequest,
  SynthesizeSpeechResponse,
  VoicevoxSynthesizeRequest,
  VoicevoxSynthesizeResponse,
  VoicevoxWarmupResponse,
} from 'generative-ai-use-cases';
import useHttp from './useHttp';

// Give up on VOICEVOX after this long (the MicroVM may be starting)
export const VOICEVOX_RETRY_LIMIT_MS = 60_000;
const DEFAULT_RETRY_SECONDS = 5;

export class VoicevoxNotReadyTimeoutError extends Error {
  constructor() {
    super('VOICEVOX did not become ready in time.');
    this.name = 'VoicevoxNotReadyTimeoutError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const useTextToSpeechApi = () => {
  const http = useHttp();
  return {
    listVoices: (languageCode?: string | null) => {
      // null: do not fetch, undefined: all languages
      const url =
        languageCode === null
          ? null
          : languageCode
            ? `polly/voices?languageCode=${encodeURIComponent(languageCode)}`
            : 'polly/voices';
      return http.get<ListPollyVoicesResponse>(url, {
        revalidateOnFocus: false,
      });
    },
    synthesize: async (
      req: SynthesizeSpeechRequest
    ): Promise<SynthesizeSpeechResponse> => {
      const res = await http.post<
        SynthesizeSpeechResponse,
        SynthesizeSpeechRequest
      >('polly/synthesize', req);
      return res.data;
    },
    // Ask the backend to start (or reuse) the VOICEVOX MicroVM. It returns
    // immediately without waiting for the MicroVM to be RUNNING.
    voicevoxWarmup: async (): Promise<VoicevoxWarmupResponse> => {
      const res = await http.post<VoicevoxWarmupResponse, undefined>(
        'voicevox/warmup',
        undefined
      );
      return res.data;
    },
    // The backend answers 503 { retryAfterSeconds } while VOICEVOX is not
    // ready. Retry every few seconds for up to VOICEVOX_RETRY_LIMIT_MS.
    voicevoxSynthesize: async (
      req: VoicevoxSynthesizeRequest,
      options: { onWaiting?: () => void; signal?: AbortSignal } = {}
    ): Promise<VoicevoxSynthesizeResponse> => {
      const startedAt = Date.now();
      for (;;) {
        try {
          const res = await http.post<
            VoicevoxSynthesizeResponse,
            VoicevoxSynthesizeRequest
          >('voicevox/synthesize', req);
          return res.data;
        } catch (e) {
          const response = (
            e as {
              response?: {
                status?: number;
                data?: { retryAfterSeconds?: number };
              };
            }
          )?.response;
          if (response?.status !== 503) throw e;
          const waitMs =
            Math.min(
              10,
              Math.max(
                2,
                response.data?.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS
              )
            ) * 1000;
          if (
            Date.now() - startedAt + waitMs > VOICEVOX_RETRY_LIMIT_MS ||
            options.signal?.aborted
          ) {
            throw new VoicevoxNotReadyTimeoutError();
          }
          options.onWaiting?.();
          await sleep(waitMs);
        }
      }
    },
  };
};

export default useTextToSpeechApi;
