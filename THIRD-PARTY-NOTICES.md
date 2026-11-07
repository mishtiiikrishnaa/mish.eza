# third-party notices

mish.eza embeds two small fonts, as base64 woff2, at the top of `styles.css`. both are subsets (only the glyphs the panel draws) and both are renamed. nothing else is bundled: `main.js` contains no third-party code and uses nothing but obsidian's own api and node's `os` module.

the plugin's own code is MIT (see `LICENSE`). the fonts are **not** relicensed by that: each stays under its own licence, listed below.

## cmu typewriter text → embedded as "mish mono"

- licence: SIL Open Font License, Version 1.1. full text, including the copyright block: `licenses/OFL-CMU-Typewriter.txt`
- copyright: (C) 2003-2009 Andrey V. Panov, with Reserved Font Family Name "Computer Modern Unicode fonts". based on the Computer Modern fonts by Donald E. Knuth and the other authors named in the copyright block of the licence file
- changes made: cut down to basic latin, latin-1 and a few punctuation and arrow characters (213 characters); layout features and hinting removed; converted to woff2; the family was renamed to "mish mono" so that the Reserved Font Name is not used. the copyright and licence records inside the font file were kept
- obtained from the `computer-modern` npm package, which repackages the CMU fonts
- the OFL means: the font may be bundled with software, but not sold by itself, and it stays under the OFL. the plugin's MIT licence applies to the plugin's code only

## symbols nerd font mono → embedded as "mish icons"

- source: Symbols Nerd Font Mono 3.5.1, from the Nerd Fonts project, https://github.com/ryanoasis/nerd-fonts
- licence: Nerd Fonts' licence file, which contains both its MIT and its SIL OFL 1.1 sections, is included unchanged as `licenses/NERD-FONTS-LICENSE.txt`. copyright (c) 2014 Ryan L McIntyre
- glyphs kept (six): `fa-apple` (U+F179), `fa-windows` (U+F17A), `fa-linux` (U+F17C), `oct-clock` (U+F43A), and the two heavy chevrons U+276E and U+276F
- where the icons come from: the three operating system logos are from **Font Awesome Free**, whose icons are licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); the attribution required by that licence is this paragraph. the clock is from **Octicons** (MIT, GitHub). the licences of every icon set inside Nerd Fonts are listed in the Nerd Fonts repository's licence audit
- changes made: cut down to those six characters, renamed to "mish icons", converted to woff2
- the operating system logos remain trademarks of their respective owners and are used only to show which system you are on

## adding or changing a font later

if you embed another font, add a section here, put its licence text in `licenses/`, and rename the family if its licence reserves the name.
