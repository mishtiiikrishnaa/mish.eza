'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   mish.eza
   a starship prompt + `eza --tree --all --level=99 .` that actually IS the
   file explorer: real ├── └── │ lines, eza-ish colours, click to open/fold.
   the prompt grows a git branch and node version when it can find them.
   the old explorer is only hidden; "toggle native file explorer" brings it back.
   ═══════════════════════════════════════════════════════════════════════ */

const { Plugin, TFolder, Menu, Keymap, Platform } = require('obsidian');

const pad = (n) => String(n).padStart(2, '0');

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

/* like `eza --group-directories-first`. set to false for plain a-z */
const GROUP_DIRS_FIRST = true;

const sorted = (folder) => [...folder.children].sort((a, b) => {
  if (GROUP_DIRS_FIRST) {
    const af = a instanceof TFolder;
    const bf = b instanceof TFolder;
    if (af !== bf) return af ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
});

/* eza colours files by type; so do we */
const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];
const kindOf = (file) => {
  const ext = (file.extension || '').toLowerCase();
  if (ext === 'md') return 'doc';
  if (IMG.includes(ext)) return 'img';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'canvas' || ext === 'base') return 'cv';
  return 'etc';
};

module.exports = class MishEza extends Plugin {
  async onload() {
    this.roots = new Set();
    this.branch = null;
    this.node = null;
    this.showNative = false;

    const saved = (await this.loadData()) || {};
    this.open = new Set(saved.open || []);

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
      this.markActive();
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
    cmd.appendChild(el('span', 'ez-arg', '--tree --all --level=99'));
    cmd.appendChild(document.createTextNode(' '));
    cmd.appendChild(el('span', 'ez-path-arg', '.'));
    root.appendChild(cmd);

    /* eza prints the root as a dot, then the tree */
    root.appendChild(el('div', 'ez-dot', '.'));

    const tree = el('div', 'ez-tree');
    root.appendChild(tree);

    root.__ez = { bar, tree, clock: null };
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

  /* the tree itself: one row per entry, lines drawn by css cells */
  renderTree(root) {
    const frag = document.createDocumentFragment();
    this.walk(this.app.vault.getRoot(), [], frag);
    root.__ez.tree.replaceChildren(frag);
    this.markActive();
  }

  renderAll() {
    for (const root of this.roots) this.renderTree(root);
  }

  /* guides[i] is true when ancestor i still has siblings below it (draws │) */
  walk(folder, guides, out) {
    const kids = sorted(folder);

    kids.forEach((node, i) => {
      const last = i === kids.length - 1;
      const isDir = node instanceof TFolder;

      const row = el('div', 'ez-row');
      row.dataset.path = node.path;

      for (const g of guides) row.appendChild(el('span', 'ez-cell' + (g ? ' ez-v' : '')));
      row.appendChild(el('span', 'ez-cell ' + (last ? 'ez-l' : 'ez-t')));

      const name = el('span', 'ez-name ' + (isDir ? 'ez-dir' : 'ez-' + kindOf(node)));
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

  /* ── interaction ─────────────────────────────────────────────────── */

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
      e.preventDefault();
      const row = e.target.closest('.ez-row');
      const item = row ? this.app.vault.getAbstractFileByPath(row.dataset.path) : null;
      const menu = new Menu();

      if (item) {
        /* obsidian's own file menu: rename, delete, move, etc. */
        this.app.workspace.trigger('file-menu', menu, item, 'file-explorer-context-menu');
      } else {
        /* the dot / empty space: the pills are gone, so new things live here */
        const root = this.app.vault.getRoot();
        menu.addItem((i) => i.setTitle('new note').setIcon('edit')
          .onClick(() => this.create(root, 'note')));
        menu.addItem((i) => i.setTitle('new folder').setIcon('folder-plus')
          .onClick(() => this.create(root, 'folder')));
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

  persist() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveData({ open: [...this.open] }), 500);
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
