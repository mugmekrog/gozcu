/* The wording of the mobile push the operator's phone receives on an ALERT. */

const BACK = new Set(['a', 'ı', 'o', 'u']);
const VOWELS = new Set(['a', 'e', 'ı', 'i', 'o', 'ö', 'u', 'ü']);

/**
 * A zone name in the dative, with the apostrophe proper nouns take:
 * "Kuzey Yolu" -> "Kuzey Yolu'na", "Bati Yerlesimi" -> "Bati Yerlesimi'ne".
 *
 * The shipped names are ASCII ("Kavsagi" for "Kavşağı"), so a final `i` cannot
 * say whether it was `ı` or `i`. Vowel harmony can: the suffix follows the last
 * vowel of the word that is not an `i`, which is what the dotless original
 * would have agreed with. Every zone name ends in a possessive, so a final
 * vowel takes the buffer `n` ("Yolu'na"), not `y`.
 */
export function zoneDative(name: string): string {
  const word = (name.trim().split(/\s+/).pop() ?? '').toLocaleLowerCase('tr-TR');
  const vowels = [...word].filter((ch) => VOWELS.has(ch));
  const last = vowels[vowels.length - 1];
  const decider = [...vowels].reverse().find((v) => v !== 'i') ?? last;
  const a = decider && BACK.has(decider) ? 'a' : 'e';
  const endsInVowel = VOWELS.has(word[word.length - 1] ?? '');
  return `${name.trim()}'${endsInVowel ? 'n' : ''}${a}`;
}

/** The push body: which zone the suspect vehicle is closing on. */
export function alertMessage(zoneName: string | null): string {
  const target = zoneName ? zoneDative(zoneName) : 'Üsse';
  return `${target} yaklaşan şüpheli bir araç tespit edildi!`;
}
