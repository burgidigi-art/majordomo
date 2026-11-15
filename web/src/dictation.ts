// Dictation: speaking into a message box instead of typing. Plain functions here, so they can be
// tested without a browser; the button that uses them is components/Mic.tsx.

/**
 * server: record in the browser and send the recording to the voice-note transcriber (an OpenAI or
 * Gemini key, or a command on this computer). browser: the browser's own speech recognition, which
 * shows the words as they are spoken; Chrome and Edge send the audio to Google, Safari to Apple.
 */
export type DictationEngine = 'server' | 'browser';

/** The transcriber the user set up wins: it is the one they chose, and usually the more accurate. */
export function pickEngine(serverReady: boolean, browserSpeech: boolean, recorder: boolean): DictationEngine | null {
  if (serverReady && recorder) return 'server';
  if (browserSpeech) return 'browser';
  return null;
}

/** Spoken words go after whatever was already typed, with one space between. */
export function joinDictation(typed: string, spoken: string): string {
  const words = spoken.trim();
  if (!words) return typed;
  if (!typed) return words;
  return /\s$/.test(typed) ? `${typed}${words}` : `${typed} ${words}`;
}

// A question, judged from its opening words: the browser's recogniser hands over text only, so the
// rising tone that marks a question is not available to it. Leading fillers ("hey", "so") are skipped.
const FILLER = '(?:(?:hey|hi|so|and|but|ok|okay|also|well|um|uh|oh|now|then|quick question)[,]?\\s+)*';
const ASKS =
  '(?:who|what|when|where|why|how|which|whose|whom|is|are|am|was|were|do|does|did|can|could|would|will|should|shall|may|might|' +
  "have|has|had|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|couldn't|wouldn't|won't|shouldn't|haven't|hasn't)";
const QUESTION = new RegExp(`^${FILLER}${ASKS}\\b`, 'i');

/**
 * The browser's recogniser returns bare words, one phrase per pause. Give each phrase a capital
 * letter and an ending: a question mark when it opens like a question, otherwise a period.
 */
export function punctuate(phrase: string): string {
  const s = phrase.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const cap = s[0]!.toUpperCase() + s.slice(1);
  if (/[.?!,;:…]$/.test(cap)) return cap;
  return `${cap}${QUESTION.test(cap) ? '?' : '.'}`;
}

/** The recording format to ask for: the first one this browser can make that the transcriber reads. */
export function recordingType(supported: (type: string) => boolean): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(supported) ?? '';
}

/** What to tell the user when the browser's recogniser stops with an error. Empty: say nothing. */
export function speechError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The microphone is blocked. Allow it for this page, and for your browser in System Settings → Privacy & Security → Microphone.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'Dictation needs an internet connection in this browser.';
    case 'no-speech':
    case 'aborted':
      return '';
    default:
      return `Dictation stopped (${code}).`;
  }
}

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
