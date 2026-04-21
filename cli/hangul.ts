// Hangul syllable composer for raw-mode terminal input.
// In raw mode the OS IME cannot compose; individual jamo arrive instead.
// This class buffers them and yields completed syllables.

const CHO  = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

const CHO_MAP: Record<string,number>  = Object.fromEntries(CHO.map((c,i)  => [c, i]));
const JUNG_MAP: Record<string,number> = Object.fromEntries(JUNG.map((v,i) => [v, i]));
const JONG_MAP: Record<string,number> = Object.fromEntries(
  JONG.map((c,i) => [c, i]).filter(([c]) => c !== '')
) as Record<string,number>;

// jong index → cho index (for single-consonant jong that becomes next syllable's cho)
const JONG_TO_CHO: Record<number,number> = {
  1:0, 2:1, 4:2, 7:3, 8:5, 16:6, 17:7, 19:9, 20:10, 21:11, 22:12, 23:14, 24:15, 25:16, 26:17, 27:18,
};

// compound jong: pair of jamo → jong index
const COMP_JONG: Record<string,number> = {
  'ㄱㅅ':3, 'ㄴㅈ':5, 'ㄴㅎ':6,
  'ㄹㄱ':9, 'ㄹㅁ':10,'ㄹㅂ':11,'ㄹㅅ':12,'ㄹㅌ':13,'ㄹㅍ':14,'ㄹㅎ':15,
  'ㅂㅅ':18,
};

// compound jong split when followed by vowel: jong idx → [remaining jong idx, new cho idx]
const SPLIT_JONG: Record<number,[number,number]> = {
  3:[1,9], 5:[4,12], 6:[4,18],
  9:[8,0], 10:[8,6], 11:[8,7], 12:[8,9], 13:[8,16], 14:[8,17], 15:[8,18],
  18:[17,9],
};

// compound vowel: pair of jamo → jung index
const COMP_JUNG: Record<string,number> = {
  'ㅗㅏ':9,'ㅗㅐ':10,'ㅗㅣ':11,'ㅜㅓ':14,'ㅜㅔ':15,'ㅜㅣ':16,'ㅡㅣ':19,
};
// compound vowel decompose: jung idx → simple jung idx (first part)
const DECOMP_JUNG: Record<number,number> = {9:8,10:8,11:8,14:13,15:13,16:13,19:18};

function syllable(cho: number, jung: number, jong: number): string {
  return String.fromCodePoint(0xAC00 + cho * 21 * 28 + jung * 28 + jong);
}

export function isHangulJamo(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x3131 && cp <= 0x3163;
}

type State = { cho: number; jung: number; jong: number } | null;
// jung === -1 means consonant only (waiting for vowel)

export class HangulComposer {
  private s: State = null;

  get isComposing(): boolean { return this.s !== null; }

  get composingChar(): string {
    if (!this.s) return '';
    if (this.s.jung < 0) return CHO[this.s.cho];
    return syllable(this.s.cho, this.s.jung, this.s.jong);
  }

  // Feed one character. Returns { committed, stillComposing }.
  // committed: text to insert into inputVal before cursor.
  // stillComposing: whether a composing char is now pending (use composingChar).
  feed(ch: string): { committed: string; stillComposing: boolean } {
    const choIdx  = CHO_MAP[ch];
    const jungIdx = JUNG_MAP[ch];

    if (choIdx === undefined && jungIdx === undefined) {
      // Non-jamo: commit any in-progress syllable + pass through
      return { committed: this.flush() + ch, stillComposing: false };
    }

    const s = this.s;

    // ── Vowel ──────────────────────────────────────────────────────────────
    if (jungIdx !== undefined) {
      if (!s) {
        // bare vowel → silent initial ㅇ
        this.s = { cho: 11, jung: jungIdx, jong: 0 };
        return { committed: '', stillComposing: true };
      }
      if (s.jung < 0) {
        // consonant only → combine
        this.s = { cho: s.cho, jung: jungIdx, jong: 0 };
        return { committed: '', stillComposing: true };
      }
      if (s.jong === 0) {
        // cho+jung, try compound vowel
        const compound = COMP_JUNG[JUNG[s.jung] + ch];
        if (compound !== undefined) {
          this.s = { cho: s.cho, jung: compound, jong: 0 };
          return { committed: '', stillComposing: true };
        }
        // commit current, start new
        const committed = syllable(s.cho, s.jung, 0);
        this.s = { cho: 11, jung: jungIdx, jong: 0 };
        return { committed, stillComposing: true };
      }
      // cho+jung+jong + vowel → jong splits
      const split = SPLIT_JONG[s.jong];
      const [remJong, newCho] = split ?? [0, JONG_TO_CHO[s.jong] ?? 11];
      const committed = syllable(s.cho, s.jung, remJong);
      this.s = { cho: newCho, jung: jungIdx, jong: 0 };
      return { committed, stillComposing: true };
    }

    // ── Consonant ──────────────────────────────────────────────────────────
    if (!s) {
      this.s = { cho: choIdx, jung: -1, jong: 0 };
      return { committed: '', stillComposing: true };
    }
    if (s.jung < 0) {
      // already have a lone consonant → commit it, start new
      const committed = CHO[s.cho];
      this.s = { cho: choIdx, jung: -1, jong: 0 };
      return { committed, stillComposing: true };
    }
    if (s.jong === 0) {
      // try this consonant as jong
      const jongIdx = JONG_MAP[ch] ?? -1;
      if (jongIdx > 0) {
        this.s = { cho: s.cho, jung: s.jung, jong: jongIdx };
        return { committed: '', stillComposing: true };
      }
      // can't be jong → commit, start new
      const committed = syllable(s.cho, s.jung, 0);
      this.s = { cho: choIdx, jung: -1, jong: 0 };
      return { committed, stillComposing: true };
    }
    // try compound jong
    const compound = COMP_JONG[JONG[s.jong] + ch];
    if (compound !== undefined) {
      this.s = { cho: s.cho, jung: s.jung, jong: compound };
      return { committed: '', stillComposing: true };
    }
    // commit current, start new
    const committed = syllable(s.cho, s.jung, s.jong);
    this.s = { cho: choIdx, jung: -1, jong: 0 };
    return { committed, stillComposing: true };
  }

  // Un-compose one step. Returns whether something was un-composed.
  backspace(): boolean {
    if (!this.s) return false;
    const s = this.s;
    if (s.jong > 0) {
      const split = SPLIT_JONG[s.jong];
      this.s = { cho: s.cho, jung: s.jung, jong: split ? split[0] : 0 };
      return true;
    }
    if (s.jung >= 0) {
      const decomp = DECOMP_JUNG[s.jung];
      if (decomp !== undefined) {
        this.s = { cho: s.cho, jung: decomp, jong: 0 };
      } else {
        this.s = { cho: s.cho, jung: -1, jong: 0 };
      }
      return true;
    }
    // lone consonant → remove entirely
    this.s = null;
    return true;
  }

  flush(): string {
    if (!this.s) return '';
    const s = this.s;
    this.s = null;
    if (s.jung < 0) return CHO[s.cho];
    return syllable(s.cho, s.jung, s.jong);
  }

  reset(): void { this.s = null; }
}
