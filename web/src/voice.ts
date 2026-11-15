// Voice mode: the manager's replies read aloud, and a hands-free back-and-forth. Plain functions
// here, so they can be tested without a browser.

/**
 * A reply as it should sound. Replies are Markdown; code, tables and addresses are for reading on
 * screen, so they are named rather than read out symbol by symbol.
 */
export function speakable(markdown: string): string {
  let s = markdown.replace(/\r/g, '');
  s = s.replace(/```[\s\S]*?(```|$)/g, '\n(Code is shown on screen.)\n');
  s = s.replace(/^(\s*\|.*\|\s*\n?)+/gm, '\n(A table is shown on screen.)\n');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // An address ends before any punctuation that follows it, so the sentence keeps its full stop.
  s = s.replace(/<?https?:\/\/[^\s>)]*[^\s>).,;:!?'"]>?/g, 'a link');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/gm, '');
  s = s.replace(/^\s*([-*_]\s*){3,}$/gm, '');
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2');
  s = s.replace(/~~(.+?)~~/g, '$1');
  // Each line becomes its own sentence, so list items and headings get a pause between them.
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;…)]$/.test(l) ? l : `${l}.`));
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Text cut into pieces of at most `max` characters, at sentence ends where possible. Browser voices
 * stop partway through long utterances, and the OpenAI voice takes 4096 characters per request.
 */
export function chunks(text: string, max: number): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [];
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const raw of sentences) {
    let sentence = raw;
    while (sentence.length > max) {
      // A sentence longer than a piece is cut at the last space that fits.
      push();
      const cut = sentence.lastIndexOf(' ', max);
      const at = cut > max / 2 ? cut : max;
      out.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at);
    }
    if (cur.length + sentence.length > max) push();
    cur += sentence;
  }
  push();
  return out;
}

export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}

/**
 * The best of the computer's voices for this language. macOS ships plain voices and, when downloaded
 * under Spoken Content, much better "Enhanced" and "Premium" ones; those win.
 */
export function pickVoice<V extends VoiceInfo>(voices: V[], lang: string, preferred = ''): V | null {
  if (preferred) {
    const chosen = voices.find((v) => v.name === preferred);
    if (chosen) return chosen;
  }
  const want = lang.toLowerCase();
  const base = want.split('-')[0]!;
  const score = (v: V) => {
    const l = v.lang.toLowerCase().replace('_', '-');
    let s = 0;
    if (l === want) s += 40;
    else if (l.split('-')[0] === base) s += 25;
    else return -1;
    if (/premium/i.test(v.name)) s += 20;
    else if (/enhanced|neural|natural/i.test(v.name)) s += 15;
    if (/\b(ava|zoe|samantha|evan|tom|serena|daniel|karen|moira|google us english)\b/i.test(v.name)) s += 5;
    // Novelty voices that ship with macOS.
    if (/albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley/i.test(v.name)) s -= 30;
    if (v.localService) s += 2;
    if (v.default) s += 1;
    return s;
  };
  const ranked = voices.map((v) => [score(v), v] as const).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]);
  return ranked[0]?.[1] ?? voices[0] ?? null;
}

/** Saying one of these on its own ends hands-free mode. */
export function isStopPhrase(text: string): boolean {
  return /^\s*(stop|stop listening|that'?s all|that is all|end voice mode|exit voice mode|goodbye|bye|we'?re done|i'?m done)[\s.!]*$/i.test(text);
}

/**
 * Notices when someone has finished speaking, from the loudness of the microphone sampled many
 * times a second. Speech is anything clearly above the room's own noise; the turn is over after a
 * pause of `pauseMs` once speech has been heard, or after `waitMs` if nothing was said at all.
 */
export class TurnDetector {
  private floor = Infinity;
  private heardAt = 0;
  private lastLoud = 0;
  private readonly startedAt: number;

  constructor(
    now: number,
    private readonly opts: { pauseMs?: number; waitMs?: number; maxMs?: number } = {},
  ) {
    this.startedAt = now;
  }

  get heardSpeech(): boolean {
    return this.heardAt > 0;
  }

  /** `level` is the RMS of a frame, 0 to 1. Returns what has happened, if anything. */
  update(level: number, now: number): 'done' | 'nothing-said' | null {
    const { pauseMs = 1300, waitMs = 9000, maxMs = 90_000 } = this.opts;
    // Track the quiet level of the room, rising slowly so a steady hum does not count as speech.
    this.floor = Math.min(level, this.floor === Infinity ? level : this.floor * 1.002 + 0.00002);
    // Speech is either clearly above the room, or loud in its own right: someone who starts talking
    // the moment listening begins has no quiet moment for the room's level to be measured from.
    const loud = level > 0.06 || level > Math.max(0.02, this.floor * 3);
    if (loud) {
      if (!this.heardAt) this.heardAt = now;
      this.lastLoud = now;
    }
    if (now - this.startedAt > maxMs) return this.heardAt ? 'done' : 'nothing-said';
    if (this.heardAt && now - this.lastLoud > pauseMs) return 'done';
    if (!this.heardAt && now - this.startedAt > waitMs) return 'nothing-said';
    return null;
  }
}
