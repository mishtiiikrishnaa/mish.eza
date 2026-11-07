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

module.exports = class MishEza extends Plugin {
  async onload() {
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
    const bar = el('div', 'ez-bar');
    root.appendChild(bar);

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
    root.appendChild(cmd);

    /* eza prints the root as a dot, then the tree */
    root.appendChild(el('div', 'ez-dot', '.'));

    const tree = el('div', 'ez-tree');
    root.appendChild(tree);

    const foot = this.buildFoot(root);
    root.appendChild(foot.node);

    root.__ez = { bar, tree, arg, clock: null, input: foot.input, cwd: foot.cwd };
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
    node.appendChild(el('div', 'ez-out'));

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

    return { node, input, cwd };
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
      if (e.target.closest('.ez-foot')) return;   /* leave the prompt's own menu alone */
      e.preventDefault();
      const row = e.target.closest('.ez-row');
      const item = row ? this.app.vault.getAbstractFileByPath(row.dataset.path) : null;
      const menu = new Menu();

      if (item) {
        /* obsidian's own file menu: rename, delete, move, etc. */
        this.app.workspace.trigger('file-menu', menu, item, 'file-explorer-context-menu');
      } else {
        const vaultRoot = this.app.vault.getRoot();
        menu.addItem((i) => i.setTitle('new note').setIcon('edit')
          .onClick(() => this.create(vaultRoot, 'note')));
        menu.addItem((i) => i.setTitle('new folder').setIcon('folder-plus')
          .onClick(() => this.create(vaultRoot, 'folder')));
      }
      menu.showAtMouseEvent(e);
    });
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
      const out = root.__ez.bar.parentNode.querySelector('.ez-out');
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
        case 'rm': await this.cmdRm(rest); break;
        case 'mv': await this.cmdMv(args); break;
        case 'cd': this.cmdCd(rest); break;
        case 'pwd': this.say(this.cwdLabel()); break;
        case 'sort': this.cmdSort(rest); break;
        case 'reveal': this.cmdReveal(); break;
        case 'collapse': this.open.clear(); this.renderAll(); this.persist(); break;
        case 'expand': this.cmdExpand(); break;
        case 'clear': break;
        case 'help':
          this.say('touch · mkdir · rm · mv · cd · pwd · sort · reveal · collapse · expand · clear');
          break;
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
    if (!path) throw new Error('missing file name');
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
    if (!path) throw new Error('missing folder name');
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(path + ': already exists');

    await this.ensureFolder(path);
    this.openParents(path);
    this.say('mkdir: ' + path);
  }

  async cmdRm(rest) {
    if (!rest) throw new Error('missing operand');
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
