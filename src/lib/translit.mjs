/* Devanagari -> IAST (the Roman scheme Sanskrit classes use).

   The Roman line under each verse is GENERATED from its Devanagari, never typed,
   so the two cannot drift apart. Sanskrit rules throughout: the inherent "a" is
   kept at the end of a word (rama, not ram), which is right for Sanskrit and wrong
   for Hindi/Awadhi -- so Hindi verses (the Hanuman Chalisa) carry their own
   hand-written "tr" instead and skip this. */

const VOWEL = {
  'अ': 'a', 'आ': 'ā', 'इ': 'i', 'ई': 'ī', 'उ': 'u', 'ऊ': 'ū', 'ऋ': 'ṛ', 'ॠ': 'ṝ', 'ऌ': 'ḷ',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
};
const SIGN = {
  'ा': 'ā', 'ि': 'i', 'ी': 'ī', 'ु': 'u', 'ू': 'ū', 'ृ': 'ṛ', 'ॄ': 'ṝ', 'ॢ': 'ḷ',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
};
const CONS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ṅ',
  'च': 'c', 'छ': 'ch', 'ज': 'j', 'झ': 'jh', 'ञ': 'ñ',
  'ट': 'ṭ', 'ठ': 'ṭh', 'ड': 'ḍ', 'ढ': 'ḍh', 'ण': 'ṇ',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'ś', 'ष': 'ṣ', 'स': 's', 'ह': 'h', 'ळ': 'ḷ',
};
const VIRAMA = '्';
const NUKTA = '़';
const MARK = { 'ं': 'ṃ', 'ँ': 'ṃ', 'ः': 'ḥ', 'ऽ': '’', 'ॐ': 'oṃ', '।': '|', '॥': '||' };

export function toIAST(text) {
  const s = Array.from(String(text));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (CONS[ch]) {
      out += CONS[ch];
      let next = s[i + 1];
      if (next === NUKTA) { i++; next = s[i + 1]; }          // nukta: same letter for our purposes
      if (SIGN[next]) { out += SIGN[next]; i++; }
      else if (next === VIRAMA) { i++; }                      // no vowel: a conjunct follows
      else out += 'a';                                        // the inherent a
    } else if (VOWEL[ch]) {
      out += VOWEL[ch];
    } else if (MARK[ch]) {
      out += MARK[ch];
    } else if (ch === NUKTA || ch === VIRAMA) {
      /* stray; ignore */
    } else {
      out += ch;                                              // spaces, newlines, punctuation
    }
  }
  return out;
}

/* the characters that must be Devanagari for a line to count as Sanskrit */
export const hasDevanagari = (s) => /[ऀ-ॿ]/.test(s);
