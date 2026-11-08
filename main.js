'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   mish-eza
   a starship prompt + `eza --tree --all --level=99 .` that actually IS the
   file explorer: real ├── └── │ lines, click to open/fold.
   - colours follow the prompt pills, one colour per depth
   - a little shell at the bottom (type commands, or click them) replaces
     the explorer's button pills. tab completes names.
       touch mkdir rename mv cp rm/delete sort reveal collapse expand help
     rm / delete ask y or n in the prompt itself first (no popup); rm -f skips it.
     it is not a real shell: the words are mapped onto obsidian's own vault
     api. nothing is ever sent to the operating system, and nothing is run.
   - the prompt grows a git branch when the vault is a git repository
   - names are cut off with an ellipsis (the card never resizes). hover one and it
     grows into a prompt-style colour pill with the whole name, in its depth colour.
     the reveal command (and, by default, simply opening a note or starting obsidian)
     lights up the open note with the same pill, and it stays
   - nearly everything is a setting: the six rainbow colours (with presets), pill
     shape, clock, tree colours / lines / indent / sizes, the border, card position
   - everything (prompt, tree and the shell line) sits in one bordered card,
     the same box mish.fastfetch draws: it hugs its content and centres itself
   the old explorer is only hidden; "toggle native file explorer" brings it back.
   ═══════════════════════════════════════════════════════════════════════ */

const { Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile, Menu, Keymap, Platform, setIcon } = require('obsidian');

/* node's `os` module is how the prompt finds your username.
   it only exists on desktop, which is why the manifest says isDesktopOnly. */
let nodeOs = null;
try { nodeOs = require('os'); } catch (e) { nodeOs = null; }

const PLACEHOLDER = 'type a command · help';

const pad = (n) => String(n).padStart(2, '0');

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};


/* ── the rainbow ─────────────────────────────────────────────────────────
   six colours, in this order everywhere: the prompt pills, the tree depths, the
   card border, the scrollbar and the explorer tab icon all read from them.
   a slot is a few css variables: the theme's own (vf), the fill this plugin
   ships (f: pills, border, scrollbar) and the text version (t: tree names, lines;
   darker in light mode, `dark` = how much, copied from styles.css). */
const SLOTS = [
  { name: 'pink',   vf: '--vf-pink-hi', f: '--mz-f-pink-hi', t: '--mz-pink-hi', dark: 40, used: 'user pill, first tree level, where the border starts' },
  { name: 'peach',  vf: '--vf-peach',   f: '--mz-f-peach',   t: '--mz-peach',   dark: 42, used: 'vault pill, second tree level' },
  { name: 'yellow', vf: '--vf-yellow',  f: '--mz-f-yellow',  t: '--mz-yellow',  dark: 50, used: 'git pill, third tree level, existing files in the prompt' },
  { name: 'green',  vf: '--vf-green',   f: '--mz-f-green',   t: '--mz-green',   dark: 48, used: 'commands and the prompt arrow, fourth tree level' },
  { name: 'blue',   vf: '--vf-blue',    f: '--mz-f-blue',    t: '--mz-blue',    dark: 40, used: 'existing folders in the prompt, fifth tree level' },
  { name: 'lilac',  vf: '--vf-lilac',   f: '--mz-f-lilac',   t: '--mz-lilac',   dark: 38, used: 'clock pill, sixth tree level, where the border ends' },
];

/* what the plugin draws with when "follows your theme" is picked (the sorbet palette) */
const DARK_FILLS  = ['#ffa6c9', '#ffd6a6', '#fff1a8', '#c9ffa6', '#a6c9ff', '#c9b0ff'];
const LIGHT_FILLS = ['#ff8fb8', '#ffb27a', '#ffd54f', '#8ee07f', '#82b4ff', '#b79bff'];

const PALETTES = {
  catppuccin: ['#f5c2e7', '#fab387', '#f9e2af', '#a6e3a1', '#89b4fa', '#cba6f7'],
  dracula:    ['#ff79c6', '#ffb86c', '#f1fa8c', '#50fa7b', '#8be9fd', '#bd93f9'],
  nord:       ['#bf616a', '#d08770', '#ebcb8b', '#a3be8c', '#81a1c1', '#b48ead'],
  gruvbox:    ['#fb4934', '#fe8019', '#fabd2f', '#b8bb26', '#83a598', '#d3869b'],
  ocean:      ['#c4f1f9', '#7fe0e8', '#6fd3c2', '#7bc6f0', '#82a8ff', '#a98bff'],
  sunset:     ['#ff8fa3', '#ff9e6b', '#ffc15e', '#ff7eb6', '#e08bff', '#b794ff'],
  forest:     ['#e6c9a8', '#d9b26f', '#e3e08a', '#9fd58a', '#6fc2a0', '#7fa8c9'],
  greyscale:  ['#f5f5f5', '#dcdcdc', '#c4c4c4', '#a8a8a8', '#8c8c8c', '#707070'],
};

const HEX = /^#[0-9a-f]{6}$/i;
const SHAPES = ['arrow', 'round', 'flat'];
const ACTIVES = ['outline', 'fill', 'none'];

const lightTheme = () => document.body.classList.contains('theme-light');
const themeFills = () => (lightTheme() ? LIGHT_FILLS : DARK_FILLS).slice();

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* defaults underneath, what was saved on top; nested groups merge key by key,
   so a setting added in an update never goes missing from an old data.json */
