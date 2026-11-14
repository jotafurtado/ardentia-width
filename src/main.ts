import {
  MarkdownView,
  Plugin,
  TFile,
  debounce,
  getIcon,
  getLanguage,
  setIcon,
  setTooltip,
} from "obsidian";
import type { MarkdownPostProcessorContext, TAbstractFile } from "obsidian";
import type { EditorView } from "@codemirror/view";

interface WidthData {
  /** Caminho das notas abertas na largura do painel. */
  wideNotes: string[];
  /** Por nota, a posição (0, 1, 2...) de cada tabela expandida. */
  wideTables: Record<string, number[]>;
}

interface Labels {
  expandNote: string;
  collapseNote: string;
  expandTable: string;
  collapseTable: string;
  toggleNoteCommand: string;
}

interface ViewHandle {
  action: HTMLElement;
  observer: MutationObserver;
}

/** O Obsidian expõe o EditorView do CodeMirror em `editor.cm`, fora da tipagem pública. */
interface EditorWithCodeMirror {
  cm?: EditorView;
}

const DEFAULT_DATA: WidthData = { wideNotes: [], wideTables: {} };

const LABELS_PT: Labels = {
  expandNote: "Expandir Nota",
  collapseNote: "Contrair Nota",
  expandTable: "Expandir Tabela",
  collapseTable: "Contrair Tabela",
  toggleNoteCommand: "Alternar Largura da Nota",
};

const LABELS_EN: Labels = {
  expandNote: "Expand note",
  collapseNote: "Collapse note",
  expandTable: "Expand table",
  collapseTable: "Collapse table",
  toggleNoteCommand: "Toggle note width",
};

const WIDE_NOTE_CLASS = "ardentia-wide-note";
const WIDE_TABLE_CLASS = "ardentia-wide-table";
const TABLE_HOST_CLASS = "ardentia-table-host";
const TABLE_BAR_CLASS = "ardentia-table-bar";
const TABLE_TOGGLE_CLASS = "ardentia-table-toggle";
const NOTE_TOGGLE_CLASS = "ardentia-note-toggle";

/** Usa o primeiro ícone que a versão instalada do Obsidian conhece. */
function pickIcon(candidates: readonly string[], fallback: string): string {
  return candidates.find((name) => getIcon(name) !== null) ?? fallback;
}

export default class ArdentiaWidthPlugin extends Plugin {
  private data: WidthData = DEFAULT_DATA;
  private labels: Labels = LABELS_EN;
  private expandIcon = "maximize-2";
  private collapseIcon = "minimize-2";
  private readonly handles = new Map<MarkdownView, ViewHandle>();

