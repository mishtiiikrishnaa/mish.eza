'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   mish.eza
   puts a starship prompt + `eza --tree --all --level=99 .` above the
   default file explorer, so the tree reads like terminal output.
   the fold markers (+ / -) are done in styles.css.
   ═══════════════════════════════════════════════════════════════════════ */

const { Plugin } = require('obsidian');

const pad = (n) => String(n).padStart(2, '0');

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

module.exports = class MishEza extends Plugin {
  async onload() {
    this.roots = new Set();

    this.app.workspace.onLayoutReady(() => this.ensure());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.ensure()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.ensure()));

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
  }

  onunload() {
    for (const root of this.roots) root.remove();
    this.roots.clear();
  }

  /* ── mounting ────────────────────────────────────────────────────── */

  ensure() {
    const leaves = document.querySelectorAll(
      '.workspace-leaf-content[data-type="file-explorer"]'
    );

    leaves.forEach((leaf) => {
      if (leaf.querySelector('.ez-root')) return;
      const host = leaf.querySelector(':scope > .view-content') || leaf;
      const root = this.build();
      host.prepend(root);
      this.roots.add(root);
      this.tick();
    });

    for (const root of [...this.roots]) {
      if (!root.isConnected) this.roots.delete(root);
    }
  }

  /* ── drawing ─────────────────────────────────────────────────────── */

  build() {
    const root = el('div', 'ez-root');

    /* powerline prompt */
    const bar = el('div', 'ez-bar');
    const segs = [
      ['ez-user', '\uF179 mishti'],
      ['ez-path', '~/' + this.app.vault.getName()],
      ['ez-ch ez-ch1', ''],
      ['ez-ch ez-ch2', ''],
      ['ez-ch ez-ch3', ''],
      ['ez-clock', ''],
    ];

    let clock = null;
    segs.forEach(([cls, text], i) => {
      const seg = el('span', 'ez-seg ' + cls, text);
      seg.style.zIndex = String(segs.length - i);   /* arrow tips overlap the next segment */
      bar.appendChild(seg);
      clock = seg;                                   /* last one wins: the clock */
    });
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

    root.__ez = { clock };
    return root;
  }

  tick() {
    const d = new Date();
    const text = '\uF43A ' + pad(d.getHours()) + ':' + pad(d.getMinutes());

    for (const root of this.roots) {
      const refs = root.__ez;
      if (refs && refs.clock.textContent !== text) refs.clock.textContent = text;
    }
  }
};