const deepMerge = (base, over) => {
  const out = Object.assign({}, base);
  if (!isPlain(over)) return out;
  for (const k of Object.keys(over)) {
    out[k] = isPlain(base[k]) && isPlain(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
};

/* ── lowercase ui ────────────────────────────────────────────────────────
   the text in the settings tab is written in lowercase, to match the terminal look.
   with the "lowercase ui" setting off, ui() shows it in sentence case instead (a capital
   at the start of each sentence, plus the few names that need one). only text that
   obsidian itself shows goes through ui(): the settings tab, its tooltips and its
   messages. the terminal panel is always lowercase. */
const uiCase = { lower: true };

const PROPER = [
  [/\bcmu typewriter\b/g, 'CMU Typewriter'],
  [/\bobsidian\b/g, 'Obsidian'],
  [/\bcss\b/g, 'CSS'],
  [/\bui\b/g, 'UI'],
  [/\bpdfs\b/g, 'PDFs'],
  [/\bmish\b(?!\.[a-z])/g, 'Mish'],      /* the palette, not mish.eza / mish.fastfetch */
  [/\bpm\b/g, 'PM'],
  [/(?<![\w./-])git\b(?!\/)/g, 'Git'],      /* not the .git folder */
];

/* commands stay lowercase even at the start of a sentence */
const KEEP_LOWER = new Set(['rm', 'eza', 'mv', 'cp', 'mkdir', 'touch']);

const sentence = (text) => {
  let out = String(text);
  for (const [re, name] of PROPER) out = out.replace(re, name);
  return out.replace(/(^|[.!?]\s+)([a-z][\w-]*)/g, (m, lead, word) => (
    KEEP_LOWER.has(word) ? m : lead + word.charAt(0).toUpperCase() + word.slice(1)
  ));
};

const ui = (text) => (uiCase.lower ? text : sentence(text));

const uiOptions = (options) => Object.fromEntries(
  Object.entries(options).map(([key, label]) => [key, ui(label)])
);

/* a Setting whose name and description go through ui() */
class UiSetting extends Setting {
  setName(name) { return super.setName(typeof name === 'string' ? ui(name) : name); }
  setDesc(desc) { return super.setDesc(typeof desc === 'string' ? ui(desc) : desc); }
}

const DEFAULT_SETTINGS = {
  lowercaseUi: true,     /* settings text in lowercase (true) or sentence case (false) */
  username: '',          /* empty = auto-detect */
  font: 'bundled',       /* bundled | obsidian | system | family:<name> | custom */
  customFont: '',
  groupDirsFirst: true,  /* like `eza --group-directories-first` */
  confirmRm: true,       /* rm / delete ask y or n in the prompt first */
  pills: { user: true, vault: true, git: true, time: true },
  show: { command: true, keys: true, reveal: true, shell: true },

  /* the rainbow: preset = theme | custom | one of PALETTES. colours are the six fills.
     `theme` is the default and is shown in the settings as "mish". */
  palette: { preset: 'theme', colours: DARK_FILLS.slice() },
  inkColour: '',         /* text on the pills. empty = automatic (dark ink) */

  /* the prompt */
  pillShape: 'arrow',    /* arrow | round | flat */
  vaultLabel: '',        /* empty = ~/<vault name> */
  clock: { hour12: false, seconds: false },

  /* the tree */
  tree: {
    nameColour: 'depth',   /* depth | type | plain */
    reverse: false,        /* flip the sort order */
    extensions: 'all',     /* all | md (hide .md) | none (hide every extension) */
    activeStyle: 'outline',/* outline | fill | none: how the open note is marked */
    autoReveal: true,      /* follow the open note: unfold, scroll, light up the pill */
    fontSize: 12,
    rowHeight: 22,
    indent: 4,             /* characters per level (eza uses 4) */
    lineStyle: 'solid',    /* solid | dashed | dotted */
    lineWidth: 1,
    lineOpacity: 55,       /* percent */
  },

  /* the card */
  card: {
    width: 'fit',          /* fit (the prompt decides) | full (the whole sidebar) */
    hAlign: 'centre',      /* centre | left */
    vAlign: 'centre',      /* centre | top */
    ring: 'rainbow',       /* rainbow | accent | subtle | none */
    ringWidth: 1,
    angle: 135,            /* degrees, for the rainbow border */
    radius: 10,
    pad: 10,
  },

  /* the hover reveal pill */
  revealPill: { always: false, delay: 140 },
};

/* a data.json from an older version, or one edited by hand, must never break the panel */
const sanitise = (cfg) => {
  const p = cfg.palette;
  if (p.preset !== 'theme' && p.preset !== 'custom' && !PALETTES[p.preset]) p.preset = 'theme';
  if (!Array.isArray(p.colours) || p.colours.length !== 6 || !p.colours.every((c) => HEX.test(c))) {
    p.colours = DARK_FILLS.slice();
  }
  cfg.lowercaseUi = cfg.lowercaseUi !== false;
  return cfg;
};

/* the six colours to draw with, or null when the theme decides */
const customColours = (cfg) => {
  const p = cfg.palette;
  return p.preset !== 'theme' && Array.isArray(p.colours) && p.colours.length === 6 && p.colours.every((c) => HEX.test(c))
    ? p.colours : null;
};

/* css variables for the colours. a custom palette sets the plugin's own fills and text
   colours, and tells the theme's --vf-* to step aside (`initial` = "not set", so the
   fallbacks win). in light mode the text colour is the fill darkened, the same way
   styles.css does it for the default palette. */
const paletteVars = (cfg) => {
  const v = {};
  const colours = customColours(cfg);
  if (colours) {
    const light = lightTheme();
    SLOTS.forEach((s, i) => {
      v[s.vf] = 'initial';
      v[s.f] = colours[i];
      v[s.t] = light ? 'color-mix(in oklab, ' + colours[i] + ', black ' + s.dark + '%)' : colours[i];
    });
  }
  if (HEX.test(cfg.inkColour)) {
    v['--vf-black'] = 'initial';
    v['--mz-ink'] = cfg.inkColour;
  }
  return v;
};

/* css variables for sizes, lines and the card. every one has the old fixed value as its
   fallback in styles.css, so the defaults look exactly as before. */
const layoutVars = (cfg) => {
  const t = cfg.tree;
  const c = cfg.card;
  const v = {
    '--ez-fs': num(t.fontSize, 9, 20, 12) + 'px',
    '--ez-row': num(t.rowHeight, 16, 40, 22) + 'px',
    '--ez-indent': num(t.indent, 3, 8, 4) + 'ch',
    '--ez-lw': num(t.lineWidth, 1, 3, 1) + 'px',
    '--ez-ls': ['solid', 'dashed', 'dotted'].includes(t.lineStyle) ? t.lineStyle : 'solid',
    '--ez-lo': String(num(t.lineOpacity, 5, 100, 55) / 100),
    '--ez-radius': num(c.radius, 0, 28, 10) + 'px',
    '--ez-pad': num(c.pad, 0, 32, 10) + 'px',
    '--ez-angle': num(c.angle, 0, 360, 135) + 'deg',
    '--ez-mt': c.vAlign === 'top' ? '0' : 'auto',
    '--ez-ml': c.hAlign === 'left' ? '0' : 'auto',
  };
  const w = num(c.ringWidth, 1, 4, 1) + 'px';
  if (c.ring === 'none') {
    v['--ez-ring-w'] = '0px';
  } else if (c.ring === 'accent') {
    v['--ez-ring-w'] = w;
    v['--ez-ring-bg'] = 'var(--interactive-accent)';
  } else if (c.ring === 'subtle') {
    v['--ez-ring-w'] = w;
    v['--ez-ring-bg'] = 'var(--background-modifier-border)';
  } else {
    v['--ez-ring-w'] = w;                 /* rainbow: the gradient in styles.css */
  }
  return v;
};

/* sets the variables, and clears ones set last time that are no longer wanted */
const applyVars = (node, vars) => {
  for (const name of node.__ezVars || []) {
    if (!(name in vars)) node.style.removeProperty(name);
  }
  for (const name of Object.keys(vars)) node.style.setProperty(name, vars[name]);
  node.__ezVars = Object.keys(vars);
};

/* "name 1.md" → "name 1" when the setting hides extensions */
const labelFor = (node, mode) => {
  if (!(node instanceof TFile) || !node.extension || mode === 'all') return node.name;
  if (mode === 'none' || node.extension.toLowerCase() === 'md') return node.basename;
  return node.name;
};

/* "name colours: by file type" */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];
const kindColour = (node) => {
  if (node instanceof TFolder) return 4;                                   /* blue */
  const ext = (node.extension || '').toLowerCase();
  if (ext === 'md') return 3;                                              /* green */
  if (IMAGE_EXT.includes(ext)) return 5;                                   /* lilac */
  if (ext === 'pdf') return 0;                                             /* pink */
  if (ext === 'canvas' || ext === 'base') return 1;                        /* peach */
  return 2;                                                                /* yellow */
};

/* who you are, as the operating system reports it */
const detectIdentity = () => {
  let user = 'user';
  try { user = nodeOs.userInfo().username || user; } catch (e) { /* keep the fallback */ }
  return { user: user.toLowerCase() };
};

/* nerd font logos: apple / windows / linux (bundled in styles.css) */
const osGlyph = () => {
  if (Platform.isMacOS) return '\uF179';
  if (Platform.isWin) return '\uF17A';
  return '\uF17C';
};

/* ── fonts ───────────────────────────────────────────────────────────────
   the panel ships its own typewriter face (embedded in styles.css), so the
   default needs nothing installed. the settings can swap it for a font from
   the user's own machine. */

/* well-known monospace fonts, checked quietly with no permission needed */
const CANDIDATE_FONTS = [
  'SF Mono', 'Menlo', 'Monaco', 'Andale Mono', 'Consolas', 'Lucida Console', 'Cascadia Code',
  'Cascadia Mono', 'Courier New', 'JetBrains Mono', 'Fira Code', 'Fira Mono', 'Source Code Pro',
  'IBM Plex Mono', 'Roboto Mono', 'Hack', 'Inconsolata', 'Ubuntu Mono', 'DejaVu Sans Mono',
  'Liberation Mono', 'Noto Sans Mono', 'Iosevka', 'Victor Mono', 'Space Mono', 'CMU Typewriter Text',
  'MesloLGS NF',
];

const quoteFont = (name) => '"' + String(name).replace(/["\\]/g, '') + '"';

let measureCtx = null;
const textWidth = (family, text) => {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = '64px ' + family;
  return measureCtx.measureText(text).width;
};

/* installed = drawing with it differs from every plain fallback */
const isInstalled = (name) => ['monospace', 'serif', 'sans-serif'].some(
  (base) => textWidth(quoteFont(name) + ', ' + base, 'mmmmmmmmmmlli') !== textWidth(base, 'mmmmmmmmmmlli')
);

/* monospace = narrow and wide letters take the same room */
const isMono = (name) => {
  const f = quoteFont(name) + ', monospace';
  return Math.abs(textWidth(f, 'iiiiiiiiii') - textWidth(f, 'mmmmmmmmmm')) < 0.5 &&
    Math.abs(textWidth(f, 'llllllllll') - textWidth(f, 'WWWWWWWWWW')) < 0.5;
};

/* asks chromium for every installed family (it may ask permission first) and
   keeps the monospace ones. returns null when this version can't do it. */
const scanSystemFonts = async () => {
  if (typeof window.queryLocalFonts !== 'function') return null;
  const fonts = await window.queryLocalFonts();
  const families = Array.from(new Set(fonts.map((f) => f.family)));
  return families
    .filter((name) => !/symbols|emoji|icons|dingbats|wingdings|webdings/i.test(name))
    .filter((name) => isInstalled(name) && isMono(name))
    .sort((a, b) => a.localeCompare(b));
};

/* the font-family to put in --vf-mono, or null to leave the css default
   (the bundled face, or whatever a theme sets) alone */
const fontStack = (cfg) => {
  switch (cfg.font) {
    case 'obsidian': return 'var(--font-monospace), ui-monospace, monospace';
    case 'system': return 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    case 'custom': return cfg.customFont.trim() || null;
    default:
      return cfg.font.indexOf('family:') === 0
        ? quoteFont(cfg.font.slice(7)) + ', ui-monospace, monospace'
        : null;
  }
};

/* ── keep the whole vault name visible ───────────────────────────────────
   the orange path pill never truncates. when the prompt is wider than the
   room it has, the whole bar is scaled down just enough to fit (css zoom),
   and is re-fitted whenever the pane resizes. (the card is as wide as this bar,
   so normally it fits at full size and the card just moves when the sidebar
   resizes; this only kicks in when the sidebar is narrower than the bar.) only below half size does the
   pill start to ellipsise instead. */
const fitBar = (bar, watch) => {
  const FLOOR = 0.5;
  let queued = false;

  const fit = () => {
    bar.classList.remove('is-squeezed');
    bar.style.zoom = '';                       /* measure at natural size */
    const have = bar.clientWidth;
    const need = bar.scrollWidth;
    if (!have || need <= have + 1) return;     /* fits (or is hidden): leave it alone */
    let k = have / need;
    if (k < FLOOR) { k = FLOOR; bar.classList.add('is-squeezed'); }
    bar.style.zoom = String(k);
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fit(); });
  };

  const ro = new ResizeObserver(schedule);
  watch.forEach((node) => ro.observe(node));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  schedule();
  return schedule;
};

/* ── rainbow scrollbar ──────────────────────────────────────────────────
   the native scrollbar is hidden (see styles.css) and this draws a thin
   rainbow thumb in its place, so it looks the same whatever theme or snippet
   is styling scrollbars. wheel / trackpad scrolling is untouched; the thumb
   can also be dragged. the scroller's parent must be position: relative. */
const rainbowBar = (scroller) => {
  const parent = scroller.parentElement;
  const sb = el('div', 'ez-sb');
  const thumb = el('div', 'ez-sb-thumb');
  sb.appendChild(thumb);
  parent.appendChild(sb);

  const update = () => {
    const { scrollHeight, clientHeight, scrollTop, offsetTop, offsetHeight } = scroller;
    if (!offsetHeight || scrollHeight <= clientHeight + 1) {
      sb.classList.remove('is-on');
      return;
    }
    sb.classList.add('is-on');
    sb.style.top = offsetTop + 'px';
    sb.style.height = clientHeight + 'px';
    const h = Math.max(24, (clientHeight * clientHeight) / scrollHeight);
    const y = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - h);
    thumb.style.height = h + 'px';
    thumb.style.transform = 'translateY(' + y + 'px)';
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  };

  scroller.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(scroller);
  new MutationObserver(schedule).observe(scroller, { childList: true, subtree: true, characterData: true });

  /* drag the thumb */
  sb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startTop = scroller.scrollTop;
    const ratio = (scroller.scrollHeight - scroller.clientHeight) /
      Math.max(1, scroller.clientHeight - thumb.offsetHeight);
    sb.setPointerCapture(e.pointerId);
    const move = (ev) => { scroller.scrollTop = startTop + (ev.clientY - startY) * ratio; };
    const up = () => {
      sb.removeEventListener('pointermove', move);
      sb.removeEventListener('pointerup', up);
      sb.removeEventListener('pointercancel', up);
    };
    sb.addEventListener('pointermove', move);
    sb.addEventListener('pointerup', up);
    sb.addEventListener('pointercancel', up);
  });

  schedule();
};

/* one colour per depth, in the order of the prompt pills (see styles.css) */
const COLOURS = 6;

const SORTS = ['name', 'mtime', 'ctime', 'size', 'ext'];

/* every command the prompt understands (tab completes these too) */
const COMMANDS = [
  'touch', 'mkdir', 'rename', 'mv', 'cp', 'rm', 'delete',
  'sort', 'reveal', 'collapse', 'expand', 'clear', 'help',
];
/* commands whose arguments are file names (tab completes those) */
const PATH_CMDS = new Set(['touch', 'mkdir', 'rename', 'mv', 'cp', 'rm', 'delete']);
/* commands that take two names, so names with spaces need quotes */
const MULTI_CMDS = new Set(['rename', 'mv', 'cp']);

/* the clickable "aliases" above the prompt, in pill-colour order */
const KEYS = [
  ['touch', 'new note: click, then type a name'],
  ['mkdir', 'new folder: click, then type a name'],
  ['rename', 'rename the open note, or a file in a folder: rename "folder/old" "new name"'],
  ['cp', 'copy the open note'],
  ['delete', 'delete to the system trash: click, then type a name'],
  ['sort', 'change how the tree is ordered'],
  ['reveal', 'jump to the open note in the tree and light it up as a pill'],
  ['collapse', 'fold every folder'],
  ['expand', 'unfold every folder'],
  ['help', 'open the guide: commands, shortcuts and what the colours mean'],
];

/* what `help` shows: a full page that takes the tree's place until you close it.
   sections of entries; each entry = command, pill colour index (same colour as its
   clickable word), forms as [arguments, description, example?], and an optional
   key table (sort). a section with `swatches` is the colour guide instead. */
