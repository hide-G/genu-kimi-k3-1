// VOICEVOX speaker entry of the allow list (see @generative-ai-use-cases/common)
export type VoicevoxSpeaker = {
  styleId: number;
  characterName: string;
  styleName: string;
  termsUrl: string;
};

export type VoicevoxSynthesizeRequest = {
  text: string;
  styleId: number;
  speed: number;
};

export type VoicevoxSynthesizeResponse = {
  key: string;
  fileName: string;
  url: string;
  contentType: 'audio/wav';
  characters: number;
  // "VOICEVOX:<character name>" (the credit is mandatory)
  credit: string;
};

export type VoicevoxMicrovmState =
  | 'PENDING'
  | 'RUNNING'
  | 'SUSPENDING'
  | 'SUSPENDED'
  | 'TERMINATING'
  | 'TERMINATED'
  | string;

export type VoicevoxWarmupResponse = {
  state: VoicevoxMicrovmState;
};

// 503 body while the MicroVM / ENGINE is not ready
export type VoicevoxNotReadyResponse = {
  message: string;
  retryAfterSeconds: number;
};