  override async onload(): Promise<void> {
    const stored = (await this.loadData()) as Partial<WidthData> | null;
    this.data = {
      wideNotes: stored?.wideNotes ?? [],
      wideTables: stored?.wideTables ?? {},
    };
    this.labels = getLanguage().startsWith("pt") ? LABELS_PT : LABELS_EN;
    this.expandIcon = pickIcon(["unfold-horizontal", "move-horizontal"], "maximize-2");
    this.collapseIcon = pickIcon(["fold-horizontal"], "minimize-2");

    this.addCommand({
      id: "toggle-note-width",
      name: this.labels.toggleNoteCommand,
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) this.toggleNote(view.file.path);
        return true;
      },
    });

    this.registerMarkdownPostProcessor((element, context) => this.decorateRenderedTables(element, context));

    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncViews()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncViews()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.refreshEditorTables(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.handleDelete(file)));

    this.app.workspace.onLayoutReady(() => this.syncViews());
  }

  override onunload(): void {
    for (const [view, handle] of this.handles) {
      handle.observer.disconnect();
      handle.action.remove();
      view.contentEl.removeClass(WIDE_NOTE_CLASS);
      view.contentEl.querySelectorAll(`.${TABLE_BAR_CLASS}`).forEach((bar) => bar.remove());
      view.contentEl.querySelectorAll(`.${TABLE_HOST_CLASS}`).forEach((host) => {
        host.removeClass(TABLE_HOST_CLASS, WIDE_TABLE_CLASS);
      });
      this.remeasure(view);
    }
    this.handles.clear();
  }

  // ---------------------------------------------------------------- nota

  private markdownViews(): MarkdownView[] {
    const views: MarkdownView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) views.push(leaf.view);
    }
    return views;
  }

  /** Garante botão e observador em cada nota aberta e aplica o estado salvo. */
  private syncViews(): void {
    const open = new Set(this.markdownViews());

    for (const [view, handle] of this.handles) {
      if (open.has(view)) continue;
      handle.observer.disconnect();
      this.handles.delete(view);
    }

    for (const view of open) {
      if (!this.handles.has(view)) this.handles.set(view, this.attach(view));
      this.applyNoteState(view);
      this.decorateEditorTables(view);
    }
  }

  private attach(view: MarkdownView): ViewHandle {
    const action = view.addAction(this.expandIcon, this.labels.expandNote, () => {
      if (view.file) this.toggleNote(view.file.path);
    });
    action.addClass(NOTE_TOGGLE_CLASS);

    // As tabelas do modo de edição são widgets recriados pelo editor: redecora a cada mudança.
    const decorate = debounce(() => this.decorateEditorTables(view), 60, true);
    const observer = new MutationObserver(() => decorate());
    observer.observe(view.contentEl, { childList: true, subtree: true });

    return { action, observer };
  }

  private applyNoteState(view: MarkdownView): void {
    const handle = this.handles.get(view);
    if (!handle) return;

    const wide = view.file !== null && this.data.wideNotes.includes(view.file.path);
    view.contentEl.toggleClass(WIDE_NOTE_CLASS, wide);
    handle.action.toggleClass("is-active", wide);
    setIcon(handle.action, wide ? this.collapseIcon : this.expandIcon);
    setTooltip(handle.action, wide ? this.labels.collapseNote : this.labels.expandNote);
    this.remeasure(view);
  }

  private toggleNote(path: string): void {
    const wide = this.data.wideNotes.includes(path);
    this.data.wideNotes = wide
      ? this.data.wideNotes.filter((item) => item !== path)
      : [...this.data.wideNotes, path];
    void this.saveData(this.data);

    for (const view of this.markdownViews()) {
      if (view.file?.path === path) this.applyNoteState(view);
    }
  }

  // ------------------------------------------------------------- tabelas

  /** Posição da tabela na nota (0 é a primeira), a partir da linha em que ela começa. */
  private tableIndexAtLine(path: string, line: number): number | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;

    const sections = this.app.metadataCache.getFileCache(file)?.sections ?? [];
    const index = sections
      .filter((section) => section.type === "table")
      .findIndex((section) => section.position.start.line === line);
    return index === -1 ? null : index;
  }

  /** Modo de leitura: cada tabela de primeiro nível chega aqui dentro do próprio bloco. */
  private decorateRenderedTables(element: HTMLElement, context: MarkdownPostProcessorContext): void {
    const table = element.querySelector(":scope > table");
    if (!table?.instanceOf(HTMLTableElement)) return;

    const line = context.getSectionInfo(element)?.lineStart;
    const index = line === undefined ? null : this.tableIndexAtLine(context.sourcePath, line);
    this.decorateHost(element, context.sourcePath, index);
  }

  /** Modo de edição: as tabelas são widgets do editor, localizados pela posição no documento. */
  private decorateEditorTables(view: MarkdownView): void {
    const path = view.file?.path;
    const editorView = (view.editor as EditorWithCodeMirror).cm;
    if (!path || !editorView) return;

    const widgets = view.contentEl.querySelectorAll<HTMLElement>(".cm-content > .cm-table-widget");
    for (const widget of Array.from(widgets)) {
      this.decorateHost(widget, path, this.editorTableIndex(editorView, widget, path));
    }
  }

  private editorTableIndex(editorView: EditorView, widget: HTMLElement, path: string): number | null {
    try {
      const position = editorView.posAtDOM(widget);
      const line = editorView.state.doc.lineAt(position).number - 1;
      return this.tableIndexAtLine(path, line);
    } catch {
      // O widget pode sair do documento entre a mutação e a medição.
      return null;
    }
  }

  private refreshEditorTables(path: string): void {
    for (const view of this.markdownViews()) {
      if (view.file?.path === path) this.decorateEditorTables(view);
    }
  }

  /** Cria (uma vez) a barra com o botão acima da tabela e aplica o estado salvo. */
  private decorateHost(host: HTMLElement, path: string, index: number | null): void {
    host.addClass(TABLE_HOST_CLASS);
    host.dataset.ardentiaTable = index === null ? "" : String(index);

    let button = host.querySelector<HTMLElement>(`:scope > .${TABLE_BAR_CLASS} > .${TABLE_TOGGLE_CLASS}`);
    if (!button) {
      const bar = createDiv({ cls: TABLE_BAR_CLASS });
      bar.setAttribute("contenteditable", "false");
      const created = bar.createEl("button", { cls: ["clickable-icon", TABLE_TOGGLE_CLASS] });
      // No modo de edição o clique não pode mover o cursor para dentro da tabela.
      created.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      created.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleTable(host, path);
      });
      host.prepend(bar);
      button = created;
    }

    const wide = index === null ? host.hasClass(WIDE_TABLE_CLASS) : this.isTableWide(path, index);
    this.paintTable(host, button, wide);
  }

  private isTableWide(path: string, index: number): boolean {
    return this.data.wideTables[path]?.includes(index) ?? false;
  }

  private paintTable(host: HTMLElement, button: HTMLElement, wide: boolean): void {
    if (host.hasClass(WIDE_TABLE_CLASS) === wide && button.dataset.painted === String(wide)) return;

    host.toggleClass(WIDE_TABLE_CLASS, wide);
    button.dataset.painted = String(wide);
    setIcon(button, wide ? this.collapseIcon : this.expandIcon);
    setTooltip(button, wide ? this.labels.collapseTable : this.labels.expandTable);
  }

  private toggleTable(host: HTMLElement, path: string): void {
    const key = host.dataset.ardentiaTable ?? "";
    const wide = !host.hasClass(WIDE_TABLE_CLASS);

    // Tabela sem posição conhecida (cache ainda atrasado): vale só para este elemento.
    if (key === "") {
      const button = host.querySelector<HTMLElement>(`:scope > .${TABLE_BAR_CLASS} > .${TABLE_TOGGLE_CLASS}`);
      if (button) this.paintTable(host, button, wide);
      this.remeasureAll(path);
      return;
    }

    const index = Number(key);
    const current = this.data.wideTables[path] ?? [];
    const next = wide ? [...current, index] : current.filter((item) => item !== index);
    if (next.length === 0) delete this.data.wideTables[path];
    else this.data.wideTables[path] = next;
    void this.saveData(this.data);

    // A mesma tabela pode estar em mais de um painel e nos dois modos.
    for (const view of this.markdownViews()) {
      if (view.file?.path !== path) continue;
      const hosts = view.contentEl.querySelectorAll<HTMLElement>(`.${TABLE_HOST_CLASS}[data-ardentia-table="${key}"]`);
      for (const other of Array.from(hosts)) {
        const button = other.querySelector<HTMLElement>(`:scope > .${TABLE_BAR_CLASS} > .${TABLE_TOGGLE_CLASS}`);
        if (button) this.paintTable(other, button, wide);
      }
    }
    this.remeasureAll(path);
  }

  // ------------------------------------------------------------ suporte

  /** A largura muda a altura das linhas: o editor precisa medir de novo. */
  private remeasure(view: MarkdownView): void {
    (view.editor as EditorWithCodeMirror | undefined)?.cm?.requestMeasure();
  }

  private remeasureAll(path: string): void {
    for (const view of this.markdownViews()) {
      if (view.file?.path === path) this.remeasure(view);
    }
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    let changed = false;

    if (this.data.wideNotes.includes(oldPath)) {
      this.data.wideNotes = this.data.wideNotes.map((item) => (item === oldPath ? file.path : item));
      changed = true;
    }
    const tables = this.data.wideTables[oldPath];
    if (tables) {
      delete this.data.wideTables[oldPath];
      this.data.wideTables[file.path] = tables;
      changed = true;
    }

    if (changed) void this.saveData(this.data);
  }

  private handleDelete(file: TAbstractFile): void {
    const hadNote = this.data.wideNotes.includes(file.path);
    const hadTables = file.path in this.data.wideTables;
    if (!hadNote && !hadTables) return;

    this.data.wideNotes = this.data.wideNotes.filter((item) => item !== file.path);
    delete this.data.wideTables[file.path];
    void this.saveData(this.data);
  }
}