const HELP = [
  { title: 'files', items: [
    { cmd: 'touch', c: 0, forms: [
      ['<name>', 'make a note. write folder/name to put it inside a folder. .md is added for you', 'touch ideas/new'],
    ] },
    { cmd: 'mkdir', c: 1, forms: [
      ['<name>', 'make a folder', 'mkdir ideas'],
    ] },
    { cmd: 'rename', c: 2, forms: [
      ['"<new name>"', 'rename the note you have open right now', 'rename "better title"'],
      ['"<folder>/<old>" "<new name>"', 'rename a file inside a folder: its path first, then only the new name. it stays in that folder', 'rename "ideas/old" "new name"'],
    ] },
    { cmd: 'mv', c: 2, forms: [
      ['"<from>" "<to>"', 'move a file or folder into another folder', 'mv "ideas/old" archive'],
    ] },
    { cmd: 'cp', c: 3, forms: [
      ['[<from>] [<to>]', 'copy a file. with no names it copies the note you have open'],
    ] },
    { cmd: 'rm', c: 4, forms: [
      ['<name>', 'send a file to the system trash. it asks y or n first. delete works the same', 'rm "ideas/old"'],
      ['-r <name>', 'also needed for a folder that still has things inside', 'rm -r ideas'],
      ['-f <name>', 'skip the y or n question', 'rm -f "ideas/old"'],
    ] },
  ] },
  { title: 'tree', items: [
    { cmd: 'sort', c: 5,
      forms: [['[key]', 'choose how the tree is ordered. with no key it steps to the next order']],
      keys: [
        ['name', 'a to z (the default)'],
        ['mtime', 'last edited first'],
        ['ctime', 'newest created first'],
        ['size', 'biggest first'],
        ['ext', 'grouped by file type'],
      ] },
    { cmd: 'reveal', c: 0, forms: [['', 'jump to the note you have open. it lights up as a colour pill tied to that note, and stays on it (through scrolling and folding) until you run another command, press esc, click that note or open another one']] },
    { cmd: 'collapse', c: 1, forms: [['', 'fold every folder']] },
    { cmd: 'expand', c: 2, forms: [['', 'unfold every folder']] },
  ] },
  { title: 'keys', items: [
    { cmd: 'enter', c: 3, forms: [['', 'run what you typed']] },
    { cmd: 'tab', c: 4, forms: [['', 'finish a name or command for you']] },
    { cmd: '↑ ↓', c: 5, forms: [['', 'bring back earlier commands']] },
    { cmd: 'y / n', c: 1, forms: [['', 'answer a question the prompt asks (anything but y cancels)']] },
    { cmd: 'esc', c: 0, forms: [['', 'empty the prompt, cancel a question, or close this guide']] },
  ] },
  { title: 'colours',
    note: 'the prompt colours what you type, as you type it',
    swatches: [
      ['ez-hl-cmd', 'touch', 'a command that exists'],
      ['ez-hl-bad', 'tuoch', 'not a command (or a sort key that doesn\'t exist)'],
      ['ez-hl-flag', '-r', 'a flag'],
      ['ez-hl-dir', 'ideas', 'a folder that exists'],
      ['ez-hl-file', 'old', 'a file that exists'],
      ['ez-hl-str', '"new name"', 'a quoted name (needed when it has spaces)'],
      ['ez-hl-key', 'mtime', 'a sort key'],
    ] },
];

/* builds the help page as real elements so everything lines up in columns */
const buildHelp = (close) => {
  const page = document.createDocumentFragment();

  /* sticky header: title dead centre, close button on the right */
  const head = el('div', 'ez-h-head');
  head.appendChild(el('span', 'ez-h-side'));
  head.appendChild(el('span', 'ez-h-title', 'help'));
  const x = el('span', 'ez-h-close ez-h-side', '×');
  x.title = 'back to the tree (esc)';
  x.addEventListener('click', close);
  head.appendChild(x);
  page.appendChild(head);

  page.appendChild(el('div', 'ez-h-note', 'type at the prompt below, or click a coloured word. names with spaces need "quotes"'));

  HELP.forEach((section) => {
    page.appendChild(el('div', 'ez-h-section', section.title));

    /* the colour guide: a sample in its real colour, then what it means */
    if (section.swatches) {
      page.appendChild(el('div', 'ez-h-note ez-h-tight', section.note));
      const guide = el('div', 'ez-h-colours');
      section.swatches.forEach(([cls, sample, meaning]) => {
        const cell = el('div', 'ez-h-sample');
        if (cls === 'ez-hl-str') {            /* quotes are dimmer than the name inside, like in the prompt */
          cell.appendChild(el('span', 'ez-hl-q', '"'));
          cell.appendChild(el('span', cls, sample.slice(1, -1)));
          cell.appendChild(el('span', 'ez-hl-q', '"'));
        } else {
          cell.appendChild(el('span', cls, sample));
        }
        guide.appendChild(cell);
        guide.appendChild(el('div', 'ez-h-desc', meaning));
      });
      page.appendChild(guide);
      return;
    }

    const grid = el('div', 'ez-h-grid');
    section.items.forEach((h, n) => {
      h.forms.forEach(([args, desc, example], i) => {
        const first = i === 0 && n > 0 ? ' is-first' : '';
        const name = el('div', 'ez-h-cmd ez-c' + h.c + first, i === 0 ? h.cmd : '');
        const body = el('div', 'ez-h-body' + first);
        if (args) body.appendChild(el('div', 'ez-h-args', args));
        body.appendChild(el('div', 'ez-h-desc', desc));
        if (example) {                       /* a real line as you'd type it, highlighted */
          const ex = el('div', 'ez-h-ex');
          ex.appendChild(el('span', 'ez-chev', '❯ '));
          const host = el('span', 'ez-h-exline');
          paintLine(host, example);
          ex.appendChild(host);
          body.appendChild(ex);
        }

        if (h.keys && i === h.forms.length - 1) {
          const table = el('div', 'ez-h-keys');
          h.keys.forEach(([k, d], j) => {
            table.appendChild(el('span', 'ez-h-k ez-c' + j, k));
            table.appendChild(el('span', 'ez-h-kd', d));
          });
          body.appendChild(table);
        }
        grid.appendChild(name);
        grid.appendChild(body);
      });
    });
    page.appendChild(grid);
  });

  const back = el('div', 'ez-h-back', '← back to the tree');
  back.addEventListener('click', close);
  page.appendChild(back);
  return page;
};

const byName = (a, b) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

const sorted = (folder, key, groupDirs = true, reverse = false) => {
  const flip = reverse ? -1 : 1;   /* reverse flips the order inside a group, never folders-before-files */
  return [...folder.children].sort((a, b) => {
    const af = a instanceof TFolder;
    const bf = b instanceof TFolder;
    if (groupDirs && af !== bf) return af ? -1 : 1;

    if (!af && !bf) {
      const sa = a.stat || {};
      const sb = b.stat || {};
      if (key === 'mtime' && sb.mtime !== sa.mtime) return flip * (sb.mtime - sa.mtime);   /* newest first */
      if (key === 'ctime' && sb.ctime !== sa.ctime) return flip * (sb.ctime - sa.ctime);
      if (key === 'size' && sb.size !== sa.size) return flip * (sb.size - sa.size);        /* biggest first */
      if (key === 'ext') {
        const c = (a.extension || '').localeCompare(b.extension || '');
        if (c) return flip * c;
      }
    }
    return flip * byName(a, b);
  });
};

/* how many things (files and folders) are inside a folder, all the way down */
const countInside = (folder) => folder.children.reduce(
  (n, c) => n + 1 + (c instanceof TFolder ? countInside(c) : 0), 0
);

/* "mv 'my note' notes" → ['mv', 'my note', 'notes'] */
const tokenize = (line) => {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
};

/* ── syntax highlighting for the prompt ──────────────────────────────────
   splits a line into tokens WITHOUT losing a single character (the coloured
   copy has to line up exactly with the text in the input), and paints each
   one into `host`. pass `lookup(path)` to colour names that exist; leave it
   out for static examples (help). */
const HL_RE = /\s+|"[^"]*"?|'[^']*'?|[^\s"']+/g;

const paintLine = (host, text, lookup) => {
  host.replaceChildren();
  const put = (cls, str) => {
    if (str) host.appendChild(cls ? el('span', cls, str) : document.createTextNode(str));
  };
  /* a/b/c with the slashes dimmed */
  const putPath = (cls, str) => {
    str.split('/').forEach((part, i) => {
      if (i) put('ez-hl-sep', '/');
      put(cls, part);
    });
  };

  let cmd = null;
  for (const tok of text.match(HL_RE) || []) {
    if (/^\s+$/.test(tok)) { put('', tok); continue; }

    /* first word: the command (green = valid, plain = could still become one, pink = unknown) */
    if (cmd === null) {
      cmd = tok;
      if (COMMANDS.includes(tok)) put('ez-hl-cmd', tok);
      else if (COMMANDS.some((c) => c.startsWith(tok))) put('', tok);
      else put('ez-hl-bad', tok);
      continue;
    }

    /* quotes are kept as separate dim pieces around the inside */
    const q = tok[0] === '"' || tok[0] === "'" ? tok[0] : '';
    let inner = q ? tok.slice(1) : tok;
    let closed = false;
    if (q && inner.endsWith(q)) { inner = inner.slice(0, -1); closed = true; }

    let cls = '';
    let pathy = false;
    if (!q && /^-{1,2}[A-Za-z][\w-]*$/.test(tok)) {
      cls = 'ez-hl-flag';
    } else if (cmd === 'sort') {
      cls = SORTS.includes(inner) ? 'ez-hl-key' : 'ez-hl-bad';
    } else if (PATH_CMDS.has(cmd)) {
      pathy = true;
      const found = lookup && inner ? lookup(inner) : null;
      if (found) cls = Array.isArray(found.children) ? 'ez-hl-dir' : 'ez-hl-file';
      else if (q) cls = 'ez-hl-str';
    }

    if (q) put('ez-hl-q', q);
    if (pathy) putPath(cls, inner);
    else put(cls, inner);
    if (closed) put('ez-hl-q', q);
  }
};

const parentOf = (path) => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};

const hasExt = (path) => /\.[^/.]+$/.test(path);

const commonPrefix = (list) => {
  let prefix = list[0] || '';
  for (const s of list) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i].toLowerCase() === s[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
};

/* ── rainbow gradient for our own icons ──────────────────────────────────
   a hidden svg holds the gradient; styles.css points `stroke` at it.
   mish.fastfetch does the same, whoever loads first creates it. */
const RAINBOW_ID = 'mish-rainbow-defs';

const mountRainbow = () => {
  let svg = document.getElementById(RAINBOW_ID);
  if (!svg) {
    const NS = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(NS, 'svg');
    svg.id = RAINBOW_ID;
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ez-rainbow-defs');

    const defs = document.createElementNS(NS, 'defs');
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.id = 'mish-rainbow';
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');   /* lucide icons live in a 24x24 box */
    grad.setAttribute('x1', '2');
    grad.setAttribute('y1', '2');
    grad.setAttribute('x2', '22');
    grad.setAttribute('y2', '22');

    const stops = [
      ['--vf-pink-hi', '#ffa6c9'], ['--vf-peach', '#ffd6a6'], ['--vf-yellow', '#fff1a8'],
      ['--vf-green', '#c9ffa6'], ['--vf-blue', '#a6c9ff'], ['--vf-lilac', '#c9b0ff'],
    ];
    stops.forEach(([name, fallback], i) => {
      const stop = document.createElementNS(NS, 'stop');
      stop.setAttribute('offset', String(i / (stops.length - 1)));
      stop.style.stopColor = 'var(' + name + ', var(' + name.replace('--vf-', '--mz-') + ', ' + fallback + '))';
      grad.appendChild(stop);
    });

    defs.appendChild(grad);
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }
  svg.dataset.users = String(Number(svg.dataset.users || 0) + 1);
};

