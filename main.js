'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   mish.eza
   a starship prompt + `eza --tree --all --level=99 .` that actually IS the
   file explorer: real ├── └── │ lines, click to open/fold.
   - colours follow the prompt pills, one colour per depth
   - a little shell at the bottom (type commands, or click them) replaces
     the explorer's button pills. tab completes names.
       touch mkdir rename mv cp rm/delete sort reveal collapse expand clear help
   - the prompt grows a git branch and node version when it can find them
   the old explorer is only hidden; "toggle native file explorer" brings it back.
   ═══════════════════════════════════════════════════════════════════════ */

const { Plugin, TFolder, TFile, Menu, Keymap, Platform } = require('obsidian');

const pad = (n) => String(n).padStart(2, '0');

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

/* like `eza --group-directories-first`. set to false for plain a-z */
const GROUP_DIRS_FIRST = true;

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
  ['rename', 'rename the open note: click, then type the new name'],
  ['cp', 'copy the open note'],
  ['delete', 'delete to the system trash: click, then type a name'],
  ['sort', 'cycle the sort order'],
  ['reveal', 'find the open note in the tree'],
  ['collapse', 'fold every folder'],
  ['expand', 'unfold every folder'],
  ['clear', 'clear this output'],
  ['help', 'what every command does'],
];

/* what `help` shows: a full page that takes the tree's place until you close it.
   sections of entries; each entry = command, pill colour index (matches KEYS),
   forms as [arguments, description], and an optional key table (sort) */
const HELP = [
  { title: 'files', items: [
    { cmd: 'touch', c: 0, forms: [['<name>', 'new note, .md added · touch ideas/new']] },
    { cmd: 'mkdir', c: 1, forms: [['<name>', 'new folder · mkdir ideas']] },
    { cmd: 'rename', c: 2, forms: [
      ['"<new name>"', 'rename the note you have open'],
      ['"<from>" "<new name>"', 'rename any file, it stays in its folder'],
    ] },
    { cmd: 'mv', c: 3, forms: [['"<from>" "<to>"', 'move a file or folder into another folder']] },
    { cmd: 'cp', c: 4, forms: [['[<from>] [<to>]', 'copy · no names = copy the open note']] },
    { cmd: 'rm', c: 5, forms: [
      ['<name>', 'delete to the system trash (or: delete)'],
      ['-r <name>', 'needed for a folder that isn\'t empty'],
    ] },
  ] },
  { title: 'tree', items: [
    { cmd: 'sort', c: 0,
      forms: [['[key]', 'order the tree · no key = the next one down']],
      keys: [
        ['name', 'a to z (the default)'],
        ['mtime', 'recently edited first'],
        ['ctime', 'recently created first'],
        ['size', 'biggest files first'],
        ['ext', 'grouped by extension'],
      ] },
    { cmd: 'reveal', c: 1, forms: [['', 'scroll the tree to the note you have open']] },
    { cmd: 'collapse', c: 2, forms: [['', 'fold every folder']] },
    { cmd: 'expand', c: 3, forms: [['', 'unfold every folder']] },
  ] },
  { title: 'shell', items: [
    { cmd: 'clear', c: 4, forms: [['', 'wipe the output line']] },
    { cmd: 'tab', c: 5, forms: [['', 'complete file and command names']] },
    { cmd: '↑ ↓', c: 0, forms: [['', 'walk through what you typed before']] },
    { cmd: 'esc', c: 1, forms: [['', 'clear the prompt, or close this page']] },
  ] },
];

