// Hebrew official street name -> a readable Latin (English) name, for streets OpenStreetMap has no
// `name:en` for. English-speaking customers see these names in the street picker and search them
// in Latin letters ("herzl", "jabot"), so conventional Israeli-English spellings beat linguistic
// purity. A module of its own because two scripts use it: the one that fills `nameEn` in
// packages/shared/data/streets.json, and geocode-streets.ts for streets added or renamed later.
//
// Unpointed Hebrew is ambiguous: "ספר" can be sefer, sapar or sfar, and the vowels are simply not
// written. No rule can recover them, so the quality is carried by the dictionaries below (every
// word of the official Beit Shemesh list is in WORDS). The letter-by-letter fallback only
// guarantees that a new, unknown word still gets a non-empty, readable, deterministic spelling;
// a street whose fallback reads badly gets a dictionary line.

/** Every geresh as names write it: ASCII ' and `, Hebrew ׳, typographic ‘ ’. */
const GERESH = /['`׳‘’]/gu;

/** Every gershayim as names write it: ASCII ", Hebrew ״, typographic “ ”, and a doubled geresh. */
const GERSHAYIM = /["״“”]|''/gu;

/** Hyphen and the Hebrew maqaf (־): both join two words into one, as in "אל-על". */
const HYPHEN = /[-־]/u;

/** A whole word of digits ("38", "160"): kept as it is. */
const DIGITS = /^\d+$/u;

/** Whole official names whose word-by-word spelling is wrong; checked before anything else. */
const WHOLE_NAMES: ReadonlyMap<string, string> = new Map([
  // אבן here is "son of" (Ibn), not "stone" (Even).
  ['אבן גבירול', 'Ibn Gabirol'],
]);

/**
 * Abbreviated first words of the official list and their spelled-out English. The key is the
 * abbreviation without its geresh; it matches only as the whole first word of a name of two or
 * more words, with or without a geresh (`שד`, `שד'`), as in geocode-streets.ts's
 * LEADING_ABBREVIATIONS. "ש" alone is the official list's short form of שיכון (housing estate).
 */
const LEADING_ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ['סמ', 'Simtat'],
  ['שד', 'Sderot'],
  ['ש', 'Shikun'],
  ['שכ', 'Shkhunat'],
]);

/**
 * Whole-word dictionary: Hebrew word as the official list writes it -> its English spelling.
 *
 * Words with the definite article ה are stored WITHOUT it ("גפן", not "הגפן"): the article is
 * added as "Ha" + the word (HaGefen) by transliterateWord, so one line serves both. A word that
 * starts with ה but is not the article (הרצל, הלל, הושע, הרטוב) is stored whole, and a whole-word
 * match always wins over the article rule. Acronyms are keyed with their gershayim (`רמב"ם`), and
 * a geresh word with its geresh (`ז'בוטינסקי`); lookup also matches any other spelling of the
 * marks, or none (see lookupWord).
 */
