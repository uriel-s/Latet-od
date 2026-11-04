// Tests for the Hebrew -> English street-name transliteration: one fixed example per rule, the
// fallback for unknown words, and every name of the committed official street list.
import { describe, expect, it } from 'vitest';
import streetsJson from '../packages/shared/data/streets.json' with { type: 'json' };
import { transliterateStreetName } from './transliterateStreetName.ts';

/** What every transliteration must look like: Latin letters, digits, single spaces, ' and -. */
const LATIN_NAME = /^[A-Za-z0-9][A-Za-z0-9 '-]*$/u;

describe('transliterateStreetName', () => {
  it('spells dictionary words conventionally', () => {
    expect(transliterateStreetName('הרצל')).toBe('Herzl');
    expect(transliterateStreetName('ביאליק')).toBe('Bialik');
    expect(transliterateStreetName('נחל נחשון')).toBe('Nahal Nachshon');
    expect(transliterateStreetName('נהר הירדן')).toBe('Nahar HaYarden');
    expect(transliterateStreetName('דרך רבין יצחק')).toBe('Derekh Rabin Yitzhak');
    expect(transliterateStreetName('רבן יוחנן בן זכאי')).toBe('Rabban Yochanan Ben Zakai');
    expect(transliterateStreetName('מעלה דוד')).toBe("Ma'ale David");
    expect(transliterateStreetName('קרית אריה')).toBe('Kiryat Arye');
    expect(transliterateStreetName('קריית ארבע')).toBe('Kiryat Arba');
    expect(transliterateStreetName('בית שמש')).toBe('Beit Shemesh');
  });

  it('spells a whole name from its own entry when word by word would be wrong', () => {
    expect(transliterateStreetName('אבן גבירול')).toBe('Ibn Gabirol');
  });

  it('turns the article ה into "Ha" + the capitalized word', () => {
    expect(transliterateStreetName('הנביא עמוס')).toBe('HaNavi Amos');
    expect(transliterateStreetName('האלון')).toBe('HaAlon');
    expect(transliterateStreetName('הגפן')).toBe('HaGefen');
    expect(transliterateStreetName('הרב קוק')).toBe('HaRav Kook');
  });

  it('keeps a word that only starts with ה as a word of its own', () => {
    expect(transliterateStreetName('הלל')).toBe('Hillel');
    expect(transliterateStreetName('הושע הנביא')).toBe('Hoshea HaNavi');
    expect(transliterateStreetName('משטרת הרטוב')).toBe('Mishteret Hartuv');
  });

  it('reads ה + an unknown word of three or more letters as the article', () => {
    expect(transliterateStreetName('הדרור')).toBe('HaDaror');
  });

  it('spells geresh letters ג׳ ז׳ צ׳ as J, Zh, Ch, and prefers the dictionary', () => {
    expect(transliterateStreetName("ז'בוטינסקי")).toBe('Jabotinsky');
    expect(transliterateStreetName("בית ג'מאל")).toBe('Beit Jamal');
    expect(transliterateStreetName("ג'ורג'")).toMatch(/^J[a-z]*j$/u);
    expect(transliterateStreetName("ז'קלין")).toMatch(/^Zh[a-z]+$/u);
    expect(transliterateStreetName("צ'רצ'יל")).toMatch(/^Ch[a-z]*ch[a-z]*$/u);
  });

  it('accepts every spelling of geresh and gershayim and never outputs them', () => {
    for (const name of ["ז'בוטינסקי", 'ז׳בוטינסקי', 'ז’בוטינסקי', 'ז`בוטינסקי']) {
      expect(transliterateStreetName(name)).toBe('Jabotinsky');
    }
    for (const name of ['רמב"ם', 'רמב״ם', 'רמב“ם', "רמב''ם", 'רמבם']) {
      expect(transliterateStreetName(name)).toBe('Rambam');
    }
    expect(transliterateStreetName('ה"ג"ד')).not.toMatch(/["“”״׳]/u);
  });

  it('spells known acronyms from the dictionary', () => {
    expect(transliterateStreetName('רמב"ם')).toBe('Rambam');
    expect(transliterateStreetName('רש"י')).toBe('Rashi');
    expect(transliterateStreetName('רשב"י')).toBe('Rashbi');
    expect(transliterateStreetName('חיד"א')).toBe('Chida');
    expect(transliterateStreetName('האצ"ל')).toBe('HaEtzel');
    expect(transliterateStreetName('רמת לח"י')).toBe('Ramat Lehi');
    expect(transliterateStreetName('סמ ויצ"ו')).toBe('Simtat WIZO');
    expect(transliterateStreetName('מעלות הרמ"א')).toBe("Ma'alot HaRema");
    expect(transliterateStreetName('גבעת שז"ר')).toBe('Givat Shazar');
  });

  it('spells an unknown acronym letter by letter, without the gershayim', () => {
    const spelling = transliterateStreetName('מהרש"א');
    expect(spelling).toMatch(/^[A-Z][a-z]+$/u);
    expect(spelling).toBe(transliterateStreetName('מהרש"א'));
  });

  it('spells out the abbreviated first words סמ, שד, ש and שכ', () => {
    expect(transliterateStreetName('סמ האלון')).toBe('Simtat HaAlon');
    expect(transliterateStreetName('שד בן גוריון')).toBe('Sderot Ben Gurion');
    expect(transliterateStreetName("שד' האמוראים")).toBe('Sderot HaAmoraim');
    expect(transliterateStreetName('שד׳ האמוראים')).toBe('Sderot HaAmoraim');
    expect(transliterateStreetName('ש ותיקים')).toBe('Shikun Vatikim');
    expect(transliterateStreetName('שכ הגפן')).toBe('Shkhunat HaGefen');
  });

  it('keeps digits', () => {
    expect(transliterateStreetName('כביש 38')).toBe('Kvish 38');
    expect(transliterateStreetName('ש 160')).toBe('Shikun 160');
  });

  it('keeps a hyphen between two words, also a maqaf', () => {
    expect(transliterateStreetName('נחל אל-על')).toBe('Nahal El-Al');
    expect(transliterateStreetName('נחל אל־על')).toBe('Nahal El-Al');
  });

  it('collapses extra whitespace and splits a two-word dictionary value', () => {
    expect(transliterateStreetName('  נחל   נחשון ')).toBe('Nahal Nachshon');
    expect(transliterateStreetName('שביל הל"ה')).toBe('Shvil HaLamed He');
  });

  it('gives an unknown word a deterministic, non-empty letter-by-letter spelling', () => {
    expect(transliterateStreetName('דגן')).toBe('Dagan');
    expect(transliterateStreetName('אור')).toBe('Or');
    const spelling = transliterateStreetName('פרפרים');
    expect(spelling).toMatch(/^P[a-z]+$/u);
    expect(transliterateStreetName('פרפרים')).toBe(spelling);
  });

  it('throws for an empty or whitespace-only name', () => {
    expect(() => transliterateStreetName('')).toThrow(/empty/u);
    expect(() => transliterateStreetName('   \t ')).toThrow(/empty/u);
  });

  it('throws for a name with nothing to spell', () => {
    expect(() => transliterateStreetName('" -')).toThrow(/nothing to transliterate/u);
  });

  it('gives every street of the official list a clean Latin name', () => {
    expect(streetsJson.streets).toHaveLength(461);
    for (const street of streetsJson.streets) {
      const spelling = transliterateStreetName(street.name);
      expect(spelling, street.name).toMatch(LATIN_NAME);
      expect(spelling, street.name).not.toMatch(/ {2}/u);
      expect(spelling, street.name).not.toMatch(/['-]$/u);
    }
  });
});