/* builds the help page as real elements so everything lines up in columns */
const buildHelp = (close) => {
  const page = document.createDocumentFragment();

  /* sticky header: title dead centre, close button on the right */
  const head = el('div', 'ez-h-head');
  head.appendChild(el('span', 'ez-h-side'));
  head.appendChild(el('span', 'ez-h-title', 'help'));
  const x = el('span', 'ez-h-close ez-h-side', '✕');
  x.title = 'back to the tree (esc)';
  x.addEventListener('click', close);
  head.appendChild(x);
  page.appendChild(head);

  page.appendChild(el('div', 'ez-h-note', 'type below, or click the coloured words'));

  HELP.forEach((section) => {
    page.appendChild(el('div', 'ez-h-section', section.title));

    const grid = el('div', 'ez-h-grid');
    section.items.forEach((h, n) => {
      h.forms.forEach(([args, desc], i) => {
        const first = i === 0 && n > 0 ? ' is-first' : '';
        const name = el('div', 'ez-h-cmd ez-c' + h.c + first, i === 0 ? h.cmd : '');
        const body = el('div', 'ez-h-body' + first);
        if (args) body.appendChild(el('div', 'ez-h-args', args));
        body.appendChild(el('div', 'ez-h-desc', desc));

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

const sorted = (folder, key) => [...folder.children].sort((a, b) => {
  const af = a instanceof TFolder;
  const bf = b instanceof TFolder;
  if (GROUP_DIRS_FIRST && af !== bf) return af ? -1 : 1;

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

module.exports = class MishEza extends Plugin {
  async onload() {
    mountRainbow();
    this.roots = new Set();
    this.branch = null;
    this.node = null;
    this.showNative = false;
    this.history = [];

    const saved = (await this.loadData()) || {};
    this.open = new Set(saved.open || []);
    this.sortKey = SORTS.includes(saved.sort) ? saved.sort : 'name';

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
      name: 'Re-draw eza header',
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

  /* ── prompt extras: git branch + node version, only if they exist ── */

  async probe() {
    try {
      const head = (await this.app.vault.adapter.read('.git/HEAD')).trim();
      const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      this.branch = m ? m[1] : head.slice(0, 7);
    } catch (e) {
      this.branch = null;
    }

    try {
      if (Platform.isDesktopApp) {
        const { execFile } = require('child_process');
        const shell = (typeof process !== 'undefined' && process.env && process.env.SHELL) || '/bin/zsh';
        /* login shell, so homebrew / nvm paths are found */
        const out = await new Promise((resolve) => {
          execFile(shell, ['-lc', 'node -v'], { timeout: 4000 }, (err, stdout) => {
            resolve(err ? null : String(stdout).trim().split('\n').pop());
          });
        });
        this.node = out && /^v\d/.test(out) ? out : null;
      }
    } catch (e) {
      this.node = null;
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
    const scroll = el('div', 'ez-scroll');   /* header + tree scroll; the shell stays put */
    root.appendChild(scroll);

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
    scroll.appendChild(el('div', 'ez-dot', '.'));

    const tree = el('div', 'ez-tree');
    scroll.appendChild(tree);

    const help = el('div', 'ez-helppage');   /* shown instead of the tree while help is open */
    root.appendChild(help);

    const foot = this.buildFoot(root);
    root.appendChild(foot.node);

    root.__ez = { bar, tree, arg, help, clock: null, input: foot.input, out: foot.out };
    this.drawBar(root);
    this.bind(root, tree);
    return root;
  }

  /* powerline prompt; git / node segments appear only when found */
  drawBar(root) {
    const refs = root.__ez;
    refs.bar.replaceChildren();

    const segs = [
      ['ez-user', '\uF179 mishti'],
      ['ez-path', '~/' + this.app.vault.getName()],
    ];
    if (this.branch) segs.push(['ez-git', '\uE0A0 ' + this.branch]);
    if (this.node) segs.push(['ez-node', '\uE718 ' + this.node]);
    segs.push(['ez-ch', '']);
    segs.push(['ez-clock', '']);

    segs.forEach(([cls, text], i) => {
      const seg = el('span', 'ez-seg ' + cls, text);
      seg.style.zIndex = String(segs.length - i);   /* arrow tips overlap the next segment */
      refs.bar.appendChild(seg);
      if (cls === 'ez-clock') refs.clock = seg;
    });

    this.tick();
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
    line.appendChild(input);
    node.appendChild(line);

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

    return { node, input, out };
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
    const kids = sorted(folder, this.sortKey);
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

  /* the help page replaces the tree until closed (esc, ✕, or any other command) */
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

    const hits = sorted(dir, 'name').filter((n) => n.name.toLowerCase().startsWith(base));
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
      if (!src) throw new Error('no note is open.  use:  rename "<from>" "<new name>"');
    } else if (args.length === 2) {
      src = this.lookup(args[0]);
      name = args[1];
      if (!src) throw new Error(args[0] + ': no such file or directory');
    } else {
      throw new Error('usage: rename "<new name>"   or   rename "<from>" "<new name>"');
    }

    if (src === this.app.vault.getRoot()) throw new Error('refusing to rename the vault root');
    if (name.includes('/')) throw new Error('a new name can\'t contain /   (use mv to move things)');
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
    this.saveTimer = window.setTimeout(
      () => this.saveData({ open: [...this.open], sort: this.sortKey }),
      500
    );
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
