'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   mish.eza
   a starship prompt + `eza --tree --all --level=99 .` that actually IS the
   file explorer: real ├── └── │ lines, click to open/fold.
   - colours follow the prompt pills, one colour per depth
   - a little shell at the bottom (type commands, or click them) replaces
     the explorer's button pills: touch mkdir rm mv cd pwd sort reveal
     collapse expand clear help
   - the prompt grows a git branch and node version when it can find them
   the old explorer is only hidden; "toggle native file explorer" brings it back.
   ═══════════════════════════════════════════════════════════════════════ */

const { Plugin, Modal, TFolder, TFile, Menu, Keymap, Platform } = require('obsidian');

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

/* the clickable "aliases" above the prompt, in pill-colour order */
const KEYS = [
  ['touch', 'new note: click, then type a name'],
  ['mkdir', 'new folder: click, then type a name'],
  ['sort', 'cycle the sort order'],
  ['reveal', 'find the open note in the tree'],
  ['collapse', 'fold every folder'],
  ['expand', 'unfold every folder'],
];

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

/* "are you sure" for deleting a folder that still has things in it */
class ConfirmModal extends Modal {
  constructor(app, text, onYes) {
    super(app);
    this.text = text;
    this.onYes = onYes;
  }

  onOpen() {
    this.contentEl.createEl('p', { text: this.text });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: 'cancel' }).addEventListener('click', () => this.close());
    const yes = row.createEl('button', { text: 'move to trash', cls: 'mod-warning' });
    yes.addEventListener('click', () => {
      this.close();
      this.onYes();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* what `help` prints; two lines per command so it reads in a narrow sidebar */
const HELP = [
  'commands: type them below, or click the coloured ones.',
  'right-click any row for open / copy / rename / delete.',
  '',
  'touch <name>',
  '  new note, .md added.  touch ideas/new',
  'mkdir <name>',
  '  new folder.  mkdir ideas',
  'rm <name>   (or: delete)',
  '  delete: goes to obsidian\'s trash.',
  'mv <from> <to>   (or: rename)',
  '  rename or move. quote names with spaces:',
  '  mv "old name" "new name"',
  'cd <folder>',
  '  go into a folder; touch / mkdir then work',
  '  there. .. and ~ work too.',
  'pwd',
  '  print the current folder.',
  'sort [key]',
  '  name | mtime | ctime | size | ext. no key',
  '  cycles to the next one.',
  'reveal',
  '  find the open note in the tree.',
  'collapse / expand',
  '  fold or unfold every folder.',
  'clear',
  '  wipe this output.',
].join('\n');

module.exports = class MishEza extends Plugin {
  async onload() {
    mountRainbow();
    this.roots = new Set();
    this.branch = null;
    this.node = null;
    this.showNative = false;
    this.cwd = '';
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

    const foot = this.buildFoot(root);
    root.appendChild(foot.node);

    root.__ez = { bar, tree, arg, clock: null, input: foot.input, cwd: foot.cwd, out: foot.out };
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
    const cwd = el('span', 'ez-cwd', this.cwdLabel());
    line.appendChild(cwd);
    line.appendChild(el('span', 'ez-chev', '❯'));

    const input = el('input', 'ez-input');
    input.type = 'text';
    input.placeholder = 'type a command · help';
    input.spellcheck = false;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    line.appendChild(input);
    node.appendChild(line);

    /* enter runs, up/down walk the history, escape clears */
    let at = -1;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = input.value;
        input.value = '';
        at = -1;
        this.run(value);
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
        input.blur();
      }
    });

    return { node, input, cwd, out };
  }

  /* clicking a command: names need typing, everything else just runs */
  press(cmd, root) {
    if (cmd === 'touch' || cmd === 'mkdir') {
      const input = root.__ez.input;
      input.value = cmd + ' ';
      input.focus();
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
    root.__ez.cwd.textContent = this.cwdLabel();
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
      if (e.target.closest('.ez-rename')) return;
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

    root.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.ez-foot') || e.target.closest('.ez-rename')) return;   /* their own menus */
      e.preventDefault();
      const row = e.target.closest('.ez-row');
      const item = row ? this.app.vault.getAbstractFileByPath(row.dataset.path) : null;
      const menu = new Menu();
      const ws = this.app.workspace;

      if (item instanceof TFile) {
        menu.addItem((i) => i.setTitle('Open in new tab').setIcon('file-plus')
          .onClick(() => ws.getLeaf('tab').openFile(item)));
        menu.addItem((i) => i.setTitle('Open to the right').setIcon('separator-vertical')
          .onClick(() => ws.getLeaf('split', 'vertical').openFile(item)));
        menu.addSeparator();
        menu.addItem((i) => i.setTitle('Make a copy').setIcon('copy')
          .onClick(() => this.guard('copy', this.copyFile(item))));
        menu.addSeparator();
      } else if (item instanceof TFolder) {
        menu.addItem((i) => i.setTitle('New note').setIcon('edit')
          .onClick(() => this.guard('touch', this.create(item, 'note'))));
        menu.addItem((i) => i.setTitle('New folder').setIcon('folder-plus')
          .onClick(() => this.guard('mkdir', this.create(item, 'folder'))));
        menu.addSeparator();
      }

      if (item) {
        /* obsidian's own file menu: move, copy path, reveal in finder, etc.
           (rename and delete are added by the core explorer, not by this event,
           which is why we add them ourselves) */
        ws.trigger('file-menu', menu, item, 'file-explorer-context-menu');
        menu.addSeparator();
        menu.addItem((i) => i.setTitle('Rename…').setIcon('pencil')
          .onClick(() => this.startRename(item)));
        menu.addItem((i) => i.setTitle('Delete').setIcon('trash-2').setWarning(true)
          .onClick(() => this.confirmDelete(item)));
      } else {
        const vaultRoot = this.app.vault.getRoot();
        menu.addItem((i) => i.setTitle('New note').setIcon('edit')
          .onClick(() => this.guard('touch', this.create(vaultRoot, 'note'))));
        menu.addItem((i) => i.setTitle('New folder').setIcon('folder-plus')
          .onClick(() => this.guard('mkdir', this.create(vaultRoot, 'folder'))));
      }
      menu.showAtMouseEvent(e);
    });
  }

  /* runs an async action from a menu and reports failures in the shell */
  guard(label, promise) {
    return Promise.resolve(promise).catch((err) =>
      this.say(label + ': ' + (err && err.message ? err.message : err), true));
  }

  /* inline rename: the row's name turns into a text box */
  startRename(item) {
    for (const root of this.roots) {
      const row = [...root.__ez.tree.querySelectorAll('.ez-row')]
        .find((r) => r.dataset.path === item.path);
      if (!row) continue;

      const name = row.querySelector('.ez-name');
      const input = el('input', 'ez-rename');
      input.type = 'text';
      input.value = item.name;
      input.spellcheck = false;
      name.style.display = 'none';
      row.appendChild(input);

      const born = Date.now();
      window.setTimeout(() => {
        input.focus();
        /* select the name, not the extension */
        const dot = item instanceof TFile && item.extension
          ? item.name.length - item.extension.length - 1
          : item.name.length;
        input.setSelectionRange(0, dot);
      }, 80);

      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        input.remove();
        name.style.display = '';
        if (!commit || !value || value === item.name) return;

        try {
          if (value.includes('/')) throw new Error('a name can\'t contain /  (use mv to move things)');
          const dir = item.parent && !item.parent.isRoot() ? item.parent.path + '/' : '';
          const dest = dir + value;
          if (this.app.vault.getAbstractFileByPath(dest)) throw new Error(value + ': already exists');
          const from = item.path;
          await this.app.fileManager.renameFile(item, dest);
          this.remap(from, dest);
          this.say('rename: ' + from + ' → ' + dest);
        } catch (err) {
          this.say('rename: ' + (err && err.message ? err.message : err), true);
        }
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      /* the menu closing can steal focus a moment after we take it; ignore that */
      input.addEventListener('blur', () => {
        if (Date.now() - born < 300) return;
        finish(false);
      });
      return;
    }
  }

  confirmDelete(item) {
    if (item instanceof TFolder && item.children.length) {
      new ConfirmModal(
        this.app,
        'move "' + item.path + '" and everything inside it to the trash?',
        () => this.guard('rm', this.doDelete(item))
      ).open();
    } else {
      this.guard('rm', this.doDelete(item));
    }
  }

  async doDelete(item) {
    const path = item.path;
    await this.app.fileManager.trashFile(item);   /* obsidian's own trash setting applies */
    if (this.cwd === path || this.cwd.startsWith(path + '/')) this.cwd = parentOf(path);
    this.say('rm: ' + path + ' → trash');
    this.renderAll();
  }

  async copyFile(file) {
    const dir = file.parent && !file.parent.isRoot() ? file.parent.path + '/' : '';
    const ext = file.extension ? '.' + file.extension : '';
    let n = 1;
    let path;
    do {
      path = dir + file.basename + ' ' + n + ext;
      n++;
    } while (this.app.vault.getAbstractFileByPath(path));
    await this.app.vault.copy(file, path);
    this.say('copy: ' + path);
  }

  /* after a rename or move: keep fold state and cwd pointing at the new path */
  remap(from, to) {
    const fix = (p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
    this.open = new Set([...this.open].map(fix));
    this.cwd = fix(this.cwd);
    this.persist();
    this.renderAll();
  }

  async create(folder, kind) {
    const isFolder = kind === 'folder';
    const base = isFolder ? 'untitled folder' : 'untitled';
    const dir = folder.isRoot() ? '' : folder.path + '/';

    let n = 0;
    let path;
    do {
      path = dir + base + (n ? ' ' + n : '') + (isFolder ? '' : '.md');
      n++;
    } while (this.app.vault.getAbstractFileByPath(path));

    if (!folder.isRoot()) {
      this.open.add(folder.path);
      this.persist();
    }
    if (isFolder) {
      await this.app.vault.createFolder(path);
    } else {
      const file = await this.app.vault.create(path, '');
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  /* ── the shell ───────────────────────────────────────────────────── */

  cwdLabel() {
    return '~' + (this.cwd ? '/' + this.cwd : '');
  }

  say(msg, bad) {
    for (const root of this.roots) {
      const out = root.__ez.out;
      out.textContent = msg || '';
      out.classList.toggle('is-bad', !!bad);
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
        case 'rm':
        case 'delete': await this.cmdRm(rest); break;
        case 'mv':
        case 'rename': await this.cmdMv(args); break;
        case 'cd': this.cmdCd(rest); break;
        case 'pwd': this.say(this.cwdLabel()); break;
        case 'sort': this.cmdSort(rest); break;
        case 'reveal': this.cmdReveal(); break;
        case 'collapse': this.open.clear(); this.renderAll(); this.persist(); break;
        case 'expand': this.cmdExpand(); break;
        case 'clear': break;
        case 'help': this.say(HELP); break;
        default:
          this.say('zsh: command not found: ' + cmd, true);
      }
    } catch (e) {
      this.say(cmd + ': ' + (e && e.message ? e.message : e), true);
    }
  }

  /* resolves ../, ~/ and plain names against the current directory */
  joinPath(base, p) {
    const parts = /^[~/]/.test(p) ? [] : base.split('/').filter(Boolean);
    for (const seg of p.replace(/^[~/]+/, '').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }

  /* finds an existing thing: relative to cwd first, then the vault root; foo finds foo.md */
  lookup(p) {
    const vault = this.app.vault;
    if (!p || p === '~') return vault.getRoot();

    for (const full of [this.joinPath(this.cwd, p), this.joinPath('', p)]) {
      if (!full) return vault.getRoot();
      for (const cand of [full, full + '.md']) {
        const found = vault.getAbstractFileByPath(cand);
        if (found) return found;
      }
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

  async cmdTouch(rest) {
    let path = this.joinPath(this.cwd, rest);
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
    const path = this.joinPath(this.cwd, rest);
    if (!path) throw new Error('usage: mkdir <name>');
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(path + ': already exists');

    await this.ensureFolder(path);
    this.openParents(path);
    this.say('mkdir: ' + path);
  }

  async cmdRm(rest) {
    if (!rest) throw new Error('usage: rm <name>');
    const item = this.lookup(rest);
    if (!item) throw new Error(rest + ': no such file or directory');
    if (item === this.app.vault.getRoot()) throw new Error('refusing to remove the vault root');

    const path = item.path;
    await this.app.fileManager.trashFile(item);   /* obsidian's own trash setting applies */
    if (this.cwd === path || this.cwd.startsWith(path + '/')) this.cwd = parentOf(path);
    this.say('rm: ' + path + ' → trash');
  }

  async cmdMv(args) {
    if (args.length !== 2) throw new Error('usage: mv <from> <to>  (quote names with spaces)');
    const src = this.lookup(args[0]);
    if (!src) throw new Error(args[0] + ': no such file or directory');
    if (src === this.app.vault.getRoot()) throw new Error('refusing to move the vault root');

    const from = src.path;
    let dest = this.joinPath(this.cwd, args[1]);
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

  cmdCd(rest) {
    const target = this.lookup(rest);
    if (!target) throw new Error(rest + ': no such directory');
    if (!(target instanceof TFolder)) throw new Error(rest + ': not a directory');

    this.cwd = target.isRoot() ? '' : target.path;
    if (this.cwd) {
      this.open.add(this.cwd);
      this.openParents(this.cwd);
    }
    this.renderAll();
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
