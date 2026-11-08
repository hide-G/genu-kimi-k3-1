import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  RunMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import {
  VOICEVOX_MAX_TEXT_LENGTH,
  findVoicevoxSpeaker,
} from '@generative-ai-use-cases/common';
import type { VoicevoxSynthesizeRequest } from 'generative-ai-use-cases';

/**
 * Helpers for running VOICEVOX ENGINE on an AWS Lambda MicroVM.
 *
 * The API shapes (camelCase inputs, `items` in ListMicrovms, `authToken` as a
 * map, the X-aws-proxy-port header, ...) follow the task description, and the
 * SDK property names were checked against @aws-sdk/client-lambda-microvms
 * 3.1164.0 type definitions. Behaviour against a real MicroVM is UNVERIFIED
 * in this repository's tests (everything is mocked).
 */

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2.0;
export const DEFAULT_ENGINE_PORT = 50021;

// MicroVM states that can serve a request (SUSPENDED resumes automatically)
const REUSABLE_STATES = ['RUNNING', 'PENDING', 'SUSPENDED'] as const;

export type VoicevoxConfig = {
  region: string;
  imageArn: string;
  enginePort: number;
};

export type MicrovmItemLike = {
  microvmId?: string;
  state?: string;
  imageArn?: string;
  startedAt?: Date;
};

export type MicrovmInfo = {
  microvmId: string;
  state: string;
  endpoint?: string;
};

/** Thrown when the MicroVM / ENGINE is not ready yet (HTTP 503). */
export class VoicevoxNotReadyError extends Error {
  retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds = 5) {
    super(message);
    this.name = 'VoicevoxNotReadyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Pure functions (unit tested)
// ---------------------------------------------------------------------------

/**
 * Pick a MicroVM to reuse from the ListMicrovms `items`.
 * Only MicroVMs of the same image (imageArn) are reused, because the account
 * may have MicroVMs of other images. RUNNING is preferred, then PENDING, then
 * SUSPENDED; the newest one wins within the same state.
 */
export const findReusable = (
  items: MicrovmItemLike[] | undefined | null,
  imageArn: string
): MicrovmItemLike | undefined => {
  const rank = (state?: string) =>
    REUSABLE_STATES.indexOf(state as (typeof REUSABLE_STATES)[number]);
  return (items ?? [])
    .filter(
      (i) => !!i.microvmId && i.imageArn === imageArn && rank(i.state) >= 0
    )
    .sort(
      (a, b) =>
        rank(a.state) - rank(b.state) ||
        (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0)
    )[0];
};

/**
 * `authToken` of CreateMicrovmAuthToken is a map (header name -> value), not a
 * string. Expand it as-is into request headers.
 */
export const authTokenToHeaders = (
  authToken: Record<string, string> | undefined | null
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(authToken ?? {})) {
    if (typeof value === 'string') headers[key] = value;
  }
  if (Object.keys(headers).length === 0) {
    throw new Error('CreateMicrovmAuthToken returned an empty authToken.');
  }
  return headers;
};

/**
 * `endpoint` may be returned as a bare host name. Always return an https URL
 * without a trailing slash. Do NOT append ":50021": the port is selected with
 * the X-aws-proxy-port header (a port in the URL changes the TLS target).
 */
export const toBaseUrl = (endpoint: string): string => {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('endpoint is empty.');
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error('endpoint must use https.');
  }
  return `https://${trimmed}`;
};

/**
 * Validate the body of POST /voicevox/synthesize.
 * Returns an error message, or null when valid.
 */