const WORDS: Readonly<Record<string, string>> = {
  // --- Street-type and common words ---
  אזור: 'Ezor',
  באר: "Be'er",
  בית: 'Beit',
  בן: 'Ben',
  בני: 'Bnei',
  בר: 'Bar',
  גבעת: 'Givat',
  גני: 'Ganei',
  דרך: 'Derekh',
  דרכי: 'Darkei',
  הר: 'Har',
  הרב: 'HaRav',
  הנביא: 'HaNavi',
  הנביאה: 'HaNevia',
  כביש: 'Kvish',
  ככר: 'Kikar',
  כיכר: 'Kikar',
  מעלה: "Ma'ale",
  מעלות: "Ma'alot",
  מצפה: 'Mitzpe',
  מר: 'Mar',
  מרכז: 'Merkaz',
  משעול: 'Mishol',
  נהר: 'Nahar',
  נוה: 'Neve',
  נווה: 'Neve',
  נחל: 'Nahal',
  נתיב: 'Netiv',
  קרית: 'Kiryat',
  קריית: 'Kiryat',
  רב: 'Rav',
  רבי: 'Rabbi',
  רבן: 'Rabban',
  רבנו: 'Rabbenu',
  רחוב: 'Rechov',
  רמת: 'Ramat',
  שביל: 'Shvil',
  שדרות: 'Sderot',
  שיכון: 'Shikun',
  שכונת: 'Shkhunat',
  סמטת: 'Simtat',
  // A single letter as a section mark: "רמת בית שמש ב" is Ramat Beit Shemesh B.
  א: 'A',
  ב: 'B',
  ג: 'G',
  ד: 'D',

  // --- Acronyms (gershayim) ---
  'אדמו"ר': 'Admor',
  'אדר"ת': 'Aderet',
  'אצ"ל': 'Etzel',
  'הל"ה': 'HaLamed He',
  'ויצ"ו': 'WIZO',
  'חיד"א': 'Chida',
  'לח"י': 'Lehi',
  'מהרי"ל': 'Maharil',
  'נצי"ב': 'Netziv',
  'ריב"ל': 'Rival',
  'רמ"א': 'Rema',
  'רמב"ם': 'Rambam',
  'רש"י': 'Rashi',
  'רש"פ': 'Rashap',
  'רש"ר': 'Rashar',
  'רשב"ג': 'Rashbag',
  'רשב"י': 'Rashbi',
  'שז"ר': 'Shazar',

  // --- Frequent names and surnames ---
  ביאליק: 'Bialik',
  הרצל: 'Herzl',
  הרצוג: 'Herzog',
  הירש: 'Hirsch',
  "ז'בוטינסקי": 'Jabotinsky',
  ארלוזורוב: 'Arlozorov',
  טרומפלדור: 'Trumpeldor',
  גוריון: 'Gurion',
  ויצמן: 'Weizmann',
  שרת: 'Sharett',
  אשכול: 'Eshkol',
  רבין: 'Rabin',
  פרס: 'Peres',
  אהרונסון: 'Aaronsohn',
  איידלשטיין: 'Edelstein',
  אלבז: 'Elbaz',
  אלברט: 'Albert',
  אליכין: 'Elikhin',
  אלישיב: 'Elyashiv',
  אלנקוה: 'Alnakawa',
  אלעזרי: 'Elazari',
  ארנס: 'Arens',
  בוסקילה: 'Buskila',
  בנאי: 'Banai',
  ברוק: 'Bruk',
  גונן: 'Gonen',
  גרוסמן: 'Grossman',
  גריינימן: 'Greineman',
  דורי: 'Dori',
  דיסקין: 'Diskin',
  זולוטוב: 'Zolotov',
  חגואל: 'Hagoel',
  ידין: 'Yadin',
  כדורי: 'Kaduri',
  לויטס: 'Levitas',
  לוין: 'Levin',
  לורניץ: 'Lorincz',
  ליפקוביץ: 'Lefkowitz',
  לסקוב: 'Laskov',
  מנדלר: 'Mandler',
  מנור: 'Manor',
  מקלף: 'Maklef',
  נוימן: 'Neumann',
  סנש: 'Senesh',
  ספקטור: 'Spektor',
  עזרן: 'Ezran',
  פרוש: 'Porush',
  פרנק: 'Frank',
  פרנקל: 'Frankel',
  קארו: 'Karo',
  קוק: 'Kook',
  קליין: 'Klein',
  רביצקי: 'Ravitzky',
  רייך: 'Reich',
  שמי: 'Shami',
  שמר: 'Shemer',
  שפירא: 'Shapira',
  תדהר: 'Tidhar',

  // --- First names, biblical and talmudic figures ---
  אבא: 'Abba',
  אבדימי: 'Avdimi',
  אבהו: 'Abahu',
  אביי: 'Abaye',
  אברהם: 'Avraham',
  אדם: 'Adam',
  אהוד: 'Ehud',
  אהרון: 'Aharon',
  אהרן: 'Aharon',
  אחיה: 'Achiya',
  אחיעזר: 'Achiezer',
  אילן: 'Ilan',
  אילפא: 'Ilfa',
  אליהו: 'Eliyahu',
  אלימלך: 'Elimelech',
  אליעזר: 'Eliezer',
  אלישע: 'Elisha',
  אלכסנדר: 'Alexander',
  אלעזר: 'Elazar',
  אמי: 'Ami',
  אמימר: 'Amemar',
  אמיתי: 'Amitai',
  אסתר: 'Esther',
  אריה: 'Arye',
  אשי: 'Ashi',
  אשר: 'Asher',
  בנימין: 'Binyamin',
  ברכיה: 'Berechya',
  גד: 'Gad',
  גרא: 'Gera',
  דבורה: 'Devora',
  דוד: 'David',
  דן: 'Dan',
  דניאל: 'Daniel',
  הושע: 'Hoshea',
  הלל: 'Hillel',
  המנונא: 'Hamnuna',
  זאב: 'Zeev',
  זביד: 'Zevid',
  זוטרא: 'Zutra',
  זירא: 'Zeira',
  זכאי: 'Zakai',
  זכריה: 'Zecharya',
  זלמן: 'Zalman',
  זעירי: 'Zeiri',
  חביבה: 'Haviva',
  חבקוק: 'Havakuk',
  חגי: 'Haggai',
  חולדה: 'Hulda',
  חזקיה: 'Chizkiya',
  חייא: 'Chiya',
  חיים: 'Chaim',
  חלבו: 'Chelbo',
  חלקיה: 'Chilkiya',
  חנינא: 'Chanina',
  חנן: 'Chanan',
  חננאל: 'Chananel',
  חסדא: 'Chisda',
  טובי: 'Tuvi',
  טרפון: 'Tarfon',
  יאיר: 'Yair',
  יגאל: 'Yigal',
  יהודה: 'Yehuda',
  יהודית: 'Yehudit',
  יהושע: 'Yehoshua',
  יואל: 'Yoel',
  יוחנן: 'Yochanan',
  יוכבד: 'Yocheved',
  יונה: 'Yona',
  יונתן: 'Yonatan',
  יוסי: 'Yossi',
  יוסף: 'Yosef',
  יחזקאל: 'Yechezkel',
  ייבא: 'Yeiva',
  ינאי: 'Yannai',
  ינוקא: 'Yenuka',
  יעקב: 'Yaakov',
  יצחק: 'Yitzhak',
  יקותיאל: 'Yekutiel',
  ירמיהו: 'Yirmiyahu',
  ישמעאל: 'Yishmael',
  ישעיהו: 'Yeshayahu',
  ישראל: 'Yisrael',
  כהנא: 'Kahana',
  לוי: 'Levi',
  לקיש: 'Lakish',
  מאיר: 'Meir',
  מהללאל: 'Mahalalel',
  מיכה: 'Micha',
  מלאכי: 'Malachi',
  מנוח: 'Manoach',
  מנחם: 'Menachem',
  מנשיא: 'Menashya',
  מרדכי: 'Mordechai',
  מרי: 'Mari',
  מרים: 'Miriam',
  משה: 'Moshe',
  משרשיא: 'Mesharshiya',
  נועם: 'Noam',
  נחום: 'Nachum',
  נחמיה: 'Nechemya',
  נחשון: 'Nachshon',
  ניסים: 'Nissim',
  נעמי: 'Naomi',
  נפחא: 'Nafcha',
  נפתלי: 'Naftali',
  נריה: 'Neriya',
  נתן: 'Natan',
  עובדיה: 'Ovadia',
  עוזיאל: 'Uziel',
  עולא: 'Ula',
  עוקבא: 'Ukva',
  עזאי: 'Azai',
  עזרא: 'Ezra',
  עידו: 'Ido',
  עמוס: 'Amos',
  עמרם: 'Amram',
  עקביא: 'Akavya',
  עקיבא: 'Akiva',
  פולה: 'Paula',
  פנחס: 'Pinchas',
  פפא: 'Pappa',
  פרדא: 'Parda',
  צבי: 'Tzvi',
  צדוק: 'Tzadok',
  צדקה: 'Tzedaka',
  צמח: 'Tzemach',
  צפניה: 'Tzefanya',
  קיסמא: 'Kisma',
  קלמן: 'Kalman',
  קפרא: 'Kappara',
  ראובן: 'Reuven',
  רבא: 'Rava',
  רבינא: 'Ravina',
  רועי: 'Roi',
  רות: 'Rut',
  רזיאל: 'Raziel',
  רחל: 'Rachel',
  ריש: 'Reish',
  רפאל: 'Refael',
  שאול: 'Shaul',
  שילא: 'Shila',
  שלמה: 'Shlomo',
  שמואל: 'Shmuel',
  שמחה: 'Simcha',
  שמעון: 'Shimon',
  שמשון: 'Shimshon',
  ששת: 'Sheshet',
  תנחומא: 'Tanchuma',

  // --- Places, regions, rivers and mountains ---
  אוריה: 'Uriya',
  איילון: 'Ayalon',
  אכזיב: 'Achziv',
  ארבל: 'Arbel',
  בבלי: 'Bavli',
  בשור: 'Besor',
  בשן: 'Bashan',
  "ג'מאל": 'Jamal',
  גבנונים: 'Gavnunim',
  גולן: 'Golan',
  גיחון: 'Gichon',
  גילה: 'Gila',
  גלעד: 'Gilad',
  גליל: 'Galil',
  גדי: 'Gedi',
  הרטוב: 'Hartuv',
  "וירג'יניה": 'Virginia',
  זויתן: 'Zavitan',
  חברון: 'Hevron',
  חרמון: 'Hermon',
  טבריה: 'Tveria',
  יבנה: 'Yavne',
  ירדן: 'Yarden',
  ירושלים: 'Yerushalayim',
  ירושלמי: 'Yerushalmi',
  ירקון: 'Yarkon',
  כרמל: 'Carmel',
  לוז: 'Luz',
  לכיש: 'Lachish',
  מבעלזא: 'MiBelz',
  מבריסק: 'MiBrisk',
  מוילנא: 'MiVilna',
  מוריה: 'Moriya',
  מירון: 'Meron',
  מלובלין: 'MiLublin',
  ממעזריטש: 'MiMezritch',
  "מרוז'ין": 'MiRuzhin',
  משטפנשט: 'MiShtefanesht',
  מצדה: 'Masada',
  נבו: 'Nevo',
  נהרדעא: 'Nehardea',
  סורא: 'Sura',
  סיני: 'Sinai',
  עין: 'Ein',
  פולג: 'Poleg',
  פומפדיתא: 'Pumbedita',
  פרת: 'Prat',
  צאלים: "Tze'elim",
  צפון: 'Tzafon',
  צפת: 'Tzfat',
  קדרון: 'Kidron',
  קטלב: 'Katlav',
  קישון: 'Kishon',
  רמות: 'Ramot',
  רפאים: 'Refaim',
  שורק: 'Sorek',
  שמש: 'Shemesh',
  שניר: 'Snir',
  תבור: 'Tavor',
  תמנע: 'Timna',
  אל: 'El',
  על: 'Al',

  // --- Plants, animals, stones and other nouns ---
  אביב: 'Aviv',
  אביטל: 'Avital',
  אגוז: 'Egoz',
  אגס: 'Agas',
  אדומים: 'Adumim',
  אדרת: 'Aderet',
  אהבת: 'Ahavat',
  אודם: 'Odem',
  אוהל: 'Ohel',
  אולפן: 'Ulpan',
  אומן: 'Oman',
  אור: 'Or',
  אורטל: 'Ortal',
  אורן: 'Oren',
  אחים: 'Achim',
  איריס: 'Iris',
  איש: 'Ish',
  אלה: 'Ela',
  אלון: 'Alon',
  אמוראים: 'Amoraim',
  אמרי: 'Imrei',
  אמת: 'Emet',
  אפרסק: 'Afarsek',
  ארבע: 'Arba',
  ארז: 'Erez',
  ארזים: 'Arazim',
  אשל: 'Eshel',
  אתרוג: 'Etrog',
  בזלת: 'Bazelet',
  ביחר: 'Bichar',
  בעל: 'Baal',
  ברוש: 'Brosh',
  ברכת: 'Birkat',
  גאון: 'Gaon',
  גבירול: 'Gabirol',
  גור: 'Gur',
  גטאות: 'Getaot',
  גפן: 'Gefen',
  גרניט: 'Granit',
  דובדבן: 'Duvdevan',
  דובר: 'Dover',
  דולב: 'Dolev',
  דלומיט: 'Dolomit',
  דליה: 'Dalia',
  דם: 'Dam',
  דקל: 'Dekel',
  דת: 'Dat',
  הדר: 'Hadar',
  הדס: 'Hadas',
  הכשרה: 'Hachshara',
  ורד: 'Vered',
  ותיקה: 'Vatika',
  ותיקים: 'Vatikim',
  זוהר: 'Zohar',
  זיתים: 'Zeitim',
  זכרון: 'Zichron',
  חבצלת: 'Chavatzelet',
  חבר: 'Hever',
  חוזה: 'Chozeh',
  חושן: 'Choshen',
  חזון: 'Chazon',
  חי: 'Chai',
  חינוך: 'Chinuch',
  חלוץ: 'Chalutz',
  חלוצים: 'Chalutzim',
  חלקת: 'Chelkat',
  חפץ: 'Chafetz',
  חצב: 'Chatzav',
  חצרות: 'Chatzrot',
  חרובים: 'Charuvim',
  חרוצים: 'Charutzim',
  חרצית: 'Chartzit',
  חרש: 'Charash',
  טוב: 'Tov',
  טופז: 'Topaz',
  טורקיז: 'Turkiz',
  יהלום: 'Yahalom',
  יסוד: 'Yesod',
  יסמין: 'Yasmin',
  יעלה: 'Yaala',
  יצירה: 'Yetzira',
  כלנית: 'Kalanit',
  לב: 'Lev',
  לנר: 'LeNer',
  מאור: 'Maor',
  מגיד: 'Maggid',
  מגן: 'Magen',
  מורדי: 'Mordei',
  מורה: 'Moreh',
  מורי: 'Mori',
  מחזיקי: 'Machzikei',
  מחסיה: 'Machseya',
  מטע: 'Mata',
  מיטל: 'Meital',
  מכבי: 'Maccabi',
  מכבים: 'Maccabim',
  מכתש: 'Machtesh',
  מלאכה: 'Melacha',
  מלך: 'Melech',
  מנחת: 'Minchat',
  מסגר: 'Masger',
  מעפילי: "Ma'apilei",
  מעפילים: "Ma'apilim",
  מערבא: "Ma'arava",
  מערבי: "Ma'aravi",
  מעשי: "Ma'asei",
  משוררת: 'Meshoreret',
  משטרה: 'Mishtara',
  משטרת: 'Mishteret',
  משיח: 'Mashiach',
  משלט: 'Mishlat',
  משמר: 'Mishmar',
  משק: 'Meshek',
  מתמיד: 'Matmid',
  נובע: "Nove'a",
  נוער: "No'ar",
  נופי: 'Nofei',
  נורית: 'Nurit',
  נחש: 'Nachash',
  ניצנים: 'Nitzanim',
  נס: 'Nes',
  נעמת: "Na'amat",
  נרקיס: 'Narkis',
  נשיא: 'Nasi',
  סבא: 'Saba',
  סביון: 'Savyon',
  סוללה: 'Solela',
  סולם: 'Sulam',
  סחלב: 'Sachlav',
  סיגלית: 'Sigalit',
  סיירים: 'Sayarim',
  סיתוונית: 'Sitvanit',
  סלע: 'Sela',
  סמדר: 'Smadar',
  סנסן: 'Sansan',
  ספיר: 'Sapir',
  עזר: 'Ezer',
  עליה: 'Aliya',
  עלית: 'Aliyat',
  עמל: 'Amal',
  עמק: 'Emek',
  ערבה: 'Arava',
  ערבי: 'Arvei',
  ערוגות: 'Arugot',
  ערמון: 'Armon',
  פסגות: 'Pisgot',
  פעמי: "Pa'amei",
  צאלה: "Tze'ela",
  צבע: 'Tzeva',
  צדיק: 'Tzadik',
  צופים: 'Tzofim',
  ציון: 'Tzion',
  ציפורן: 'Tziporen',
  צריפים: 'Tzrifim',
  קדושת: 'Kedushat',
  קהילת: 'Kehilat',
  "קוטג'": 'Cottage',
  קליטה: 'Klita',
  קריסטל: 'Kristal',
  קרן: 'Keren',
  רביבים: 'Revivim',
  רויטל: 'Revital',
  רימון: 'Rimon',
  רכבת: 'Rakevet',
  רקפת: 'Rakefet',
  שבע: 'Sheva',
  שבעה: 'Shiva',
  שדה: 'Sade',
  שועלי: 'Shualei',
  שושן: 'Shoshan',
  שחם: 'Shacham',
  שחר: 'Shachar',
  שיזף: 'Shizaf',
  שיטה: 'Shita',
  שילוני: 'Shiloni',
  שלום: 'Shalom',
  שלושה: 'Shlosha',
  שם: 'Shem',
  שמח: 'Sameach',
  שמיים: 'Shamayim',
  שער: "Sha'ar",
  שפת: 'Sfat',
  שקד: 'Shaked',
  שקמה: 'Shikma',
  תאנה: "Te'ena",
  תאשור: "Te'ashur",
  תחנת: 'Tachanat',
  תכלת: 'Techelet',
  תלמוד: 'Talmud',
  תמר: 'Tamar',
  תמרים: 'Tmarim',
  תנאים: 'Tanaim',
  תניא: 'Tanya',
  תעשיה: "Ta'asiya",
  תעשייה: "Ta'asiya",
  תפארת: 'Tiferet',
  תפוח: 'Tapuach',
};