/* the explorer's tab icon uses one gradient (shared with mish.fastfetch). point its six
   stops at the palette, or back at the theme's variables when the palette is the default. */
const paintRainbow = (cfg) => {
  const svg = document.getElementById(RAINBOW_ID);
  if (!svg) return;
  const colours = customColours(cfg);
  const light = lightTheme();
  svg.querySelectorAll('stop').forEach((stop, i) => {
    const s = SLOTS[i];
    if (!s) return;
    stop.style.stopColor = colours
      ? (light ? 'color-mix(in oklab, ' + colours[i] + ', black ' + s.dark + '%)' : colours[i])
      : 'var(' + s.vf + ', var(' + s.t + ', ' + DARK_FILLS[i] + '))';
  });
};

const unmountRainbow = () => {
  const svg = document.getElementById(RAINBOW_ID);
  if (!svg) return;
  const left = Number(svg.dataset.users || 1) - 1;
  if (left <= 0) svg.remove();
  else svg.dataset.users = String(left);
};

class EzaSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.scanned = [];
  }

  display() {
    const { containerEl, plugin } = this;
    const s = plugin.settings;
    containerEl.empty();

    const flag = (group, key, name, desc, after) => new UiSetting(containerEl)
      .setName(name)
      .setDesc(desc || '')
      .addToggle((toggle) => toggle
        .setValue(Boolean(s[group][key]))
        .onChange(async (value) => {
          s[group][key] = value;
          await plugin.saveSettings();
          if (after) await after(value);
        }));

    /* the builders below write into the settings, repaint, and save a moment later.
       kind: 'look' = styles only (fast), 'bar' = redraw the prompt, 'tree' = redraw the tree too. */
    const apply = (kind) => {
      if (kind === 'bar') {
        plugin.applySettings();
      } else {
        plugin.restyle();
        if (kind === 'tree') plugin.renderAll();
      }
      plugin.persist();
    };
    const holder = (group) => (group ? s[group] : s);
    const dflt = (group, key) => (group ? DEFAULT_SETTINGS[group] : DEFAULT_SETTINGS)[key];

    const drop = (group, key, name, desc, options, kind) => new UiSetting(containerEl)
      .setName(name)
      .setDesc(desc || '')
      .addDropdown((d) => d
        .addOptions(uiOptions(options))
        .setValue(String(holder(group)[key]))
        .onChange((value) => {
          holder(group)[key] = value;
          apply(kind);
        }));

    const tog = (group, key, name, desc, kind) => new UiSetting(containerEl)
      .setName(name)
      .setDesc(desc || '')
      .addToggle((t) => t
        .setValue(Boolean(holder(group)[key]))
        .onChange((value) => {
          holder(group)[key] = value;
          apply(kind);
        }));

    /* a slider with a little reset arrow that puts the default back */
    const slide = (group, key, name, desc, lo, hi, step, kind, unit) => {
      let comp = null;
      return new UiSetting(containerEl)
        .setName(name)
        .setDesc(desc || '')
        .addSlider((sl) => {
          comp = sl;
          sl.setLimits(lo, hi, step)
            .setValue(Number(holder(group)[key]))
            .setDynamicTooltip()
            .onChange((value) => {
              holder(group)[key] = value;
              apply(kind);
            });
        })
        .addExtraButton((b) => b
          .setIcon('rotate-ccw')
          .setTooltip(ui('back to the default (' + dflt(group, key) + (unit || '') + ')'))
          .onClick(() => {
            holder(group)[key] = dflt(group, key);
            comp.setValue(dflt(group, key));
            apply(kind);
          }));
    };

    /* ── the first setting: how the text in this tab is cased ── */
    new UiSetting(containerEl)
      .setName('lowercase ui')
      .setDesc('show the text in this tab, its tooltips and its messages in lowercase, to match the terminal look. turn it off for normal sentence case.')
      .addToggle((toggle) => toggle
        .setValue(s.lowercaseUi !== false)
        .onChange(async (value) => {
          s.lowercaseUi = value;
          uiCase.lower = value;
          await plugin.saveSettings();
          this.display();
        }));

    /* ── who you are ── */
    new UiSetting(containerEl).setName('identity').setHeading();

    new UiSetting(containerEl)
      .setName('user name')
      .setDesc('shown in the first pill. leave empty to use the name your system reports.')
      .addText((text) => text
        .setPlaceholder(plugin.detected.user)
        .setValue(s.username)
        .onChange(async (value) => {
          s.username = value.trim();
          await plugin.saveSettings();
        }));

    /* ── what the prompt shows ── */
    new UiSetting(containerEl).setName('prompt').setHeading();
    flag('pills', 'user', 'user pill', 'your name, with a logo for your operating system.');
    flag('pills', 'vault', 'vault pill', 'the name of this vault.');
    flag('pills', 'git', 'git pill', 'the current branch, when this vault is a git repository. it reads the file .git/HEAD in the vault folder and nothing else.',
      () => plugin.probe());
    flag('pills', 'time', 'time pill', 'the time of day.');
    drop(null, 'pillShape', 'pill shape', 'arrow is the powerline look. round and flat drop the arrow tips (and the little >>> bridge before the clock) and use gaps instead.',
      { arrow: 'arrow (powerline)', round: 'round', flat: 'flat' }, 'look');
    new UiSetting(containerEl)
      .setName('vault pill text')
      .setDesc('what the second pill says. leave it empty for ~/ and the vault name.')
      .addText((text) => text
        .setPlaceholder('~/' + plugin.app.vault.getName())
        .setValue(s.vaultLabel)
        .onChange((value) => {
          s.vaultLabel = value.trim();
          apply('bar');
        }));
    tog('clock', 'hour12', '12-hour clock', 'shows 09:41 pm instead of 21:41.', 'bar');
    tog('clock', 'seconds', 'show seconds', 'the clock pill already ticks every second. the card never changes width.', 'bar');

    /* ── colours ── */
    new UiSetting(containerEl).setName('colours').setHeading();

    const pickers = [];
    let presetDrop = null;
    let refreshing = false;       /* setValue on a picker must not count as the user picking */
    const shown = () => (s.palette.preset === 'theme' ? themeFills() : s.palette.colours);

    const presets = { theme: ui('mish') };
    Object.keys(PALETTES).forEach((k) => { presets[k] = ui(k); });
    presets.custom = ui('custom');

    new UiSetting(containerEl)
      .setName('palette')
      .setDesc('the six colours of the rainbow. they colour the prompt pills, the tree levels, the card border, the scrollbar and the explorer tab icon. mish is the default: the pastel rainbow this plugin ships, and it follows the colours of your obsidian theme if the theme sets them. pick a preset, then change any colour below. in light mode the text versions are darkened for you.')
      .addDropdown((d) => {
        presetDrop = d;
        d.addOptions(presets)
          .setValue(presets[s.palette.preset] ? s.palette.preset : 'theme')
          .onChange((value) => {
            const was = s.palette.preset;
            s.palette.preset = value;
            if (PALETTES[value]) s.palette.colours = PALETTES[value].slice();
            else if (value === 'custom' && was === 'theme') s.palette.colours = themeFills();
            refreshing = true;
            shown().forEach((c, i) => { if (pickers[i]) pickers[i].setValue(c); });
            refreshing = false;
            apply('look');
          });
      })
      .addExtraButton((b) => b
        .setIcon('rotate-ccw')
        .setTooltip(ui('back to mish'))
        .onClick(() => {
          s.palette.preset = 'theme';
          presetDrop.setValue('theme');
          refreshing = true;
          shown().forEach((c, i) => { if (pickers[i]) pickers[i].setValue(c); });
          refreshing = false;
          apply('look');
        }));

    SLOTS.forEach((slot, i) => {
      new UiSetting(containerEl)
        .setName('colour ' + (i + 1))
        .setDesc(slot.used)
        .addColorPicker((c) => {
          pickers[i] = c;
          c.setValue(shown()[i]).onChange((hex) => {
            if (refreshing) return;
            if (s.palette.preset === 'theme') s.palette.colours = themeFills();   /* start from what you were seeing */
            s.palette.colours[i] = String(hex).toLowerCase();
            s.palette.preset = 'custom';
            presetDrop.setValue('custom');
            apply('look');
          });
        });
    });

    let inkPicker = null;
    const autoInk = () => (lightTheme() ? '#2a2430' : '#0f0f12');
    new UiSetting(containerEl)
      .setName('pill text colour')
      .setDesc('the text on every pill (prompt and hover). automatic = dark ink. try white with a dark palette.')
      .addColorPicker((c) => {
        inkPicker = c;
        c.setValue(HEX.test(s.inkColour) ? s.inkColour : autoInk()).onChange((hex) => {
          s.inkColour = String(hex).toLowerCase();
          apply('look');
        });
      })
      .addExtraButton((b) => b
        .setIcon('rotate-ccw')
        .setTooltip(ui('back to automatic'))
        .onClick(() => {
          s.inkColour = '';
          inkPicker.setValue(autoInk());
          apply('look');
        }));

    /* ── the tree ── */
    new UiSetting(containerEl).setName('tree').setHeading();
    new UiSetting(containerEl)
      .setName('folders first')
      .setDesc('list folders before files, like eza --group-directories-first.')
      .addToggle((toggle) => toggle
        .setValue(s.groupDirsFirst)
        .onChange(async (value) => {
          s.groupDirsFirst = value;
          await plugin.saveSettings();
          plugin.renderAll();
        }));
    tog('tree', 'reverse', 'reverse the order', 'flips whatever sort is active. folders still come first if that is on.', 'tree');
    drop('tree', 'extensions', 'file extensions', 'only changes what the tree shows. the files keep their real names.',
      { all: 'show all', md: 'hide .md', none: 'hide all' }, 'tree');
    drop('tree', 'nameColour', 'name colours', "by depth = one colour per level, like the prompt. by file type = folders blue, notes green, images lilac, pdfs pink, canvases peach, the rest yellow. plain = your theme's text colour.",
      { depth: 'by depth', type: 'by file type', plain: 'plain' }, 'tree');
    drop('tree', 'activeStyle', 'open note marker', 'how the note you have open is marked in the tree.',
      { outline: 'outline', fill: 'filled pill', none: 'none' }, 'look');
    tog('tree', 'autoReveal', 'follow the open note', 'when you open a note, and when obsidian starts, unfold its folders, scroll to it and light it up as a pill (what the reveal command does).', 'look');
    slide('tree', 'fontSize', 'tree font size', 'the names and the lines. the prompt keeps its size.', 9, 20, 0.5, 'look', 'px');
    slide('tree', 'rowHeight', 'row height', 'space between rows.', 16, 40, 1, 'look', 'px');
    slide('tree', 'indent', 'indent width', 'characters per level. eza uses 4.', 3, 8, 1, 'look', ' ch');
    drop('tree', 'lineStyle', 'line style', 'the ├── └── │ lines.', { solid: 'solid', dashed: 'dashed', dotted: 'dotted' }, 'look');
    slide('tree', 'lineWidth', 'line thickness', '', 1, 3, 1, 'look', 'px');
    slide('tree', 'lineOpacity', 'line strength', 'how strong the lines are, in percent.', 5, 100, 5, 'look', '%');

    /* ── hover reveal ── */
    new UiSetting(containerEl).setName('hover reveal').setHeading();
    flag('show', 'reveal', 'reveal full names on hover', 'hover a name that is cut off and a colour pill, like the prompt ones, shows the whole thing.',
      () => plugin.hidePill());
    tog('revealPill', 'always', 'also on names that fit', 'show the pill on every name you hover, not only the cut-off ones.', 'look');
    slide('revealPill', 'delay', 'delay', 'how long the mouse rests on a name before the pill appears.', 0, 600, 20, 'look', ' ms');

    /* ── card and layout ── */
    new UiSetting(containerEl).setName('card and layout').setHeading();
    drop('card', 'width', 'card width', 'fit = as wide as the prompt (the same size as mish.fastfetch). full = the whole sidebar.',
      { fit: 'fit the prompt', full: 'full width' }, 'look');
    drop('card', 'hAlign', 'horizontal position', 'only matters for the fit width.', { centre: 'centre', left: 'left' }, 'look');
    drop('card', 'vAlign', 'vertical position', 'centred when the card is shorter than the sidebar, or pinned to the top.',
      { centre: 'centre', top: 'top' }, 'look');
    drop('card', 'ring', 'border', 'rainbow uses the palette. accent is obsidian\'s accent colour. subtle is your theme\'s border colour.',
      { rainbow: 'rainbow', accent: 'accent colour', subtle: 'subtle', none: 'none' }, 'look');
    slide('card', 'ringWidth', 'border thickness', '', 1, 4, 1, 'look', 'px');
    slide('card', 'angle', 'rainbow angle', 'direction of the border gradient. 135 runs top-left to bottom-right.', 0, 345, 15, 'look', '°');
    slide('card', 'radius', 'corner radius', '', 0, 28, 1, 'look', 'px');
    slide('card', 'pad', 'outer margin', 'space between the card and the edge of the sidebar.', 0, 32, 1, 'look', 'px');

    /* ── the shell ── */
    new UiSetting(containerEl).setName('shell').setHeading();
    new UiSetting(containerEl)
      .setName('ask before deleting')
      .setDesc('rm and delete ask y or n in the prompt before anything goes to the trash. rm -f skips the question.')
      .addToggle((toggle) => toggle
        .setValue(s.confirmRm !== false)
        .onChange(async (value) => {
          s.confirmRm = value;
          await plugin.saveSettings();
        }));
    flag('show', 'shell', 'shell line', 'the typing area and the clickable commands at the bottom. hide it for a plain prompt and tree. the commands are unavailable while it is hidden.');
    flag('show', 'command', 'command line', 'the line that says eza --tree --all, and the dot under it.');
    flag('show', 'keys', 'clickable commands', 'the row of command names you can click (touch, mkdir, rename and so on). you can still type them.');

    /* ── font ── */
    new UiSetting(containerEl).setName('appearance').setHeading();

    const choices = () => {
      const opts = {
        bundled: ui('cmu typewriter (bundled)'),
        obsidian: ui("obsidian's monospace font"),
        system: ui('system monospace'),
      };
      const names = new Set(CANDIDATE_FONTS.filter((n) => isInstalled(n)));
      this.scanned.forEach((n) => names.add(n));
      if (s.font.indexOf('family:') === 0) names.add(s.font.slice(7));
      Array.from(names)
        .sort((a, b) => a.localeCompare(b))
        .forEach((n) => { opts['family:' + n] = n; });
      opts.custom = ui('custom…');
      return opts;
    };

    let custom = null;

    new UiSetting(containerEl)
      .setName('font')
      .setDesc('the default font is bundled with the plugin, so nothing needs installing. or pick a monospace font from this computer.')
      .addDropdown((dropdown) => {
        this.fontDropdown = dropdown;
        dropdown
          .addOptions(choices())
          .setValue(s.font)
          .onChange(async (value) => {
            s.font = value;
            if (custom) custom.settingEl.hidden = value !== 'custom';
            await plugin.saveSettings();
          });
      });

    custom = new UiSetting(containerEl)
      .setName('custom font')
      .setDesc('any css font-family list, such as "JetBrains Mono", monospace')
      .addText((text) => text
        .setPlaceholder('"JetBrains Mono", monospace')
        .setValue(s.customFont)
        .onChange(async (value) => {
          s.customFont = value;
          await plugin.saveSettings();
        }));
    custom.settingEl.hidden = s.font !== 'custom';

    new UiSetting(containerEl)
      .setName('find monospace fonts')
      .setDesc("adds every monospace font installed on this computer to the menu above. obsidian may ask for permission first. if this version can't do it, the menu still lists the common fonts it finds.")
      .addButton((button) => button
        .setButtonText(ui('scan'))
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const list = await scanSystemFonts();
            if (!list) {
              new Notice(ui("this version of obsidian can't list system fonts. use a custom font instead."));
            } else {
              this.scanned = list;
              this.fontDropdown.selectEl.empty();
              this.fontDropdown.addOptions(choices());
              this.fontDropdown.setValue(s.font);
              new Notice(ui('found ' + list.length + ' monospace fonts.'));
            }
          } catch (e) {
            new Notice(ui('could not read the font list. use a custom font instead.'));
          }
          button.setDisabled(false);
        }));

    /* ── reset ── */
    new UiSetting(containerEl).setName('reset').setHeading();
    new UiSetting(containerEl)
      .setName('reset appearance')
      .setDesc('puts every colour, shape, tree, hover and card option back to the default. your name, prompt pills, font and shell settings are not touched.')
      .addButton((button) => button
        .setButtonText(ui('reset'))
        .setWarning()
        .onClick(async () => {
          for (const k of ['palette', 'inkColour', 'pillShape', 'tree', 'card', 'revealPill']) {
            s[k] = clone(DEFAULT_SETTINGS[k]);
          }
          await plugin.saveAll();
          plugin.applySettings();
          plugin.renderAll();
          this.display();
        }));
  }
}