export const validateVoicevoxRequest = (
  req: Partial<VoicevoxSynthesizeRequest> | null | undefined
): string | null => {
  if (!req || typeof req !== 'object') {
    return 'Request body is required.';
  }
  if (typeof req.text !== 'string' || req.text.trim().length === 0) {
    return 'text is required.';
  }
  const length = Array.from(req.text).length;
  if (length > VOICEVOX_MAX_TEXT_LENGTH) {
    return `text must be ${VOICEVOX_MAX_TEXT_LENGTH} characters or less (received ${length}).`;
  }
  if (!findVoicevoxSpeaker(req.styleId)) {
    return 'styleId is not allowed.';
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

export const loadVoicevoxConfig = (
  env: NodeJS.ProcessEnv = process.env
): VoicevoxConfig | null => {
  if (!env.VOICEVOX_REGION || !env.VOICEVOX_MICROVM_IMAGE_ARN) return null;
  const port = Number.parseInt(env.VOICEVOX_ENGINE_PORT ?? '', 10);
  return {
    region: env.VOICEVOX_REGION,
    imageArn: env.VOICEVOX_MICROVM_IMAGE_ARN,
    enginePort: Number.isInteger(port) && port > 0 ? port : DEFAULT_ENGINE_PORT,
  };
};

// ---------------------------------------------------------------------------
// SDK / HTTP functions (mocked in handler tests)
// ---------------------------------------------------------------------------

let client: LambdaMicrovmsClient | undefined;
let clientRegion: string | undefined;
// Cache within the Lambda execution environment. The MicroVM is always
// re-checked with GetMicrovm before use.
let cache: { microvmId: string; endpoint?: string } | undefined;

export const resetVoicevoxCache = () => {
  client = undefined;
  clientRegion = undefined;
  cache = undefined;
};

// The MicroVM region can differ from the stack region: always pass it.
const getClient = (config: VoicevoxConfig): LambdaMicrovmsClient => {
  if (!client || clientRegion !== config.region) {
    client = new LambdaMicrovmsClient({ region: config.region });
    clientRegion = config.region;
  }
  return client;
};

const getMicrovm = async (
  config: VoicevoxConfig,
  microvmId: string
): Promise<MicrovmInfo> => {
  const res = await getClient(config).send(
    new GetMicrovmCommand({ microvmIdentifier: microvmId })
  );
  return {
    microvmId: res.microvmId ?? microvmId,
    state: res.state ?? 'UNKNOWN',
    endpoint: res.endpoint,
  };
};

const isReusableState = (state: string) =>
  (REUSABLE_STATES as readonly string[]).includes(state);

const listAll = async (config: VoicevoxConfig): Promise<MicrovmItemLike[]> => {
  const items: MicrovmItemLike[] = [];
  let nextToken: string | undefined;
  // Bounded loop to avoid unbounded pagination
  for (let page = 0; page < 10; page++) {
    const res = await getClient(config).send(
      // Filtering is done by findReusable (imageArn must match exactly)
      new ListMicrovmsCommand({ nextToken })
    );
    // NOTE: the response key is `items` (not `microvms`)
    items.push(...(res.items ?? []));
    nextToken = res.nextToken;
    if (!nextToken) break;
  }
  return items;
};

const runMicrovm = async (config: VoicevoxConfig): Promise<MicrovmInfo> => {
  const connector = (name: string) =>
    `arn:aws:lambda:${config.region}:aws:network-connector:aws-network-connector:${name}`;
  const res = await getClient(config).send(
    new RunMicrovmCommand({
      // imageIdentifier must be the ARN, not the image name
      imageIdentifier: config.imageArn,
      ingressNetworkConnectors: [connector('ALL_INGRESS')],
      egressNetworkConnectors: [connector('INTERNET_EGRESS')],
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: 900,
        suspendedDurationSeconds: 300,
      },
    })
  );
  if (!res.microvmId) throw new Error('RunMicrovm returned no microvmId.');
  return {
    microvmId: res.microvmId,
    state: res.state ?? 'PENDING',
    endpoint: res.endpoint,
  };
};

/**
 * Make sure a MicroVM exists (reuse the existing one, or start a new one).
 * Never waits for it to become RUNNING.
 */
export const ensureMicrovm = async (
  config: VoicevoxConfig
): Promise<MicrovmInfo> => {
  if (cache) {
    try {
      const info = await getMicrovm(config, cache.microvmId);
      if (isReusableState(info.state)) {
        cache = { microvmId: info.microvmId, endpoint: info.endpoint };
        return info;
      }
    } catch (e) {
      console.log('Cached MicroVM is not usable', e);
    }
    cache = undefined;
  }

  const reusable = findReusable(await listAll(config), config.imageArn);
  const info = reusable?.microvmId
    ? await getMicrovm(config, reusable.microvmId)
    : await runMicrovm(config);
  cache = { microvmId: info.microvmId, endpoint: info.endpoint };
  return info;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type EngineAccess = {
  baseUrl: string;
  headers: Record<string, string>;
};

/**
 * Get the base URL and headers (auth token + port) to call ENGINE.
 * Throws VoicevoxNotReadyError unless the MicroVM can serve a request.
 */
export const getEngineAccess = async (
  config: VoicevoxConfig
): Promise<EngineAccess> => {
  const info = await ensureMicrovm(config);
  if (info.state !== 'RUNNING' && info.state !== 'SUSPENDED') {
    throw new VoicevoxNotReadyError(
      `VOICEVOX is starting (state: ${info.state}).`
    );
  }
  if (!info.endpoint) {
    throw new VoicevoxNotReadyError('VOICEVOX endpoint is not available yet.');
  }
  const token = await getClient(config).send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: info.microvmId,
      expirationInMinutes: 15,
      allowedPorts: [{ allPorts: {} }],
    })
  );
  return {
    baseUrl: toBaseUrl(info.endpoint),
    headers: {
      ...authTokenToHeaders(token.authToken),
      // The dedicated endpoint forwards to 8080 by default
      'X-aws-proxy-port': String(config.enginePort),
    },
  };
};

const ENGINE_RETRIES = 3;
const ENGINE_RETRY_DELAY_MS = 1500;

/** fetch with a few retries on 502 (just after resume). */
export const engineFetch = async (
  access: EngineAccess,
  path: string,
  init: { method: string; body?: string; contentType?: string },
  signal?: AbortSignal
): Promise<Response> => {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${access.baseUrl}${path}`, {
      method: init.method,
      headers: {
        ...access.headers,
        ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
      },
      body: init.body,
      signal,
    });
    if (res.status !== 502) return res;
    if (attempt >= ENGINE_RETRIES) {
      throw new VoicevoxNotReadyError('VOICEVOX ENGINE is not ready yet.');
    }
    await sleep(ENGINE_RETRY_DELAY_MS);
  }
};

/** audio_query -> override speedScale -> synthesis. Returns WAV bytes. */
export const synthesizeWav = async (
  access: EngineAccess,
  text: string,
  styleId: number,
  speed: number,
  signal?: AbortSignal
): Promise<Buffer> => {
  const queryRes = await engineFetch(
    access,
    `/audio_query?speaker=${styleId}&text=${encodeURIComponent(text)}`,
    { method: 'POST' },
    signal
  );
  if (!queryRes.ok) {
    throw new Error(`audio_query failed: ${queryRes.status}`);
  }
  const query = (await queryRes.json()) as Record<string, unknown>;
  query.speedScale = speed;

  const synthRes = await engineFetch(
    access,
    `/synthesis?speaker=${styleId}`,
    {
      method: 'POST',
      body: JSON.stringify(query),
      contentType: 'application/json',
    },
    signal
  );
  if (!synthRes.ok) {
    throw new Error(`synthesis failed: ${synthRes.status}`);
  }
  return Buffer.from(await synthRes.arrayBuffer());
};
