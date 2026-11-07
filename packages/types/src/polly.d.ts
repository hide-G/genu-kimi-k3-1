export type PollyEngine = 'generative' | 'long-form' | 'neural' | 'standard';

export type PollyOutputFormat = 'mp3' | 'ogg_vorbis';

export type PollyVoice = {
  id: string;
  name: string;
  gender: string;
  languageCode: string;
  supportedEngines: PollyEngine[];
};

export type PollyLanguage = {
  code: string;
  name: string;
};

export type ListPollyVoicesResponse = {
  languages: PollyLanguage[];
  voices: PollyVoice[];
};

export type SynthesizeSpeechRequest = {
  text: string;
  voiceId: string;
  engine: PollyEngine;
  languageCode: string;
  outputFormat: PollyOutputFormat;
  speed: number;
};

export type SynthesizeSpeechResponse = {
  key: string;
  fileName: string;
  url: string;
  contentType: string;
  characters: number;
};
