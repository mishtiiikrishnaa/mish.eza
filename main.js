'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   mish-eza
   a starship prompt + `eza --tree --all --level=99 .` that actually IS the
   file explorer: real ├── └── │ lines, click to open/fold.
   - colours follow the prompt pills, one colour per depth
   - a little shell at the bottom (type commands, or click them) replaces
     the explorer's button pills. tab completes names.
       touch mkdir rename mv cp rm/delete sort reveal collapse expand help
     it is not a real shell: the words are mapped onto obsidian's own vault
     api. nothing is ever sent to the operating system, and nothing is run.
   - the prompt grows a git branch when the vault is a git repository
   - everything (prompt, tree and the shell line) sits in one bordered card,
     the same box mish.fastfetch draws: it hugs its content and centres itself
   the old explorer is only hidden; "toggle native file explorer" brings it back.
   ═══════════════════════════════════════════════════════════════════════ */

const { Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile, Menu, Keymap, Platform, setIcon } = require('obsidian');

/* node's `os` module is how the prompt finds your username.
   it only exists on desktop, which is why the manifest says isDesktopOnly. */
let nodeOs = null;
try { nodeOs = require('os'); } catch (e) { nodeOs = null; }

const pad = (n) => String(n).padStart(2, '0');

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};


const DEFAULT_SETTINGS = {
  username: '',          /* empty = auto-detect */
  font: 'bundled',       /* bundled | obsidian | system | family:<name> | custom */
  customFont: '',
  groupDirsFirst: true,  /* like `eza --group-directories-first` */
  pills: { user: true, vault: true, git: true, time: true },
  show: { command: true, keys: true },
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
      sb.style.display = 'none';
      return;
    }
    sb.style.display = 'block';
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
  ['reveal', 'jump to the open note in the tree'],
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
      ['<name>', 'send a file to the system trash. delete works the same', 'rm "ideas/old"'],
      ['-r <name>', 'also needed for a folder that still has things inside', 'rm -r ideas'],
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
    { cmd: 'reveal', c: 0, forms: [['', 'jump to the note you have open']] },
    { cmd: 'collapse', c: 1, forms: [['', 'fold every folder']] },
    { cmd: 'expand', c: 2, forms: [['', 'unfold every folder']] },
  ] },
  { title: 'keys', items: [
    { cmd: 'enter', c: 3, forms: [['', 'run what you typed']] },
    { cmd: 'tab', c: 4, forms: [['', 'finish a name or command for you']] },
    { cmd: '↑ ↓', c: 5, forms: [['', 'bring back earlier commands']] },
    { cmd: 'esc', c: 0, forms: [['', 'empty the prompt, or close this guide']] },
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

const sorted = (folder, key, groupDirs = true) => [...folder.children].sort((a, b) => {
  const af = a instanceof TFolder;
  const bf = b instanceof TFolder;
  if (groupDirs && af !== bf) return af ? -1 : 1;

  if (!af && !bf) {
    const sa = a.stat || {};
    const sb = b.stat || {};
    if (key === 'mtime' && sb.mtime !== sa.mtime) return sb.mtime - sa.mtime;   /* newest first */
    if (key === 'ctime' && sb.ctime !== sa.ctime) return sb.ctime - sa.ctime;
    if (key === 'size' && sb.size !== sa.size) return sb.size - sa.size;        /* biggest first */
    if (key === 'ext') {
      const c = (a.extension || '').localeCompare(b.extension || '');
      if (c) return c;
    }
  }
  return byName(a, b);
});

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
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';

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
      stop.style.stopColor = 'var(' + name + ', ' + fallback + ')';
      grad.appendChild(stop);
    });

    defs.appendChild(grad);
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }
  svg.dataset.users = String(Number(svg.dataset.users || 0) + 1);
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

    const flag = (group, key, name, desc, after) => new Setting(containerEl)
      .setName(name)
      .setDesc(desc || '')
      .addToggle((toggle) => toggle
        .setValue(Boolean(s[group][key]))
        .onChange(async (value) => {
          s[group][key] = value;
          await plugin.saveSettings();
          if (after) await after(value);
        }));

    /* ── who you are ── */
    new Setting(containerEl).setName('identity').setHeading();

    new Setting(containerEl)
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
    new Setting(containerEl).setName('prompt').setHeading();
    flag('pills', 'user', 'user pill', 'your name, with a logo for your operating system.');
    flag('pills', 'vault', 'vault pill', 'the name of this vault.');
    flag('pills', 'git', 'git pill', 'the current branch, when this vault is a git repository. it reads the file .git/HEAD in the vault folder and nothing else.',
      () => plugin.probe());
    flag('pills', 'time', 'time pill', 'the time of day.');

    /* ── the tree ── */
    new Setting(containerEl).setName('tree').setHeading();
    new Setting(containerEl)
      .setName('folders first')
      .setDesc('list folders before files, like eza --group-directories-first.')
      .addToggle((toggle) => toggle
        .setValue(s.groupDirsFirst)
        .onChange(async (value) => {
          s.groupDirsFirst = value;
          await plugin.saveSettings();
          plugin.renderAll();
        }));

    /* ── the shell ── */
    new Setting(containerEl).setName('shell').setHeading();
    flag('show', 'command', 'command line', 'the line that says eza --tree --all, and the dot under it.');
    flag('show', 'keys', 'clickable commands', 'the row of command names you can click (touch, mkdir, rename and so on). you can still type them.');

    /* ── font ── */
    new Setting(containerEl).setName('appearance').setHeading();

    const choices = () => {
      const opts = {
        bundled: 'cmu typewriter (bundled)',
        obsidian: "obsidian's monospace font",
        system: 'system monospace',
      };
      const names = new Set(CANDIDATE_FONTS.filter((n) => isInstalled(n)));
      this.scanned.forEach((n) => names.add(n));
      if (s.font.indexOf('family:') === 0) names.add(s.font.slice(7));
      Array.from(names)
        .sort((a, b) => a.localeCompare(b))
        .forEach((n) => { opts['family:' + n] = n; });
      opts.custom = 'custom…';
      return opts;
    };

    let custom = null;

    new Setting(containerEl)
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

    custom = new Setting(containerEl)
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

    new Setting(containerEl)
      .setName('find monospace fonts')
      .setDesc("adds every monospace font installed on this computer to the menu above. obsidian may ask for permission first. if this version can't do it, the menu still lists the common fonts it finds.")
      .addButton((button) => button
        .setButtonText('scan')
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const list = await scanSystemFonts();
            if (!list) {
              new Notice("this version of obsidian can't list system fonts. use a custom font instead.");
            } else {
              this.scanned = list;
              this.fontDropdown.selectEl.empty();
              this.fontDropdown.addOptions(choices());
              this.fontDropdown.setValue(s.font);
              new Notice('found ' + list.length + ' monospace fonts.');
            }
          } catch (e) {
            new Notice('could not read the font list. use a custom font instead.');
          }
          button.setDisabled(false);
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
    this.detected = detectIdentity();

    /* data.json holds the settings, the folded folders and the sort order */
    const saved = (await this.loadData()) || {};
    const savedSettings = saved.settings || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings, {
      pills: Object.assign({}, DEFAULT_SETTINGS.pills, savedSettings.pills),
      show: Object.assign({}, DEFAULT_SETTINGS.show, savedSettings.show),
    });
    this.open = new Set(saved.open || []);
    this.sortKey = SORTS.includes(saved.sort) ? saved.sort : 'name';

    this.addSettingTab(new EzaSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.ensure();
      this.probe();
    });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.ensure()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.ensure()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.markActive()));

    /* the tree follows the vault */
    const bump = () => {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = window.setTimeout(() => this.renderAll(), 150);
    };
    for (const ev of ['create', 'delete', 'rename']) {
      this.registerEvent(this.app.vault.on(ev, bump));
    }

    /* keeps the clock ticking and re-mounts if the explorer is rebuilt */
    this.registerInterval(window.setInterval(() => {
      this.ensure();
      this.tick();
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
    if (pills.vault) segs.push(['ez-path', '~/' + this.app.vault.getName()]);
    if (pills.git && this.branch) segs.push(['ez-git', this.branch, true]);
    if (pills.time) {
      if (segs.length) segs.push(['ez-ch', '']);   /* the arrow that bridges to the clock */
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

    refs.cmd.hidden = !show.command;
    refs.dot.hidden = !show.command;
    refs.keys.hidden = !show.keys;
    if (refs.fit) refs.fit();
  }

  /* settings changed: redraw what depends on them, in place */
  applySettings() {
    for (const root of this.roots) {
      this.drawBar(root);
      this.applyLook(root);
    }
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
    input.placeholder = 'type a command · help';
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
      try { paintLine(hlIn, input.value, (p) => this.lookup(p)); } catch (e) { hlIn.textContent = input.value; }
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
      wrap.classList.toggle('is-focus', document.activeElement === input);
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
    const kids = sorted(folder, this.sortKey, this.settings.groupDirsFirst);
    const depth = guides.length;
    const colour = 'ez-c' + (depth % COLOURS);

    kids.forEach((node, i) => {
      const last = i === kids.length - 1;
      const isDir = node instanceof TFolder;

      const row = el('div', 'ez-row');
      row.dataset.path = node.path;

      guides.forEach((g, j) => {
        row.appendChild(el('span', 'ez-cell ez-c' + (j % COLOURS) + (g ? ' ez-v' : '')));
      });
      row.appendChild(el('span', 'ez-cell ' + colour + ' ' + (last ? 'ez-l' : 'ez-t')));

      const name = el('span', 'ez-name ' + colour + (isDir ? ' ez-dir' : ''));
      name.appendChild(el('span', 'ez-fold', isDir ? (this.open.has(node.path) ? '-' : '+') : ''));
      name.appendChild(document.createTextNode(node.name));
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

  /* ── the shell ───────────────────────────────────────────────────── */

  say(msg, bad) {
    for (const root of this.roots) {
      root.classList.remove('is-help');   /* any output puts the tree back */
      const out = root.__ez.out;
      out.textContent = msg || '';
      out.classList.toggle('is-bad', !!bad);
      out.scrollTop = 0;
    }
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
    if (!text) return;
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

  /* rm <name>   (rm -r <folder> when it still has things in it) */
  async cmdRm(args) {
    const recursive = args.some((a) => /^-/.test(a) && /r/i.test(a));
    const rest = args.filter((a) => !/^-/.test(a)).join(' ');
    if (!rest) throw new Error('usage: rm <name>     (rm -r <folder> for a folder with things in it)');

    const item = this.lookup(rest);
    if (!item) throw new Error(rest + ': no such file or directory');
    if (item === this.app.vault.getRoot()) throw new Error('refusing to remove the vault root');
    if (item instanceof TFolder && item.children.length && !recursive) {
      throw new Error(item.path + ' is not empty. to delete it and everything in it:  rm -r "' + item.path + '"');
    }

    const path = item.path;
    await this.app.vault.trash(item, true);   /* true = the system trash, not obsidian's */
    for (const p of [...this.open]) {
      if (p === path || p.startsWith(path + '/')) this.open.delete(p);
    }
    this.persist();
    this.renderAll();
    this.say('rm: ' + path + ' → system trash');
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

  cmdReveal() {
    const file = this.app.workspace.getActiveFile();
    if (!file) throw new Error('no note is open');

    this.openParents(file.path);
    this.renderAll();
    for (const root of this.roots) {
      const row = [...root.__ez.tree.querySelectorAll('.ez-row')]
        .find((r) => r.dataset.path === file.path);
      if (row) row.scrollIntoView({ block: 'center' });
    }
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
    await this.saveData({ settings: this.settings, open: [...this.open], sort: this.sortKey });
  }

  tick() {
    const d = new Date();
    const text = '\uF43A ' + pad(d.getHours()) + ':' + pad(d.getMinutes());

    for (const root of this.roots) {
      const refs = root.__ez;
      if (refs && refs.clock && refs.clock.textContent !== text) refs.clock.textContent = text;
    }
  }
};