/** `text` with every geresh and gershayim spelling turned into ASCII ' and ". */
function normalizeMarks(text: string): string {
  // Gershayim first: a doubled geresh ('') is one gershayim, not two gereshes.
  return text.replace(GERSHAYIM, '"').replace(GERESH, "'");
}

/** `text` with every geresh and gershayim removed (after normalizeMarks). */
function withoutMarks(text: string): string {
  return text.replace(/['"]/gu, '');
}

/** WORDS keyed by the word without marks, so `רמב״ם`, `רמב"ם` and `רמבם` all find one entry. */
const WORDS_WITHOUT_MARKS: ReadonlyMap<string, string> = new Map(
  Object.entries(WORDS).map(([hebrew, english]) => [withoutMarks(normalizeMarks(hebrew)), english]),
);

/** The dictionary spelling of `word` (marks normalized), or undefined if no entry has it. */
function lookupWord(word: string): string | undefined {
  return Object.hasOwn(WORDS, word) ? WORDS[word] : WORDS_WITHOUT_MARKS.get(withoutMarks(word));
}

/** `word` with its first letter upper-cased and the rest as it is (HaNavi, WIZO stay as they are). */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Consonants of the fallback; the letters it treats as vowels or by position are not here. */
const CONSONANTS: ReadonlyMap<string, string> = new Map([
  ['ג', 'g'],
  ['ד', 'd'],
  ['ז', 'z'],
  ['ח', 'ch'],
  ['ט', 't'],
  ['ך', 'kh'],
  ['ל', 'l'],
  ['מ', 'm'],
  ['ם', 'm'],
  ['נ', 'n'],
  ['ן', 'n'],
  ['ס', 's'],
  ['ף', 'f'],
  ['צ', 'tz'],
  ['ץ', 'tz'],
  ['ק', 'k'],
  ['ר', 'r'],
  ['ש', 'sh'],
  ['ת', 't'],
]);

/** Letters whose sound differs at the start of a word (dagesh, unwritten): b/v, k/kh, p/f. */
const SOFTENING_LETTERS: ReadonlyMap<string, { initial: string; inside: string }> = new Map([
  ['ב', { initial: 'b', inside: 'v' }],
  ['כ', { initial: 'k', inside: 'kh' }],
  ['פ', { initial: 'p', inside: 'f' }],
]);

/** Letters a geresh turns into another sound: ג' (Jabotinsky), ז' (Zhukov), צ' (Churchill). */
const GERESH_LETTERS: ReadonlyMap<string, string> = new Map([
  ['ג', 'j'],
  ['ז', 'zh'],
  ['צ', 'ch'],
  ['ץ', 'ch'],
]);

/** Silent letters that carry a vowel: they read as "a" unless ו or י after them gives the vowel. */
const VOWEL_CARRIERS: ReadonlySet<string> = new Set(['א', 'ע']);

/**
 * Letter-by-letter spelling of one word no dictionary has, in lower case. Deterministic and
 * never empty for a word with at least one Hebrew letter, Latin letter or digit; it does not try
 * to be right, only readable (unpointed Hebrew does not say which vowels to read):
 * - ב/כ/פ are b/k/p at the start of the word and v/kh/f inside it; ג' ז' צ' are j, zh, ch, and
 *   any other geresh or gershayim is dropped;
 * - א and ע read as "a", unless ו or י right after them gives the vowel;
 * - ו and י are consonants (v, y) at the start of the word, doubled (וו, יי) or after a vowel,
 *   and vowels (o, i) after a consonant; a final ה after a consonant reads as "a";
 * - between two consonants with no vowel letter, an "a" is inserted (סמדר -> samadar);
 * - Latin letters and digits are kept; anything else is dropped.
 */
function fallbackSpelling(word: string): string {
  const letters = Array.from(word);
  let spelling = '';
  // What the spelling so far ends with. `carrier`: a silent א/ע whose vowel the ו/י after it
  // gives (אור -> or). No vowel is inserted before the first consonant (`start`).
  // `as`, not an annotation: the helpers below change it, which TypeScript's narrowing of the
  // initial value would not see.
  let previous = 'start' as 'start' | 'consonant' | 'vowel' | 'carrier';

  const addConsonant = (sound: string): void => {
    if (previous === 'consonant') spelling += 'a';
    spelling += sound;
    previous = 'consonant';
  };
  const addVowel = (sound: string): void => {
    spelling += sound;
    previous = 'vowel';
  };

  for (let index = 0; index < letters.length; index += 1) {
    const letter = letters[index] ?? '';
    const next = letters[index + 1];
    const isWordStart = index === 0;

    if (next === "'" && GERESH_LETTERS.has(letter)) {
      addConsonant(GERESH_LETTERS.get(letter) ?? '');
      index += 1; // the geresh is consumed with its letter
    } else if (/[A-Za-z0-9]/u.test(letter)) {
      spelling += letter;
      previous = 'vowel'; // no vowel is inserted next to Latin letters or digits
    } else if (VOWEL_CARRIERS.has(letter)) {
      if (next === 'ו' || next === 'י') previous = 'carrier';
      else addVowel('a');
    } else if (letter === 'ו' || letter === 'י') {
      if (next === letter) {
        addConsonant(letter === 'ו' ? 'v' : 'y');
        index += 1; // וו / יי: one consonant
      } else if (isWordStart || previous === 'vowel') {
        addConsonant(letter === 'ו' ? 'v' : 'y');
      } else {
        addVowel(letter === 'ו' ? 'o' : 'i');
      }
    } else if (letter === 'ה') {
      // A final ה is a vowel ending (שקמה); after a vowel it adds nothing.
      if (next !== undefined || isWordStart) addConsonant('h');
      else if (previous === 'consonant') addVowel('a');
    } else if (SOFTENING_LETTERS.has(letter)) {
      const sounds = SOFTENING_LETTERS.get(letter);
      addConsonant((isWordStart ? sounds?.initial : sounds?.inside) ?? '');
    } else if (CONSONANTS.has(letter)) {
      addConsonant(CONSONANTS.get(letter) ?? '');
    }
    // Anything else (marks, punctuation, vowel points) is dropped.
  }
  return spelling;
}

/** The Hebrew definite article: one ה at the start of a word. */
const ARTICLE = 'ה';

/**
 * Minimum length (in letters, marks not counted) of what follows a leading ה for a word no
 * dictionary has to be read as "Ha" + word. Shorter words starting with ה (הר, הלל, הבל) are far
 * more often a word of their own than the article plus a two-letter word.
 */
const MIN_ARTICLE_REST_LETTERS = 3;

/**
 * English spelling of one word (no spaces, no hyphens), marks already normalized; '' for a word
 * with nothing to spell. In order:
 * 1. a whole-word dictionary entry (WORDS), also matching another spelling of the marks;
 * 2. the article: ה + a word in WORDS is "Ha" + that word (הגפן -> HaGefen, האצ"ל -> HaEtzel);
 * 3. the article for an unknown word: ה + at least MIN_ARTICLE_REST_LETTERS letters is "Ha" +
 *    the fallback spelling of the rest (הדרור -> HaDaror);
 * 4. the letter-by-letter fallback for the whole word (acronyms included, marks dropped).
 */
function transliterateWord(word: string): string {
  const known = lookupWord(word);
  if (known !== undefined) return known;
  if (word.startsWith(ARTICLE)) {
    const rest = word.slice(ARTICLE.length);
    const knownRest = lookupWord(rest);
    if (knownRest !== undefined) return `Ha${capitalize(knownRest)}`;
    if (Array.from(withoutMarks(rest)).length >= MIN_ARTICLE_REST_LETTERS) {
      const restSpelling = fallbackSpelling(rest);
      if (restSpelling !== '') return `Ha${capitalize(restSpelling)}`;
    }
  }
  return capitalize(fallbackSpelling(word));
}

/** One whitespace-separated word, whose hyphenated parts are spelled one by one ("El-Al"). */
function transliterateToken(token: string): string {
  return token
    .split(HYPHEN)
    .map((part) => (DIGITS.test(part) ? part : transliterateWord(part)))
    .filter((part) => part !== '')
    .join('-');
}

/**
 * English (Latin) spelling of a Hebrew official street name, for the street picker of
 * English-speaking customers when OpenStreetMap has no `name:en`.
 *
 * Pure and deterministic. Words keep their order and are title-cased; digits ("כביש 38" -> "Kvish
 * 38") and hyphens ("נחל אל-על" -> "Nahal El-Al") are kept; geresh and gershayim in any spelling
 * never reach the output. The abbreviated first words of the official list are spelled out (סמ
 * Simtat, שד Sderot, ש Shikun, שכ Shkhunat), the article ה becomes "Ha" (הנביא -> HaNavi), and
 * acronyms come from the dictionary (רמב"ם -> Rambam). A word no dictionary has gets a
 * letter-by-letter spelling, readable but not necessarily right (see the module comment).
 *
 * The result contains only `A-Z a-z 0-9`, single spaces, `'` and `-`, starts with a letter or
 * digit, and is never empty. Throws for an empty or whitespace-only name, and for a name with
 * nothing to spell (only punctuation).
 */
export function transliterateStreetName(name: string): string {
  const normalized = normalizeMarks(name.normalize('NFC')).trim().replace(/\s+/gu, ' ');
  if (normalized === '') throw new Error('cannot transliterate an empty street name');

  const wholeName = WHOLE_NAMES.get(normalized);
  if (wholeName !== undefined) return wholeName;

  const words = normalized.split(' ');
  const firstWord = words[0] ?? '';
  const abbreviation =
    words.length > 1 ? LEADING_ABBREVIATIONS.get(firstWord.replace(/'$/u, '')) : undefined;
  const spelled =
    abbreviation === undefined
      ? words.map(transliterateToken)
      : [abbreviation, ...words.slice(1).map(transliterateToken)];

  // Re-split: a dictionary value may itself be two words ("HaLamed He").
  const result = spelled
    .join(' ')
    .split(' ')
    .map((word) => word.replace(/[^A-Za-z0-9'-]/gu, ''))
    // Marks and hyphens never start or end a word ("'" alone, "-Al" after an empty part).
    .map((word) => word.replace(/^['-]+|['-]+$/gu, ''))
    .filter((word) => word !== '')
    .map(capitalize)
    .join(' ');
  if (result === '') throw new Error(`street name "${name}" has nothing to transliterate`);
  return result;
}
