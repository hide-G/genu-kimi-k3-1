import type { VoicevoxSpeaker } from 'generative-ai-use-cases';

// VOICEVOX ENGINE processes one request within the API Gateway timeout (29s),
// so the limit is conservative. UNVERIFIED: tune it after measuring real
// synthesis times on the MicroVM.
export const VOICEVOX_MAX_TEXT_LENGTH = 500;

const VVM_README_URL =
  'https://github.com/VOICEVOX/voicevox_vvm/blob/main/README.md';

/**
 * Allow list of VOICEVOX characters.
 *
 * GenU is deployed by companies, so only characters whose terms allow both
 * commercial and non-commercial use with credit notation alone are listed.
 * NOT listed on purpose (individual conditions apply, contact/pre-check
 * required): 青山龍星, もち子さん, No.7, Voidoll, ぞん子, ユーレイちゃん, 後鬼.
 *
 * UNVERIFIED: the style IDs and the terms of each character were written from
 * the task description and memory. Re-check them against the VVM README and
 * each character's terms before releasing.
 */
export const VOICEVOX_SPEAKERS: readonly VoicevoxSpeaker[] = [
  // The first entry is the head of the pull-down.
  {
    styleId: 127,
    characterName: 'ブイブイ・コバコ',
    styleName: 'ノーマル',
    termsUrl: 'https://vv-cobaco.com/terms',
  },
  {
    styleId: 3,
    characterName: 'ずんだもん',
    styleName: 'ノーマル',
    termsUrl: VVM_README_URL,
  },
  {
    styleId: 2,
    characterName: '四国めたん',
    styleName: 'ノーマル',
    termsUrl: VVM_README_URL,
  },
  {
    styleId: 8,
    characterName: '春日部つむぎ',
    styleName: 'ノーマル',
    termsUrl: VVM_README_URL,
  },
  {
    styleId: 16,
    characterName: '九州そら',
    styleName: 'ノーマル',
    termsUrl: VVM_README_URL,
  },
  {
    styleId: 14,
    characterName: '冥鳴ひまり',
    styleName: 'ノーマル',
    termsUrl: VVM_README_URL,
  },
  {
    styleId: 11,
    characterName: '玄野武宏',
    styleName: 'ノーマル',
    termsUrl: VVM_README_URL,
  },
  {
    styleId: 12,
    characterName: '白上虎太郎',
    styleName: 'ふつう',
    termsUrl: VVM_README_URL,
  },
];

export const findVoicevoxSpeaker = (
  styleId: unknown
): VoicevoxSpeaker | undefined =>
  VOICEVOX_SPEAKERS.find((s) => s.styleId === styleId);

// The credit text that is mandatory for VOICEVOX voices
export const buildVoicevoxCredit = (speaker: VoicevoxSpeaker): string =>
  `VOICEVOX:${speaker.characterName}`;
