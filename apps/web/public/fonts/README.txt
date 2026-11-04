Heebo, self-hosted (ADR-0011 item 3: one woff2 in the repo, no Google Fonts at runtime)
=======================================================================================

heebo-variable.woff2  Heebo, variable weight axis wght 100-900 (default 400), subset to Hebrew +
                      basic Latin. 51,452 bytes. Loaded by @font-face in apps/web/src/styles.css
                      and preloaded by apps/web/index.html.
OFL.txt               The licence: SIL Open Font License 1.1, copied unchanged from the source.
                      Copyright 2014 The Heebo Project Authors (https://github.com/OdedEzer/heebo).
                      The OFL allows subsetting and redistributing; the font keeps its own name
                      ("Heebo" is not a Reserved Font Name).

Source
------
Google Fonts repository, folder ofl/heebo (downloaded 2026-11-04):
  https://github.com/google/fonts/raw/main/ofl/heebo/Heebo%5Bwght%5D.ttf  (122,012 bytes)
  https://github.com/google/fonts/raw/main/ofl/heebo/OFL.txt
Last commit touching Heebo[wght].ttf: 804ab16a8ff8ac0072e7c5ecc34e381b4a710177 (2023-11-24).
Upstream source per METADATA.pb: github.com/OdedEzer/heebo @ 76c7d538568d3e6d7f052a12c5675c84430df25f.

Subset method (reproducible, no python, nothing added to this repo's package.json)
-------------------------------------------------------------------------------------
Tool: subset-font 2.9.0 (harfbuzzjs 1.6.4 hb-subset, wawoff2 2.0.1), installed in a throwaway
folder outside the repo (`npm init -y && npm install subset-font`). A small Node script builds a
string of every code point in the ranges below and calls

  subsetFont(ttfBuffer, text, { targetFormat: 'woff2' })

with no variationAxes option, so the wght axis is kept (fvar, gvar, HVAR, avar, STAT survive;
checked by decompressing the result and reading the fvar table: wght 100 / 400 / 900).

Unicode ranges kept:
  U+0020-007E  Basic Latin (ASCII)
  U+00A0-00FF  Latin-1 Supplement
  U+0590-05FF  Hebrew (letters, niqqud, punctuation: all 50 the font has)
  U+FB1D-FB4F  Hebrew presentation forms (all 45 the font has)
  U+200C-2010  ZWNJ, ZWJ, LRM, RLM, hyphen (bidi marks around phone numbers and digits)
  U+2013-2014  en and em dash
  U+2018-201E  quotation marks
  U+2022       bullet
  U+2026       ellipsis
  U+20AA       new shekel sign
  U+20AC       euro sign
  U+2122       trade mark sign
Result: 302 code points mapped (the full font has 463), every requested one the font has.
Other characters (latin-ext, Cyrillic, symbols) fall back to the system fonts in the stack.