module.exports = class MishEza extends Plugin {
  async onload() {
    mountRainbow();
    this.roots = new Set();
    this.branch = null;
    this.showNative = false;
    this.history = [];
    this.pending = null;     /* a y/n question waiting for an answer */
    this.detected = detectIdentity();

    /* data.json holds the settings, the folded folders and the sort order */
    const saved = (await this.loadData()) || {};
    this.settings = sanitise(deepMerge(clone(DEFAULT_SETTINGS), saved.settings || {}));
    uiCase.lower = this.settings.lowercaseUi;
    this.open = new Set(saved.open || []);
    this.sortKey = SORTS.includes(saved.sort) ? saved.sort : 'name';

    /* 'follow the open note' used to be off by default. a data.json from before the
       change has that stored as false, so once (and only once) it is switched on. */
    if (!saved.v) this.settings.tree.autoReveal = true;

    /* obsidian reports the open note before the tree exists, so the first reveal waits for it */
    this.revealPending = true;

    this.addSettingTab(new EzaSettingTab(this.app, this));
    this.restyle();      /* the tab icon's gradient, before the first panel exists */

    this.app.workspace.onLayoutReady(() => {
      this.ensure();
      this.probe();
    });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.ensure()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.ensure()));
    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.hideSticky();
      this.followOpenNote('nearest');
    }));
    /* light <-> dark: custom colours have a darker text version in light mode */
    this.registerEvent(this.app.workspace.on('css-change', () => this.restyle()));

    /* the tree follows the vault */
    const bump = () => {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = window.setTimeout(() => this.renderAll(), 150);
    };
    for (const ev of ['create', 'delete', 'rename']) {
      this.registerEvent(this.app.vault.on(ev, bump));
    }

    /* keeps the clock ticking and re-mounts if the explorer is rebuilt */
    let beat = 0;
    this.registerInterval(window.setInterval(() => {
      this.tick();
      if (++beat % 5 === 0) this.ensure();   /* the re-mount check does not need to run every second */
    }, 1000));

    this.addCommand({
      id: 'remount-eza',
      name: 'Redraw the prompt',
      callback: () => {
        for (const root of this.roots) root.remove();
        this.roots.clear();
        this.ensure();
      }
    });

    this.addCommand({
      id: 'toggle-native-explorer',
      name: 'Toggle native file explorer',
      callback: () => {
        this.showNative = !this.showNative;
        this.ensure();
      }
    });
  }

  onunload() {
    this.hidePill();
    this.hideSticky();
    paintRainbow(DEFAULT_SETTINGS);      /* the shared gradient goes back to the theme's colours */
    unmountRainbow();
    window.clearTimeout(this.renderTimer);
    window.clearTimeout(this.saveTimer);
    for (const root of this.roots) root.remove();
    this.roots.clear();
    document
      .querySelectorAll('.workspace-leaf-content[data-type="file-explorer"].ez-on')
      .forEach((leaf) => leaf.classList.remove('ez-on'));
  }

  /* ── prompt extra: the git branch ──────────────────────────────────────
     only when the git pill is on. it reads one small file inside the vault
     folder (.git/HEAD) through obsidian's own api, and runs nothing. */

  async probe() {
    this.branch = null;
    if (this.settings.pills.git) {
      try {
        const head = (await this.app.vault.adapter.read('.git/HEAD')).trim();
        const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        if (m) this.branch = m[1];
        else if (/^[0-9a-f]{40}$/i.test(head)) this.branch = head.slice(0, 7);   /* detached head */
      } catch (e) {
        this.branch = null;
      }
    }
    for (const root of this.roots) this.drawBar(root);
  }

  /* ── mounting ────────────────────────────────────────────────────── */

  ensure() {
    const leaves = document.querySelectorAll(
      '.workspace-leaf-content[data-type="file-explorer"]'
    );

    leaves.forEach((leaf) => {
      leaf.classList.toggle('ez-on', !this.showNative);
      if (leaf.querySelector('.ez-root')) return;
      const host = leaf.querySelector(':scope > .view-content') || leaf;
      const root = this.build();
      host.prepend(root);
      this.roots.add(root);
      this.renderTree(root);
      this.tick();
    });

    for (const root of [...this.roots]) {
      if (!root.isConnected) this.roots.delete(root);
    }

    /* the tree was only just built (app start, or the explorer was rebuilt): catch up */
    if (this.revealPending && this.roots.size) {
      window.requestAnimationFrame(() => {
        if (this.revealPending) this.followOpenNote('center');   /* once is enough */
      });
    }
  }

  /* 'follow the open note': unfold its folders, scroll to it and light it up with the
     same pill the reveal command uses. when there is no tree yet it waits (revealPending)
     and ensure() calls this again the moment one is built. */
  followOpenNote(block = 'nearest') {
    if (!this.settings.tree.autoReveal) {
      this.revealPending = false;
      this.markActive();
      return;
    }
    if (!this.app.workspace.getActiveFile()) return;     /* nothing open: stay pending */
    if (![...this.roots].some((root) => root.isConnected)) {
      this.revealPending = true;
      return;
    }
    this.revealPending = false;
    try { this.cmdReveal(block, true); } catch (e) { this.markActive(); }
  }

  /* ── drawing ─────────────────────────────────────────────────────── */

  build() {
    const root = el('div', 'ez-root');

    /* the card: one bordered box round everything, like fastfetch's .vf */
    const card = el('div', 'ez-card');
    root.appendChild(card);

    const scroll = el('div', 'ez-scroll');   /* header + tree scroll; the shell stays put */
    card.appendChild(scroll);

    const bar = el('div', 'ez-bar');
    scroll.appendChild(bar);

    /* the command */
    const cmd = el('div', 'ez-cmd');
    cmd.appendChild(el('span', 'ez-chev', '❯'));
    cmd.appendChild(document.createTextNode(' '));
    cmd.appendChild(el('span', 'ez-exe', 'eza'));
    cmd.appendChild(document.createTextNode(' '));
    const arg = el('span', 'ez-arg', '');
    cmd.appendChild(arg);
    cmd.appendChild(document.createTextNode(' '));
    cmd.appendChild(el('span', 'ez-path-arg', '.'));
    scroll.appendChild(cmd);

    /* eza prints the root as a dot, then the tree */
    const dot = el('div', 'ez-dot', '.');
    scroll.appendChild(dot);

    const tree = el('div', 'ez-tree');
    scroll.appendChild(tree);

    const help = el('div', 'ez-helppage');   /* shown instead of the tree while help is open */
    card.appendChild(help);

    const foot = this.buildFoot(root);
    card.appendChild(foot.node);             /* the shell line lives inside the card too */

    const fit = fitBar(bar, [root, card, scroll]);   /* keeps the full vault name on screen; root is watched too, because the card no longer grows with the pane */
    root.__ez = { card, bar, tree, arg, help, fit, cmd, dot, keys: foot.keys, clock: null, input: foot.input, out: foot.out };
    rainbowBar(scroll);
    rainbowBar(help);
    rainbowBar(foot.out);
    this.drawBar(root);
    this.applyLook(root);
    this.bind(root, tree);
    return root;
  }

  /* powerline prompt, built from the pill toggles. the git pill appears only
     when it is switched on and a branch was found. */
  drawBar(root) {
    const refs = root.__ez;
    refs.bar.replaceChildren();
    refs.clock = null;

    const { pills } = this.settings;
    const segs = [];
    if (pills.user) segs.push(['ez-user', osGlyph() + ' ' + this.identity()]);
    if (pills.vault) segs.push(['ez-path', this.settings.vaultLabel || '~/' + this.app.vault.getName()]);
    if (pills.git && this.branch) segs.push(['ez-git', this.branch, true]);
    if (pills.time) {
      /* the same yellow / green / blue bridge as mish.fastfetch, so both prompts
         (and so both cards) come out the same width. when the git pill is on it
         is already yellow, so the bridge starts at green instead. */
      if (segs.length) {
        if (!(pills.git && this.branch)) segs.push(['ez-ch ez-ch1', '']);
        segs.push(['ez-ch ez-ch2', ''], ['ez-ch ez-ch3', '']);
      }
      segs.push(['ez-clock', '']);
    }

    segs.forEach(([cls, text, icon], i) => {
      const seg = el('span', 'ez-seg ' + cls);
      if (icon) {
        /* obsidian's own branch icon, so no icon font is needed */
        const mark = el('span', 'ez-git-icon');
        setIcon(mark, 'git-branch');
        seg.appendChild(mark);
        seg.appendChild(document.createTextNode(text));
      } else {
        seg.textContent = text;
      }
      seg.style.zIndex = String(segs.length - i);   /* arrow tips overlap the next segment */
      refs.bar.appendChild(seg);
      if (cls === 'ez-clock') refs.clock = seg;
    });

    refs.bar.hidden = segs.length === 0;
    this.tick();
    if (refs.fit) refs.fit();
  }

  /* font choice and which parts of the panel show */
  applyLook(root) {
    const refs = root.__ez;
    const { show } = this.settings;

    const stack = fontStack(this.settings);
    if (stack) root.style.setProperty('--vf-mono', stack);
    else root.style.removeProperty('--vf-mono');

    /* colours, sizes, lines, the card: all css variables on this panel */
    applyVars(root, Object.assign({}, paletteVars(this.settings), layoutVars(this.settings)));
    SHAPES.forEach((n) => root.classList.toggle('ez-shape-' + n, this.settings.pillShape === n));
    ACTIVES.forEach((n) => root.classList.toggle('ez-act-' + n, this.settings.tree.activeStyle === n));
    root.classList.toggle('ez-full', this.settings.card.width === 'full');

    refs.cmd.hidden = !show.command;
    refs.dot.hidden = !show.command;
    refs.keys.hidden = !show.keys;
    const foot = root.querySelector('.ez-foot');
    if (foot) foot.hidden = show.shell === false;
    if (refs.fit) refs.fit();
  }

  /* settings changed: redraw what depends on them, in place */
  applySettings() {
    for (const root of this.roots) {
      this.drawBar(root);
      this.applyLook(root);
    }
    paintRainbow(this.settings);
  }

  /* styles only (colours, sizes, shape): cheaper than applySettings, no prompt redraw */
  restyle() {
    for (const root of this.roots) this.applyLook(root);
    paintRainbow(this.settings);
  }

  /* what the settings say, falling back to what the system says */
  identity() {
    return this.settings.username || this.detected.user;
  }

  async saveSettings() {
    await this.saveAll();
    this.applySettings();
  }

  /* the little shell: clickable commands + a real prompt you can type in */
  buildFoot(root) {
    const node = el('div', 'ez-foot');

    const out = el('div', 'ez-out');
    out.title = 'click to dismiss';
    out.addEventListener('click', () => this.say(''));
    node.appendChild(out);

    const keys = el('div', 'ez-keys');
    KEYS.forEach(([cmd, title], i) => {
      const key = el('span', 'ez-key ez-c' + (i % COLOURS), cmd);
      key.title = title;
      key.addEventListener('click', () => this.press(cmd, root));
      keys.appendChild(key);
    });
    node.appendChild(keys);

    const line = el('div', 'ez-line');
    line.appendChild(el('span', 'ez-chev', '❯'));

    const input = el('input', 'ez-input');
    input.type = 'text';
    input.placeholder = PLACEHOLDER;
    input.spellcheck = false;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');

    /* syntax highlighting: the input's own text is transparent, and a coloured
       copy sits behind it (same font, same width per character, so it lines up) */
    const wrap = el('div', 'ez-inwrap');
    const hl = el('div', 'ez-hl');
    const hlIn = el('span', 'ez-hl-in');
    hl.appendChild(hlIn);
    /* the caret is drawn by hand as fastfetch's pink block: a hidden twin of the
       text measures where it goes, and the character under it is shown inverted */
    const meas = el('span', 'ez-hl-meas');
    const caret = el('div', 'ez-caret');
    hl.appendChild(meas);
    hl.appendChild(caret);
    wrap.appendChild(hl);
    wrap.appendChild(input);
    line.appendChild(wrap);
    node.appendChild(line);

    const paint = () => {
      try {
        if (this.pending) hlIn.textContent = input.value;    /* answering y/n: not a command, so no red */
        else paintLine(hlIn, input.value, (p) => this.lookup(p));
      } catch (e) { hlIn.textContent = input.value; }
      hlIn.style.transform = 'translateX(' + (-input.scrollLeft) + 'px)';   /* follow a long line as it scrolls */

      const v = input.value;
      const pos = input.selectionStart == null ? v.length : input.selectionStart;
      meas.textContent = v.slice(0, pos);
      const x = meas.getBoundingClientRect().width - input.scrollLeft;
      caret.style.transform = 'translate(' + x + 'px, -50%)';
      caret.textContent = v.charAt(pos);
      caret.style.animation = 'none';          /* solid while you type, blinking when idle */
      void caret.offsetWidth;
      caret.style.animation = '';
      wrap.classList.toggle('is-empty', !v);
      wrap.classList.toggle('has-sel', input.selectionStart !== input.selectionEnd);
      wrap.classList.toggle('is-focus', input.ownerDocument.activeElement === input);
    };
    /* catch programmatic changes too (tab completion, history, clicking a command) */
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); paint(); },
    });
    ['input', 'scroll', 'keyup', 'mouseup', 'focus', 'blur', 'select'].forEach((ev) => input.addEventListener(ev, paint));
    input.addEventListener('keydown', () => requestAnimationFrame(paint));
    paint();

    /* enter runs, tab completes, up/down walk the history, escape clears */
    let at = -1;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = input.value;
        input.value = '';
        at = -1;
        this.run(value);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.complete(input);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this.history.length) return;
        at = Math.min(at + 1, this.history.length - 1);
        input.value = this.history[this.history.length - 1 - at];
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        at = Math.max(at - 1, -1);
        input.value = at < 0 ? '' : this.history[this.history.length - 1 - at];
      } else if (e.key === 'Escape') {
        input.value = '';
        at = -1;
        this.hideSticky();
        this.say('');
        input.blur();
      }
    });

    return { node, input, out, keys };
  }

  /* clicking a command: ones that need a name get typed into the prompt,
     everything else just runs */
  press(cmd, root) {
    const input = root.__ez.input;
    if (cmd === 'touch' || cmd === 'mkdir' || cmd === 'delete') {
      input.value = cmd + ' ';
      input.focus();
    } else if (cmd === 'rename') {
      input.value = 'rename ""';          /* cursor goes between the quotes */
      input.focus();
      input.setSelectionRange(8, 8);
    } else {
      this.run(cmd);
    }
  }

  /* the tree itself: one row per entry, lines drawn by css cells */
  renderTree(root) {
    const frag = document.createDocumentFragment();
    this.walk(this.app.vault.getRoot(), [], frag);
    this.hidePill();                      /* its row is about to be replaced */
    root.__ez.tree.replaceChildren(frag);

    root.__ez.arg.textContent =
      '--tree --all --level=99' + (this.sortKey !== 'name' ? ' --sort=' + this.sortKey : '');
    this.markActive();
  }

  renderAll() {
    for (const root of this.roots) this.renderTree(root);
  }

  /* guides[i] is true when ancestor i still has siblings below it (draws │).
     depth picks the colour: pink, peach, yellow, green, blue, lilac, repeat. */
  walk(folder, guides, out) {
    const kids = sorted(folder, this.sortKey, this.settings.groupDirsFirst, this.settings.tree.reverse);
    const depth = guides.length;
    const colour = 'ez-c' + (depth % COLOURS);

    kids.forEach((node, i) => {
      const last = i === kids.length - 1;
      const isDir = node instanceof TFolder;

      const row = el('div', 'ez-row');
      row.dataset.path = node.path;
      row.dataset.depth = String(depth % COLOURS);     /* the hover pill falls back to this colour */

      guides.forEach((g, j) => {
        row.appendChild(el('span', 'ez-cell ez-c' + (j % COLOURS) + (g ? ' ez-v' : '')));
      });
      row.appendChild(el('span', 'ez-cell ' + colour + ' ' + (last ? 'ez-l' : 'ez-t')));

      /* name colour: by depth (like the prompt), by file type, or plain */
      const mode = this.settings.tree.nameColour;
      const nameColour = mode === 'type' ? 'ez-c' + kindColour(node) : mode === 'plain' ? '' : colour;
      const name = el('span', 'ez-name ' + nameColour + (isDir ? ' ez-dir' : ''));
      name.appendChild(el('span', 'ez-fold', isDir ? (this.open.has(node.path) ? '-' : '+') : ''));
      name.appendChild(document.createTextNode(labelFor(node, this.settings.tree.extensions)));
      row.appendChild(name);

      out.appendChild(row);

      if (isDir && this.open.has(node.path)) this.walk(node, [...guides, !last], out);
    });
  }

  markActive() {
    const active = this.app.workspace.getActiveFile();
    const path = active ? active.path : null;
    for (const root of this.roots) {
      root.__ez.tree.querySelectorAll('.ez-row').forEach((row) => {
        row.classList.toggle('is-active', row.dataset.path === path);
      });
    }
  }

  /* ── clicking the tree ───────────────────────────────────────────── */

  bind(root, tree) {
    this.bindReveal(root, tree);

    tree.addEventListener('click', (e) => {
      const row = e.target.closest('.ez-row');
      if (!row) return;
      const item = this.app.vault.getAbstractFileByPath(row.dataset.path);
      if (!item) return;

      if (item instanceof TFolder) {
        if (this.open.has(item.path)) this.open.delete(item.path);
        else this.open.add(item.path);
        this.renderAll();
        this.persist();
      } else {
        this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(item);
      }
    });

    /* right-click a row: obsidian's own file menu (copy path, reveal in finder, ...).
       renaming, deleting and the rest live in the shell. */
    root.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.ez-foot')) return;   /* the prompt keeps its own menu */
      const row = e.target.closest('.ez-row');
      const item = row ? this.app.vault.getAbstractFileByPath(row.dataset.path) : null;
      if (!item) return;

      e.preventDefault();
      const menu = new Menu();
      this.app.workspace.trigger('file-menu', menu, item, 'file-explorer-context-menu');
      menu.showAtMouseEvent(e);
    });
  }

  /* ── the reveal pill ─────────────────────────────────────────────────────
     the card never resizes, so long names end in an ellipsis. hover one (only
     one that is actually cut off) and a prompt-style pill grows out of it with
     the whole name: depth colour, ink text, arrow tip. it lives on <body>, not
     inside the card, because the card clips anything that sticks out. it never
     takes the mouse (pointer-events: none), so the row underneath keeps its
     hover and nothing flickers. */

  bindReveal(root, tree) {
    let current = null;
    let timer = 0;

    const stop = () => {
      current = null;
      window.clearTimeout(timer);
      this.hidePill();
    };

    tree.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.ez-row');
      if (!row || row === current) return;
      stop();
      current = row;
      if (this.settings.show.reveal === false) return;
      /* a short pause (a setting), so sweeping down the tree doesn't flash */
      timer = window.setTimeout(() => this.showPill(row), num(this.settings.revealPill.delay, 0, 1000, 140));
    });

    tree.addEventListener('mouseleave', stop);
    tree.addEventListener('click', (e) => {
      stop();
      /* the reveal pill follows its note around, so only clicking that note itself puts it away */
      const row = e.target.closest('.ez-row');
      if (row && this.stickyPath && row.dataset.path === this.stickyPath) this.hideSticky();
    });
    tree.addEventListener('contextmenu', stop);
    const scroller = tree.closest('.ez-scroll');
    if (scroller) scroller.addEventListener('scroll', stop, { passive: true });
  }

  /* builds a pill for a row on <body> and returns it, or null when there is nothing to show.
     force = the reveal command asked for it, so it shows even when the name fits */
  buildPill(row, force) {
    const name = row.isConnected ? row.querySelector('.ez-name') : null;
    if (!name || !name.lastChild) return null;
    if (!force && !this.settings.revealPill.always && name.scrollWidth <= name.clientWidth + 1) return null;   /* it all fits: nothing to reveal */

    const rect = name.getBoundingClientRect();
    const style = window.getComputedStyle(name);
    const own = name.className.match(/ez-c\d/);       /* plain-coloured names have none: use the row's depth */
    const depth = own ? own[0] : 'ez-c' + (row.dataset.depth || '0');

    const wrap = el('div', 'ez-pill-wrap ez-shape-' + this.settings.pillShape);
    const pill = el('div', 'ez-pill ' + depth + (name.classList.contains('ez-dir') ? ' ez-dir' : ''));
    pill.appendChild(el('span', 'ez-pill-fold', name.firstChild.textContent));   /* the + / - keeps its column */
    pill.appendChild(document.createTextNode(name.lastChild.textContent));
    wrap.appendChild(pill);
    applyVars(wrap, paletteVars(this.settings));       /* it lives on <body>, so it needs the palette itself */

    /* same face and size as the row, so the letters don't jump when the pill lands */
    wrap.style.fontFamily = style.fontFamily;
    wrap.style.fontSize = style.fontSize;
    wrap.style.letterSpacing = style.letterSpacing;
    wrap.style.height = rect.height + 'px';
    wrap.style.lineHeight = rect.height + 'px';
    pill.style.height = rect.height + 'px';

    document.body.appendChild(wrap);

    this.placePill(wrap, rect);
    return wrap;
  }

  /* start 6px left of the name (that is the pill's own padding, so the text stays put),
     and slide back in if it would run off the right edge of the window */
  placePill(wrap, rect) {
    let left = rect.left - 6;
    const room = window.innerWidth - 8;
    if (left + wrap.offsetWidth > room) left = Math.max(8, room - wrap.offsetWidth);
    wrap.style.left = left + 'px';
    wrap.style.top = rect.top + 'px';
  }

  /* the hover pill: one at a time, gone as soon as the mouse moves on */
  showPill(row) {
    this.hidePill();
    this.pill = this.buildPill(row, false);
  }

  hidePill() {
    if (this.pill) {
      this.pill.remove();
      this.pill = null;
    }
  }

  /* the reveal command's pill: same look, but it is tied to the FILE, not to a spot on the
     screen. it remembers the note's path and, every frame, goes to wherever that note's row
     is right now: scrolling, folding, resizing the sidebar or the card re-centring all just
     carry it along. it hides while the row is out of view (or its folder is folded) and comes
     back with it. it stays until you run another command, press esc, open another note,
     or click that note. it is its own pill, so hovering other rows never takes it away. */
  stickPill(row) {
    this.hideSticky();
    const wrap = this.buildPill(row, true);
    if (!wrap) return;
    this.sticky = wrap;
    this.stickyPath = row.dataset.path;

    let at = row;                       /* the row we are glued to; looked up again when the tree redraws */
    let lastTop = NaN;
    let lastLeft = NaN;
    const step = () => {
      if (this.sticky !== wrap) return;
      if (!at || !at.isConnected) {
        at = null;
        for (const root of this.roots) {
          const found = [...root.__ez.tree.querySelectorAll('.ez-row')]
            .find((r) => r.dataset.path === this.stickyPath);
          if (found && found.offsetParent) { at = found; break; }
        }
      }

      const name = at ? at.querySelector('.ez-name') : null;
      let shown = false;
      if (name) {
        const rect = name.getBoundingClientRect();
        const scroller = at.closest('.ez-scroll');
        const box = scroller ? scroller.getBoundingClientRect() : null;
        /* only while the whole row is inside the tree's own window: otherwise the pill would hang over the prompt */
        shown = rect.width > 0 && (!box || (rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1));
        if (shown && (rect.top !== lastTop || rect.left !== lastLeft)) {
          lastTop = rect.top;
          lastLeft = rect.left;
          wrap.style.height = rect.height + 'px';
          wrap.style.lineHeight = rect.height + 'px';
          this.placePill(wrap, rect);
        }
      }
      wrap.style.visibility = shown ? '' : 'hidden';
      this.stickyFrame = window.requestAnimationFrame(step);
    };
    this.stickyFrame = window.requestAnimationFrame(step);
  }

  hideSticky() {
    window.cancelAnimationFrame(this.stickyFrame);
    this.stickyPath = null;
    if (this.sticky) {
      this.sticky.remove();
      this.sticky = null;
    }
  }

  /* ── the shell ───────────────────────────────────────────────────── */

  say(msg, bad) {
    this.pending = null;   /* new output, or dismissing the line, cancels a waiting y/n question */
    for (const root of this.roots) {
      root.classList.remove('is-help');   /* any output puts the tree back */
      const out = root.__ez.out;
      out.textContent = msg || '';
      out.classList.toggle('is-bad', !!bad);
      out.classList.remove('is-ask');
      root.__ez.input.placeholder = PLACEHOLDER;
      out.scrollTop = 0;
    }
  }

  /* a y/n question asked in the prompt itself, with no popup. the next line you
     enter is the answer: y or yes goes ahead, anything else (even just enter) cancels. */
  ask(msg, onYes, label) {
    this.say(msg);
    for (const root of this.roots) {
      root.__ez.out.classList.add('is-ask');
      root.__ez.input.placeholder = 'y / n';
    }
    this.pending = { onYes, label };
  }

  /* the help page replaces the tree until closed (esc, ×, or any other command) */
  openHelp() {
    for (const root of this.roots) {
      const page = root.__ez.help;
      page.replaceChildren(buildHelp(() => this.say('')));
      root.classList.add('is-help');
      page.scrollTop = 0;
    }
  }

  async run(line) {
    const text = line.trim();

    if (this.pending) {
      const { onYes, label } = this.pending;
      this.say('');
      if (!/^(y|yes)$/i.test(text)) {
        this.say(label + ': cancelled');
        return;
      }
      try {
        await onYes();
      } catch (e) {
        this.say(label + ': ' + (e && e.message ? e.message : e), true);
      }
      return;
    }

    if (!text) return;
    this.hideSticky();
    this.history.push(text);

    const [cmd, ...args] = tokenize(text);
    const rest = args.join(' ');
    this.say('');

    try {
      switch (cmd) {
        case 'touch': await this.cmdTouch(rest); break;
        case 'mkdir': await this.cmdMkdir(rest); break;
        case 'rename': await this.cmdRename(args); break;
        case 'mv': await this.cmdMv(args); break;
        case 'cp': await this.cmdCp(args); break;
        case 'rm':
        case 'delete': await this.cmdRm(args); break;
        case 'sort': this.cmdSort(rest); break;
        case 'reveal': this.cmdReveal(); break;
        case 'collapse': this.open.clear(); this.renderAll(); this.persist(); break;
        case 'expand': this.cmdExpand(); break;
        case 'clear': break;
        case 'help': this.openHelp(); break;
        default:
          this.say('zsh: command not found: ' + cmd + '   (try: help)', true);
      }
    } catch (e) {
      this.say(cmd + ': ' + (e && e.message ? e.message : e), true);
    }
  }

  /* tab: completes a command name, or the file name being typed */
  complete(input) {
    const value = input.value;
    const sp = value.search(/\s/);

    if (sp < 0) {
      if (!value) return;
      const hits = COMMANDS.filter((c) => c.startsWith(value));
      if (hits.length === 1) input.value = hits[0] + ' ';
      else if (hits.length > 1) {
        input.value = commonPrefix(hits);
        this.say(hits.join('   '));
      }
      return;
    }

    const cmd = value.slice(0, sp);
    if (!PATH_CMDS.has(cmd)) return;
    const rest = value.slice(sp + 1);

    /* where does the name being typed start? after the last space that isn't
       inside quotes (single-name commands may contain spaces, so only quotes count there) */
    let start = 0;
    let quote = '';
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        start = i;
      } else if (ch === ' ' && MULTI_CMDS.has(cmd)) {
        start = i + 1;
      }
    }

    const before = rest.slice(0, start);
    let token = rest.slice(start);
    const opened = /^["']/.test(token) ? token[0] : '';
    if (opened) token = token.slice(1);

    const slash = token.lastIndexOf('/');
    const dirPart = slash < 0 ? '' : token.slice(0, slash + 1);
    const base = token.slice(slash + 1).toLowerCase();

    const dir = dirPart ? this.app.vault.getAbstractFileByPath(this.joinPath(dirPart)) : this.app.vault.getRoot();
    if (!(dir instanceof TFolder)) return;

    const hits = sorted(dir, 'name', this.settings.groupDirsFirst).filter((n) => n.name.toLowerCase().startsWith(base));
    if (!hits.length) return;

    const names = hits.map((n) => n.name + (n instanceof TFolder ? '/' : ''));
    const unique = hits.length === 1;
    const completed = dirPart + (unique ? names[0] : commonPrefix(names));
    if (!unique) this.say(names.join('   '));

    /* two-name commands need quotes round names with spaces */
    const quoteChar = opened || (MULTI_CMDS.has(cmd) && /\s/.test(completed) ? '"' : '');
    const closing = unique && quoteChar && !(hits[0] instanceof TFolder) ? quoteChar : '';
    input.value = cmd + ' ' + before + quoteChar + completed + closing;
  }

  /* resolves ../, ~/ and plain names, always from the vault root */
  joinPath(p) {
    const parts = [];
    for (const seg of p.replace(/^[~/]+/, '').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }

  /* finds an existing thing by exact path; foo finds foo.md */
  lookup(p) {
    const vault = this.app.vault;
    const full = this.joinPath(p || '');
    if (!full) return vault.getRoot();
    for (const cand of [full, full + '.md']) {
      const found = vault.getAbstractFileByPath(cand);
      if (found) return found;
    }
    return null;
  }

  async ensureFolder(path) {
    if (!path) return;
    let cur = '';
    for (const part of path.split('/')) {
      cur = cur ? cur + '/' + part : part;
      const found = this.app.vault.getAbstractFileByPath(cur);
      if (!found) await this.app.vault.createFolder(cur);
      else if (!(found instanceof TFolder)) throw new Error(cur + ': not a directory');
    }
  }

  /* open every ancestor so a new or moved thing is actually visible */
  openParents(path) {
    for (let p = parentOf(path); p; p = parentOf(p)) this.open.add(p);
    this.persist();
  }

  /* after a rename or move: keep fold state pointing at the new path */
  remap(from, to) {
    const fix = (p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
    this.open = new Set([...this.open].map(fix));
    this.persist();
    this.renderAll();
  }

  async cmdTouch(rest) {
    let path = this.joinPath(rest);
    if (!path) throw new Error('usage: touch <name>');
    if (!hasExt(path)) path += '.md';
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(path + ': already exists');

    await this.ensureFolder(parentOf(path));
    const file = await this.app.vault.create(path, '');
    this.openParents(path);
    this.say('touch: ' + path);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async cmdMkdir(rest) {
    const path = this.joinPath(rest);
    if (!path) throw new Error('usage: mkdir <name>');
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(path + ': already exists');

    await this.ensureFolder(path);
    this.openParents(path);
    this.say('mkdir: ' + path);
  }

  /* rename "<new name>"  → the open note;  rename "<from>" "<new name>"  → any file */
  async cmdRename(args) {
    if (args.length > 2) {
      throw new Error('too many names. quote names with spaces:  rename "old name" "new name"');
    }

    let src;
    let name;
    if (args.length === 1) {
      src = this.app.workspace.getActiveFile();
      name = args[0];
      if (!src) throw new Error('no note is open.  use:  rename "<folder>/<old>" "<new name>"');
    } else if (args.length === 2) {
      src = this.lookup(args[0]);
      name = args[1];
      if (!src) throw new Error(args[0] + ': no such file or directory');
    } else {
      throw new Error('usage: rename "<new name>"   or   rename "<folder>/<old>" "<new name>"');
    }

    if (src === this.app.vault.getRoot()) throw new Error('refusing to rename the vault root');
    if (name.includes('/')) throw new Error('the new name is just a name, no /.  put the folder in the first part:  rename \"ideas/old\" \"new name\"   (mv moves things)');
    if (src instanceof TFile && src.extension
        && !name.toLowerCase().endsWith('.' + src.extension.toLowerCase())) {
      name += '.' + src.extension;
    }

    const from = src.path;
    const dir = src.parent && !src.parent.isRoot() ? src.parent.path + '/' : '';
    const dest = dir + name;
    if (dest === from) throw new Error('that is already its name');
    if (this.app.vault.getAbstractFileByPath(dest)) throw new Error(dest + ': already exists');

    await this.app.fileManager.renameFile(src, dest);   /* updates links to it, too */
    this.remap(from, dest);
    this.say('rename: ' + from + ' → ' + dest);
  }

  async cmdMv(args) {
    if (args.length !== 2) throw new Error('usage: mv "<from>" "<to>"   (to rename, use: rename)');
    const src = this.lookup(args[0]);
    if (!src) throw new Error(args[0] + ': no such file or directory');
    if (src === this.app.vault.getRoot()) throw new Error('refusing to move the vault root');

    const from = src.path;
    let dest = this.joinPath(args[1]);
    const existing = dest ? this.app.vault.getAbstractFileByPath(dest) : this.app.vault.getRoot();

    if (existing instanceof TFolder) dest = (existing.isRoot() ? '' : existing.path + '/') + src.name;
    else if (existing) throw new Error(dest + ': already exists');
    else if (src instanceof TFile && !hasExt(dest)) dest += '.' + src.extension;

    await this.ensureFolder(parentOf(dest));
    await this.app.fileManager.renameFile(src, dest);
    this.remap(from, dest);
    this.openParents(dest);
    this.say('mv: ' + from + ' → ' + dest);
  }

  /* cp  → copy the open note;  cp "<from>"  → copy beside it;  cp "<from>" "<to>"  → copy there */
  async cmdCp(args) {
    if (args.length > 2) throw new Error('too many names. quote names with spaces:  cp "from" "to"');

    const src = args.length ? this.lookup(args[0]) : this.app.workspace.getActiveFile();
    if (!src) throw new Error(args.length ? args[0] + ': no such file' : 'no note is open');
    if (!(src instanceof TFile)) throw new Error('only notes and files can be copied');

    const ext = src.extension ? '.' + src.extension : '';
    let dest;

    if (args.length < 2) {
      /* "name 1.md", "name 2.md", ... next to the original */
      const dir = src.parent && !src.parent.isRoot() ? src.parent.path + '/' : '';
      let n = 1;
      do {
        dest = dir + src.basename + ' ' + n + ext;
        n++;
      } while (this.app.vault.getAbstractFileByPath(dest));
    } else {
      dest = this.joinPath(args[1]);
      const existing = dest ? this.app.vault.getAbstractFileByPath(dest) : this.app.vault.getRoot();
      if (existing instanceof TFolder) dest = (existing.isRoot() ? '' : existing.path + '/') + src.name;
      else if (existing) throw new Error(dest + ': already exists');
      else if (ext && !dest.toLowerCase().endsWith(ext.toLowerCase())) dest += ext;
    }

    await this.ensureFolder(parentOf(dest));
    await this.app.vault.copy(src, dest);
    this.openParents(dest);
    this.say('cp: ' + src.path + ' → ' + dest);
  }

  /* rm <name>   (rm -r <folder> when it still has things in it, rm -f skips the question) */
  async cmdRm(args) {
    const flags = args.filter((a) => /^-/.test(a));
    const recursive = flags.some((a) => /r/i.test(a));
    const force = flags.some((a) => /f/i.test(a));
    const rest = args.filter((a) => !/^-/.test(a)).join(' ');
    if (!rest) throw new Error('usage: rm <name>     (rm -r <folder> for a folder with things in it)');

    const item = this.lookup(rest);
    if (!item) throw new Error(rest + ': no such file or directory');
    if (item === this.app.vault.getRoot()) throw new Error('refusing to remove the vault root');
    if (item instanceof TFolder && item.children.length && !recursive) {
      throw new Error(item.path + ' is not empty. to delete it and everything in it:  rm -r "' + item.path + '"');
    }

    const path = item.path;
    const trash = async () => {
      const again = this.app.vault.getAbstractFileByPath(path);   /* it may have changed while the question waited */
      if (!again) throw new Error(path + ': no such file or directory');
      await this.app.vault.trash(again, true);   /* true = the system trash, not obsidian's */
      for (const p of [...this.open]) {
        if (p === path || p.startsWith(path + '/')) this.open.delete(p);
      }
      this.persist();
      this.renderAll();
      this.say('rm: ' + path + ' → system trash');
    };

    if (force || this.settings.confirmRm === false) {
      await trash();
      return;
    }

    const inside = item instanceof TFolder ? countInside(item) : 0;
    const extra = inside ? ' and ' + inside + (inside === 1 ? ' item' : ' items') + ' inside' : '';
    this.ask('rm: send "' + path + '"' + extra + ' to the system trash?  [y/N]', trash, 'rm');
  }

  cmdSort(rest) {
    let key = rest;
    if (!key) key = SORTS[(SORTS.indexOf(this.sortKey) + 1) % SORTS.length];
    if (!SORTS.includes(key)) throw new Error('usage: sort [' + SORTS.join('|') + ']');

    this.sortKey = key;
    this.renderAll();
    this.persist();
    this.say('sorted by ' + key);
  }

  cmdReveal(block = 'center', pill = block === 'center') {
    const file = this.app.workspace.getActiveFile();
    if (!file) throw new Error('no note is open');

    this.openParents(file.path);
    this.renderAll();
    let target = null;
    for (const root of this.roots) {
      const row = [...root.__ez.tree.querySelectorAll('.ez-row')]
        .find((r) => r.dataset.path === file.path);
      if (!row) continue;
      row.scrollIntoView({ block });
      if (!target && row.offsetParent) target = row;     /* the panel you can actually see */
    }

    /* the command and "follow the open note" both get the pill; it stays quiet only when
       hover pills are switched off in the settings */
    if (pill && target && this.settings.show.reveal !== false) this.pinPill(target);
  }

  /* the reveal command: the note it jumped to wears the same colour pill as a hovered name,
     glued to that note (see stickPill) until you run something else, press esc or open another note */
  pinPill(row) {
    this.stickPill(row);
  }

  cmdExpand() {
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder && !f.isRoot()) this.open.add(f.path);
    }
    this.renderAll();
    this.persist();
  }

  persist() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveAll(), 500);
  }

  async saveAll() {
    await this.saveData({ v: 2, settings: this.settings, open: [...this.open], sort: this.sortKey });
  }

  tick() {
    const d = new Date();
    const { hour12, seconds } = this.settings.clock;
    const h = d.getHours();
    const text = '\uF43A ' + pad(hour12 ? h % 12 || 12 : h) + ':' + pad(d.getMinutes()) +
      (seconds ? ':' + pad(d.getSeconds()) : '') + (hour12 ? (h >= 12 ? ' pm' : ' am') : '');

    for (const root of this.roots) {
      const refs = root.__ez;
      if (refs && refs.clock && refs.clock.textContent !== text) refs.clock.textContent = text;
    }
  }
};
