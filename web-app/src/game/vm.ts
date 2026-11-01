import type {
  Choice,
  CompiledScript,
  DebugState,
  ImageSpec,
  ScriptLine,
  Snapshot,
  SpriteState,
  TachiState,
  TextWindow,
  TranslationData,
  UrlState,
  VmHooks,
} from "./types";
import {
  commandName,
  parseSetwindow,
  parseSpec,
  splitArgs,
  splitTopLevel,
  unquote,
} from "./script";
import { AssetStore } from "./assets";
import { AudioEngine } from "./audio";
import { SaveStore } from "./save";

type Value = number | string;
type WaitKind = "none" | "text" | "button" | "delay" | "timer";
type ReturnTarget = number | { pc: number; queue: string[] };
type InputEvent =
  | { type: "left" | "right" | "enter" | "escape"; x?: number; y?: number }
  | { type: "timeout" }
  | { type: "trap"; label: string }
  | { type: "gosub"; label: string }
  | { type: "button"; no: number };

interface ButtonDef {
  no: number;
  kind: "sprite" | "rect" | "exbtn";
  spriteNo?: number;
  rect?: { x: number; y: number; w: number; h: number };
  src?: { x: number; y: number; w: number; h: number };
  image?: HTMLCanvasElement;
  ctl?: string;
}

interface Quake {
  until: number;
  amp: number;
  horizontal: boolean;
  vertical: boolean;
}

const GLOBAL_BORDER = 200;

export class Vm {
  readonly script: CompiledScript;
  readonly assets: AssetStore;
  readonly audio: AudioEngine;
  readonly saves: SaveStore;
  private hooks: VmHooks;

  pc = 0;
  vars: number[] = new Array(1000).fill(0);
  strs: string[] = new Array(1000).fill("");
  callStack: ReturnTarget[] = [];
  loops: { varNo: number; end: number; step: number; body: number }[] = [];
  private cmdQueue: string[] = [];
  private cmdQueuePc = -1;

  textLines: string[] = [];
  textWindow: TextWindow;
  textColor: string;
  textVisible = true;
  textSpeed = 30;
  revealed = 0;
  /** Character offset (in textLines) where the newly appended block starts. */
  revealedFrom = 0;
  typing = false;
  private typeTimer: number | null = null;
  private autoTimer: number | null = null;

  bg: string | null = null;
  bgFrom: string | null = null;
  bgTransitionStart = 0;
  bgTransitionDuration = 0;
  tachi: (TachiState | null)[] = [null, null, null];
  sprites = new Map<number, SpriteState>();
  spriteDims = new Map<number, { w: number; h: number; cells: number }>();

  buttons: ButtonDef[] = [];
  btndefImage: HTMLCanvasElement | null = null;
  btndefFile: string | null = null;
  btntime = 0;
  hoverButton: ButtonDef | null = null;
  private exbtnDefault: string | null = null;

  trapLabel: string | null = null;
  pendingGosub: string | null = null;
  autoMode = false;
  skipMode = false;
  running = false;
  private ended = false;
  saveEnabled = true;
  quake: Quake | null = null;
  timerStart = 0;

  history: string[] = [];
  lookbackOn = true;
  translations: TranslationData | null = null;
  language: "ja" | "en" = "ja";
  seenLabels = new Set<string>();
  private seenTimer: number | null = null;

  private waiter: ((ev: InputEvent) => void) | null = null;
  private waitKind: WaitKind = "none";
  private pendingTimeout: number | null = null;
  private lastTextSnapshot: Snapshot | null = null;
  private globalsTimer: number | null = null;
  private lastLabel = "";
  private lineLabels: string[] = [];
  private storyPc: number;
  private storyLabel = "";
  private menuLabel: string | null = null;
  private menuReturnDepth = -1;
  private menuResumePc: number | null = null;
  private deferredMenu: string | null = null;
  private stateTimer: number | null = null;
  private suppressState = false;

  constructor(
    script: CompiledScript,
    hooks: VmHooks,
    assets: AssetStore,
    audio: AudioEngine,
    saves: SaveStore,
  ) {
    this.script = script;
    this.hooks = hooks;
    this.assets = assets;
    this.audio = audio;
    this.saves = saves;
    this.textWindow = { ...script.define.textWindow };
    this.textColor = script.define.textColor;
    this.textSpeed = 30;
    this.pc = script.start;
    this.storyPc = script.start;
    this.buildLineLabels();
    this.storyLabel = this.labelForPc(script.start);
    this.audio.setBgmVolume(script.define.defBgmVol);
    this.audio.setSeVolume(script.define.defSeVol);
    this.audio.setVoiceVolume(script.define.defVoiceVol);
    this.loadGlobals();
    this.seedSaveLabels();
    this.loadSeenLabels();
  }

  /** Start execution, optionally restoring a snapshot and/or reopening a menu. */
  async start(opts: { snapshot?: Snapshot; pc?: number; menu?: string | null } = {}) {
    if (this.running) return;
    this.suppressState = true;
    if (opts.snapshot && opts.snapshot.version === 2 && Array.isArray(opts.snapshot.buttons)) {
      await this.restoreSnapshot(opts.snapshot);
      this.pc = Math.max(0, Math.min(this.script.lines.length - 1, opts.snapshot.pc));
    } else if (opts.pc !== undefined) {
      this.pc = Math.max(0, Math.min(this.script.lines.length - 1, opts.pc));
    } else {
      this.pc = this.script.start;
    }
    this.storyPc = this.pc;
    this.storyLabel = this.labelForPc(this.pc);
    this.cmdQueue = [];
    this.callStack = [];
    this.loops = [];
    this.pendingGosub = null;
    const menu = opts.menu ? normalizeLabelArg(opts.menu) : null;
    if (menu) {
      const line = this.script.lines[this.pc];
      this.menuResumePc = this.pc;
      if (line?.kind === "text") {
        this.deferredMenu = menu;
      } else {
        this.menuLabel = menu;
        this.menuReturnDepth = this.callStack.length;
        this.pendingGosub = menu;
      }
    }
    this.suppressState = false;
    this.running = true;
    await this.run();
  }

  stop() {
    this.running = false;
    this.clearWait();
  }

  private async run() {
    while (this.running) {
      if (this.pendingGosub) {
        const label = this.pendingGosub;
        this.pendingGosub = null;
        this.trace(`pendingGosub ${label} resume=${this.menuResumePc ?? this.pc}`);
        this.callStack.push(this.menuResumePc ?? this.pc);
        this.jump(label);
        continue;
      }
      if (this.cmdQueue.length) {
        const jumped = await this.runQueue();
        if (jumped) continue;
        this.pc = this.cmdQueuePc + 1;
        this.cmdQueue = [];
        continue;
      }
      const line = this.script.lines[this.pc];
      if (!line) {
        this.finish();
        return;
      }
      if (line.kind === "label" && line.label) this.markLabel(line.label);
      try {
        if (line.kind === "text") {
          await this.execTextBlock();
        } else if (line.kind === "command") {
          await this.execLine(line.raw);
        } else {
          this.pc++;
        }
      } catch (err) {
        console.error(err);
        this.hooks.error(err instanceof Error ? err.message : String(err));
        this.running = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    this.hooks.ended();
  }

  // ---------------------------------------------------------------- text

  private async execTextBlock(): Promise<void> {
    const startPc = this.pc;
    const before = [...this.textLines];
    this.lastTextSnapshot = this.captureSnapshot(startPc, before);
    this.updateStoryPosition(startPc);
    const block: string[] = [];
    let click = false;
    while (this.pc < this.script.lines.length) {
      const l = this.script.lines[this.pc];
      if (l.kind !== "text") break;
      block.push(l.text ?? "");
      if (l.click) {
        click = true;
        this.pc++;
        break;
      }
      this.pc++;
    }
    if (block.length === 0) return;
    this.appendText(block);
    if (this.lookbackOn) {
      for (const b of block) this.history.push(b);
      if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    }
    if (this.deferredMenu) {
      const menu = this.deferredMenu;
      this.deferredMenu = null;
      this.menuLabel = menu;
      this.menuReturnDepth = this.callStack.length;
      this.menuResumePc = startPc;
      this.pendingGosub = menu;
      this.scheduleState();
      return;
    }
    if (!click) return;
    const jumped = await this.waitText();
    if (jumped) return;
    if (this.saveEnabled) this.saveEnabled = true;
  }

  private appendText(block: string[]) {
    const rows = Math.max(1, this.textWindow.rows);
    const lines = block.length > rows ? block.slice(-rows) : block;
    if (this.textLines.length + lines.length > rows) this.textLines = [];
    // Only type out the newly appended block; earlier lines stay fully visible.
    this.revealedFrom = this.totalChars();
    this.textLines.push(...lines);
    this.revealed = this.revealedFrom;
  }

  private totalChars(): number {
    return this.textLines.reduce((n, l) => n + [...l].length, 0);
  }

  private async waitText(): Promise<boolean> {
    const total = this.totalChars();
    this.stopTyping();
    if (this.skipMode || this.textSpeed <= 0) {
      this.revealed = total;
      this.typing = false;
      this.scheduleAuto();
    } else {
      this.typing = true;
      this.revealed = this.revealedFrom;
      this.typeTimer = window.setInterval(() => {
        this.revealed++;
        if (this.revealed >= total) {
          this.revealed = total;
          this.stopTyping();
          if (this.skipMode) this.waiter?.({ type: "left" });
          else this.scheduleAuto();
        }
        this.hooks.requestRender();
      }, Math.max(8, this.textSpeed));
    }
    this.hooks.requestRender();
    if (this.skipMode) {
      queueMicrotask(() => this.waiter?.({ type: "left" }));
    }
    const ev = await this.waitInput("text");
    this.stopTyping();
    this.stopAuto();
    if (ev.type === "trap") {
      this.trapLabel = null;
      this.cmdQueue = [];
      this.pc = this.labelIndex(ev.label);
      return true;
    }
    return false;
  }

  private stopTyping() {
    if (this.typeTimer !== null) {
      clearInterval(this.typeTimer);
      this.typeTimer = null;
    }
    this.typing = false;
  }

  private stopAuto() {
    if (this.autoTimer !== null) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
  }

  // ---------------------------------------------------------------- input

  private waitInput(kind: WaitKind, timeoutMs = 0): Promise<InputEvent> {
    this.waitKind = kind;
    return new Promise<InputEvent>((resolve) => {
      const done = (ev: InputEvent) => {
        if (this.waiter !== done) return;
        this.waiter = null;
        this.waitKind = "none";
        if (this.pendingTimeout !== null) {
          clearTimeout(this.pendingTimeout);
          this.pendingTimeout = null;
        }
        resolve(ev);
      };
      this.waiter = done;
      if (timeoutMs > 0) {
        this.pendingTimeout = window.setTimeout(() => done({ type: "timeout" }), timeoutMs);
      }
    });
  }

  private scheduleAuto() {
    if (!this.autoMode || this.waitKind !== "text" || !this.waiter) return;
    this.stopAuto();
    this.autoTimer = window.setTimeout(() => {
      if (!this.typing) this.waiter?.({ type: "left" });
    }, Math.max(250, this.script.define.automodeTime));
  }

  private clearWait() {
    this.stopTyping();
    this.stopAuto();
    if (this.pendingTimeout !== null) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
    const w = this.waiter;
    this.waiter = null;
    this.waitKind = "none";
    if (w) w({ type: "escape" });
  }

  /** Feed a left click at logical screen coordinates. */
  async click(x: number, y: number) {
    this.audio.resume();
    if (this.waitKind === "text" || this.waitKind === "none") {
      const action = this.hotspot(x, y);
      if (action) {
        this.handleHotspot(action);
        return;
      }
    }
    if (this.waitKind === "button") {
      const hit = this.hitTest(x, y);
      if (hit) {
        this.hooks.requestRender();
        this.waiter?.({ type: "button", no: hit.no });
        return;
      }
      if (this.trapLabel) {
        const label = this.trapLabel;
        this.trapLabel = null;
        this.waiter?.({ type: "trap", label });
        return;
      }
      this.waiter?.({ type: "left", x, y });
      return;
    }
    if (this.waitKind === "text") {
      if (this.typing) {
        this.revealed = this.totalChars();
        this.stopTyping();
        this.hooks.requestRender();
        if (this.skipMode) this.waiter?.({ type: "left" });
        return;
      }
      if (this.trapLabel) {
        const label = this.trapLabel;
        this.trapLabel = null;
        this.waiter?.({ type: "trap", label });
        return;
      }
      this.waiter?.({ type: "left", x, y });
      return;
    }
    if (this.waitKind === "delay" || this.waitKind === "timer") {
      if (this.trapLabel) {
        const label = this.trapLabel;
        this.trapLabel = null;
        this.waiter?.({ type: "trap", label });
      } else {
        this.waiter?.({ type: "left", x, y });
      }
      return;
    }
  }

  /** Right click / escape during a wait. */
  async advanceSpecial(type: "right" | "escape") {
    if (!this.waiter) return;
    if (type === "right" && (this.waitKind === "text" || this.waitKind === "delay")) {
      this.hooks.backlog(this.history);
      return;
    }
    this.waiter({ type });
  }

  /** Keyboard Enter / Space. */
  async keyEnter() {
    this.audio.resume();
    if (this.waitKind === "button") {
      this.waiter?.({ type: "enter" });
      return;
    }
    if (this.waitKind === "text") {
      if (this.typing) {
        this.revealed = this.totalChars();
        this.stopTyping();
        this.hooks.requestRender();
        if (this.skipMode) this.waiter?.({ type: "left" });
        return;
      }
      this.waiter?.({ type: "enter" });
      return;
    }
    if (this.waitKind === "delay" || this.waitKind === "timer") {
      this.waiter?.({ type: "enter" });
    }
  }

  hover(x: number, y: number) {
    if (this.waitKind !== "button") return;
    const hit = this.hitTest(x, y);
    if (hit === this.hoverButton) return;
    if (this.hoverButton) this.leaveButton(this.hoverButton);
    this.hoverButton = hit;
    if (hit) this.enterButton(hit);
    this.hooks.requestRender();
  }

  private hotspot(x: number, y: number): string | null {
    const check = (no: number, action: string): string | null => {
      const sp = this.sprites.get(no);
      const d = this.spriteDims.get(no);
      if (sp && d && x >= sp.x && x < sp.x + d.w && y >= sp.y && y < sp.y + d.h) return action;
      return null;
    };
    return (
      check(80, "save") ??
      check(81, "load") ??
      check(82, "config") ??
      check(83, "title") ??
      check(85, "log") ??
      check(86, "auto") ??
      check(87, "skip") ??
      check(88, "menu") ??
      check(106, "voice") ??
      null
    );
  }

  private handleHotspot(action: string) {
    switch (action) {
      case "save":
        this.requestGosub("save_menu");
        break;
      case "load":
        this.requestGosub("load_menu");
        break;
      case "config":
        this.requestGosub("config_menu");
        break;
      case "title":
        this.requestGosub("backtitle_dlg");
        break;
      case "log":
      case "menu":
        this.hooks.backlog(this.history);
        break;
      case "auto":
        this.toggleAuto();
        break;
      case "skip":
        this.toggleSkip();
        break;
      case "voice":
        this.toggleVoice();
        break;
    }
  }

  private toggleVoice() {
    this.vars[240] = this.vars[240] ? 0 : 1;
    this.vars[88] = this.vars[240];
    const file = this.vars[240] ? "mw_mvon.bmp" : "mw_mvoff.bmp";
    this.setSprite(106, parseSpec(`:a/2,0,3;${file}`, "a"), 650, 7, true);
    this.scheduleGlobals();
  }

  private enterButton(b: ButtonDef) {
    if (b.kind === "sprite" && b.spriteNo !== undefined) {
      const sp = this.sprites.get(b.spriteNo);
      if (sp) {
        sp.visible = true;
        const dims = this.spriteDims.get(b.spriteNo);
        if (dims && dims.cells > 1) sp.cell = 1;
      }
    } else if (b.kind === "exbtn" && b.ctl) {
      this.applyControl(b.ctl);
    }
  }

  private leaveButton(b: ButtonDef) {
    if (b.kind === "sprite" && b.spriteNo !== undefined) {
      const sp = this.sprites.get(b.spriteNo);
      if (sp) {
        sp.visible = true;
        sp.cell = 0;
      }
    } else if (b.kind === "exbtn") {
      if (this.exbtnDefault) this.applyControl(this.exbtnDefault);
    }
  }

  private hitTest(x: number, y: number): ButtonDef | null {
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      const r = this.buttonRect(b);
      if (r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return b;
    }
    return null;
  }

  private buttonRect(b: ButtonDef): { x: number; y: number; w: number; h: number } | null {
    if (b.kind === "rect") return b.rect ?? null;
    if (b.spriteNo === undefined) return null;
    const sp = this.sprites.get(b.spriteNo);
    if (!sp) return null;
    const dims = this.spriteDims.get(b.spriteNo);
    if (!dims) return null;
    return { x: sp.x, y: sp.y, w: dims.w, h: dims.h };
  }

  // ---------------------------------------------------------------- execution

  private async execLine(source: string): Promise<boolean> {
    const s = source.trim();
    if (!s) return false;
    const name = commandName(s);
    if (name === "if" || name === "notif") {
      const rest = s.slice(s.indexOf(name) + name.length).trim();
      const parser = new ExprParser(rest, this);
      let cond: Value;
      try {
        cond = parser.parse();
      } catch {
        this.pc++;
        return false;
      }
      const body = rest.slice(parser.pos).trim();
      const ok = name === "if" ? truthy(cond) : !truthy(cond);
      if (!ok || !body) {
        this.cmdQueue = [];
        this.pc++;
        return false;
      }
      return this.execLine(body);
    }
    const linePc = this.pc;
    this.cmdQueue = splitTopLevel(s, ":");
    this.cmdQueuePc = linePc;
    const jumped = await this.runQueue();
    if (jumped) return true;
    this.pc = linePc + 1;
    this.cmdQueue = [];
    return false;
  }

  private async runQueue(): Promise<boolean> {
    while (this.cmdQueue.length) {
      const part = this.cmdQueue.shift()!;
      const jumped = await this.execCommand(part);
      if (jumped) return true;
    }
    return false;
  }

  private async execCommand(raw: string): Promise<boolean> {
    const name = commandName(raw);
    if (!name) {
      if (/^#[0-9a-fA-F]{6}/.test(raw)) {
        this.textColor = raw.slice(0, 7);
      }
      return false;
    }
    const rest = raw.slice(raw.indexOf(name) + name.length).trim();
    const args = splitArgs(rest);
    const arg = (i: number) => args[i] ?? "";
    const num = (i: number, d = 0) => {
      if (!arg(i)) return d;
      return this.evalNum(arg(i), d);
    };

    switch (name) {
      // ---- variables
      case "mov": {
        const target = arg(0);
        if (!target) break;
        if (target.startsWith("$")) {
          this.setStr(this.strIndex(target), this.evalStr(arg(1)));
        } else {
          this.setVar(this.numIndex(target), this.evalNum(arg(1)));
        }
        break;
      }
      case "mov3":
      case "mov4":
      case "mov5":
      case "mov6":
      case "mov7":
      case "mov8":
      case "mov9":
      case "mov10": {
        const count = parseInt(name.slice(3), 10);
        const base = this.numIndex(arg(0));
        for (let i = 0; i < count; i++) this.setVar(base + i, this.evalNum(arg(i + 1)));
        break;
      }
      case "add": {
        const target = arg(0);
        if (target.startsWith("$")) {
          this.setStr(this.strIndex(target), this.getStr(this.strIndex(target)) + this.evalStr(arg(1)));
        } else {
          const i = this.numIndex(target);
          this.setVar(i, this.getVar(i) + this.evalNum(arg(1)));
        }
        break;
      }
      case "sub": {
        const i = this.numIndex(arg(0));
        this.setVar(i, this.getVar(i) - this.evalNum(arg(1)));
        break;
      }
      case "mul": {
        const i = this.numIndex(arg(0));
        this.setVar(i, this.getVar(i) * this.evalNum(arg(1)));
        break;
      }
      case "div": {
        const i = this.numIndex(arg(0));
        const d = this.evalNum(arg(1), 1) || 1;
        this.setVar(i, Math.trunc(this.getVar(i) / d));
        break;
      }
      case "mod": {
        const i = this.numIndex(arg(0));
        const d = this.evalNum(arg(1), 1) || 1;
        this.setVar(i, this.getVar(i) % d);
        break;
      }
      case "inc": {
        const i = this.numIndex(arg(0));
        this.setVar(i, this.getVar(i) + 1);
        break;
      }
      case "dec": {
        const i = this.numIndex(arg(0));
        this.setVar(i, this.getVar(i) - 1);
        break;
      }
      case "itoa": {
        this.setStr(this.strIndex(arg(0)), String(this.evalNum(arg(1))));
        break;
      }
      case "itoa2": {
        this.setStr(this.strIndex(arg(0)), toFullWidth(String(this.evalNum(arg(1)))));
        break;
      }
      case "len": {
        this.setVar(this.numIndex(arg(0)), [...this.evalStr(arg(1))].length);
        break;
      }
      case "atoi": {
        this.setVar(this.numIndex(arg(0)), parseInt(this.evalStr(arg(1)), 10) || 0);
        break;
      }
      case "rnd": {
        const i = this.numIndex(arg(0));
        const n = this.evalNum(arg(1), 1);
        this.setVar(i, n > 0 ? Math.floor(Math.random() * n) : 0);
        break;
      }
      case "rnd2": {
        const i = this.numIndex(arg(0));
        const lo = this.evalNum(arg(1));
        const hi = this.evalNum(arg(2));
        this.setVar(i, lo + Math.floor(Math.random() * (hi - lo + 1)));
        break;
      }

      // ---- control flow
      case "goto":
        this.jump(arg(0));
        return true;
      case "gosub":
        this.callStack.push({ pc: this.cmdQueuePc, queue: [...this.cmdQueue] });
        this.cmdQueue = [];
        this.jump(arg(0), true);
        return true;
      case "return": {
        const ret = this.callStack.pop();
        this.trace(`return target=${typeof ret === "number" ? ret : ret ? `${ret.pc}/${ret.queue.length}` : "none"} menu=${this.menuLabel} depth=${this.callStack.length}`);
        if (ret !== undefined) {
          if (typeof ret === "number") {
            this.pc = ret;
            this.cmdQueue = [];
          } else if (ret.queue.length) {
            this.pc = ret.pc;
            this.cmdQueue = [...ret.queue];
            this.cmdQueuePc = ret.pc;
          } else {
            this.pc = ret.pc + 1;
            this.cmdQueue = [];
          }
          this.maybeCloseMenu();
          return true;
        }
        break;
      }
      case "tablegoto": {
        const idx = this.evalNum(arg(0));
        const labels = args.slice(1);
        if (idx >= 0 && idx < labels.length) {
          this.jump(labels[idx]);
          return true;
        }
        break;
      }
      case "for": {
        const m = /^%([0-9]+)\s*=\s*(.+?)\s+to\s+(.+?)(?:\s+step\s+(.+))?$/i.exec(rest);
        if (m) {
          const varNo = parseInt(m[1], 10);
          const start = this.evalNum(m[2]);
          const end = this.evalNum(m[3]);
          const step = m[4] ? this.evalNum(m[4]) || 1 : 1;
          this.setVar(varNo, start);
          this.loops.push({ varNo, end, step, body: this.pc + 1 });
        }
        break;
      }
      case "next": {
        const loop = this.loops[this.loops.length - 1];
        if (loop) {
          const v = this.getVar(loop.varNo) + loop.step;
          this.setVar(loop.varNo, v);
          if ((loop.step > 0 && v <= loop.end) || (loop.step < 0 && v >= loop.end)) {
            this.cmdQueue = [];
            this.pc = loop.body;
            return true;
          }
          this.loops.pop();
        }
        break;
      }
      case "break":
        this.loops.pop();
        break;

      // ---- text / window
      case "textclear":
        this.textLines = [];
        this.revealed = 0;
        this.revealedFrom = 0;
        break;
      case "textoff":
        this.textVisible = false;
        break;
      case "texton":
        this.textVisible = true;
        break;
      case "erasetextwindow":
      case "texec":
      case "getpageup":
      case "gettab":
      case "getfunction":
      case "textgosub":
        break;
      case "textspeed":
        this.textSpeed = this.evalNum(arg(0), 30);
        break;
      case "setwindow":
        this.textWindow = parseSetwindow(rest, this.script.define.defaultMode);
        this.textLines = [];
        this.revealed = 0;
        this.revealedFrom = 0;
        break;
      case "ispage": {
        const i = this.numIndex(arg(0));
        this.setVar(i, this.textLines.length >= this.textWindow.rows ? 1 : 0);
        break;
      }
      case "getcursorpos":
        this.setVar(this.numIndex(arg(0)), this.textWindow.x);
        this.setVar(this.numIndex(arg(1)), this.textWindow.y);
        break;
      case "print":
        break;

      // ---- images
      case "bg": {
        const file = this.evalStr(arg(0)) || "black";
        const effect = num(1, 0);
        const duration = num(2, 0);
        this.bgFrom = this.bg;
        this.bg = file;
        if (duration > 0 && effect > 0) {
          this.bgTransitionStart = performance.now();
          this.bgTransitionDuration = duration;
        } else {
          this.bgTransitionDuration = 0;
        }
        break;
      }
      case "ld": {
        const slot = arg(0).toLowerCase();
        const idx = slot === "l" ? 0 : slot === "c" ? 1 : slot === "r" ? 2 : -1;
        if (idx < 0) break;
        const spec = parseSpec(this.evalStr(arg(1)), this.script.define.defaultMode);
        void this.placeTachi(idx, spec);
        break;
      }
      case "cl": {
        const slot = arg(0).toLowerCase();
        if (slot === "a") this.tachi = [null, null, null];
        else if (slot === "l") this.tachi[0] = null;
        else if (slot === "c") this.tachi[1] = null;
        else if (slot === "r") this.tachi[2] = null;
        break;
      }
      case "lsp":
      case "lsph": {
        const no = num(0);
        const spec = parseSpec(this.evalStr(arg(1)), this.script.define.defaultMode);
        this.setSprite(no, spec, num(2), num(3), name === "lsp");
        break;
      }
      case "csp": {
        const no = num(0);
        if (no < 0) this.sprites.clear();
        else this.sprites.delete(no);
        break;
      }
      case "vsp": {
        const sp = this.sprites.get(num(0));
        if (sp) sp.visible = num(1) !== 0;
        break;
      }
      case "msp": {
        const sp = this.sprites.get(num(0));
        if (sp) {
          sp.x += num(1);
          sp.y += num(2);
        }
        break;
      }
      case "amsp": {
        const sp = this.sprites.get(num(0));
        if (sp) {
          sp.x = num(1);
          sp.y = num(2);
        }
        break;
      }
      case "cell": {
        const sp = this.sprites.get(num(0));
        if (sp) sp.cell = num(1);
        break;
      }
      case "spstr":
        this.applyControl(this.evalStr(arg(0)));
        break;

      // ---- buttons
      case "spbtn":
      case "cellcheckspbtn": {
        const spriteNo = num(0);
        const no = num(1);
        if (no >= 1 && this.sprites.has(spriteNo)) {
          this.buttons.push({ no, kind: "sprite", spriteNo });
        }
        break;
      }
      case "exbtn":
      case "cellcheckexbtn": {
        const spriteNo = num(0);
        const no = num(1);
        if (no >= 1 && this.sprites.has(spriteNo)) {
          this.buttons.push({ no, kind: "exbtn", spriteNo, ctl: this.evalStr(arg(2)) });
        }
        break;
      }
      case "exbtn_d": {
        this.exbtnDefault = this.evalStr(arg(0));
        if (this.exbtnDefault) this.applyControl(this.exbtnDefault);
        break;
      }
      case "btndef": {
        this.buttons = [];
        this.btntime = 0;
        const file = this.evalStr(arg(0));
        if (!file || file === "clear") {
          this.btndefFile = null;
          this.btndefImage = null;
        } else {
          this.btndefFile = file;
          await this.loadBtndef(file);
        }
        break;
      }
      case "btn": {
        const no = num(0);
        const x = num(1);
        const y = num(2);
        const w = num(3);
        const h = num(4);
        const sx = num(5);
        const sy = num(6);
        const image = this.btndefImage;
        if (no >= 1 && image) {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          c.getContext("2d")?.drawImage(image, sx, sy, w, h, 0, 0, w, h);
          this.buttons.push({ no, kind: "rect", rect: { x, y, w, h }, src: { x: sx, y: sy, w, h }, image: c });
        }
        break;
      }
      case "btntime":
        this.btntime = num(0);
        break;
      case "btnwait":
      case "btnwait2": {
        const target = this.numIndex(arg(0));
        if (!this.menuLabel) this.updateStoryPosition(this.pc);
        const ev = await this.waitInput("button", this.btntime);
        this.btntime = 0;
        let result = 0;
        if (ev.type === "button") result = ev.no;
        else if (ev.type === "right") result = -1;
        else if (ev.type === "escape") result = -10;
        else if (ev.type === "timeout") result = -5;
        else if (ev.type === "enter") result = 0;
        else if (ev.type === "gosub") {
          this.setVar(target, 0);
          return false;
        }
        else if (ev.type === "trap") {
          this.trapLabel = null;
          this.setVar(target, 0);
          this.cmdQueue = [];
          this.pc = this.labelIndex(ev.label);
          return true;
        }
        this.trace(`btnwait ${name} result=${result} menu=${this.menuLabel}`);
        this.setVar(target, result);
        if (name === "btnwait" && result >= 1) this.buttons = [];
        if (result >= 1) this.hoverButton = null;
        break;
      }
      case "spclclk":
        break;
      case "selectbtnwait":
      case "textbtnwait": {
        const target = this.numIndex(arg(0));
        if (!this.menuLabel) this.updateStoryPosition(this.pc);
        const ev = await this.waitInput("button", this.btntime);
        this.btntime = 0;
        let result = 0;
        if (ev.type === "button") result = ev.no;
        else if (ev.type === "right") result = -1;
        else if (ev.type === "escape") result = -10;
        else if (ev.type === "timeout") result = -5;
        else if (ev.type === "gosub") {
          this.setVar(target, 0);
          return false;
        } else if (ev.type === "trap") {
          this.cmdQueue = [];
          this.setVar(target, 0);
          this.pc = this.labelIndex(ev.label);
          return true;
        }
        this.setVar(target, result);
        break;
      }

      // ---- choices (native overlay)
      case "csel": {
        const choices: Choice[] = [];
        for (let i = 0; i + 1 < args.length; i += 2) {
          choices.push({ text: this.translateLine(this.evalStr(args[i])), label: normalizeLabelArg(args[i + 1]) });
        }
        if (!choices.length) break;
        this.stopTyping();
        this.skipMode = false;
        this.updateStoryPosition(this.pc);
        const idx = await this.hooks.choose(choices);
        if (idx >= 0 && idx < choices.length) {
          this.jump(choices[idx].label);
          return true;
        }
        break;
      }
      case "cselgoto":
        break;

      // ---- audio
      case "bgm": {
        const file = this.evalStr(arg(0));
        if (file) {
          void this.audio.playBgm(file).catch(() => undefined);
          this.bgmFile = file;
        }
        break;
      }
      case "bgmonce": {
        const file = this.evalStr(arg(0));
        if (file) {
          void this.audio.playBgm(file, false).catch(() => undefined);
          this.bgmFile = file;
        }
        break;
      }
      case "bgmstop": {
        this.audio.stopBgm(this.script.define.bgmFadeOut);
        this.bgmFile = null;
        break;
      }
      case "dwave": {
        const ch = num(0);
        const file = this.evalStr(arg(1));
        if (file) void this.audio.playWave(ch, file).catch(() => undefined);
        break;
      }
      case "dwavestop":
        this.audio.stopWave(num(0));
        break;
      case "mp3vol":
      case "bgmvol":
        this.audio.setBgmVolume(num(0));
        break;
      case "sevol":
        this.audio.setSeVolume(num(0));
        break;
      case "voicevol":
        this.audio.setVoiceVolume(num(0));
        break;
      case "stop":
        this.audio.stopAll();
        this.bgmFile = null;
        break;

      // ---- waits
      case "delay": {
        const ms = num(0);
        if (this.skipMode) break;
        const ev = await this.waitInput("delay", ms);
        if (ev.type === "trap") {
          this.cmdQueue = [];
          this.pc = this.labelIndex(ev.label);
          return true;
        }
        break;
      }
      case "resettimer":
        this.timerStart = performance.now();
        break;
      case "waittimer": {
        if (this.skipMode) break;
        const ms = num(0);
        const remain = Math.max(0, ms - (performance.now() - this.timerStart));
        const ev = await this.waitInput("timer", remain);
        if (ev.type === "trap") {
          this.cmdQueue = [];
          this.pc = this.labelIndex(ev.label);
          return true;
        }
        break;
      }
      case "quake":
      case "quakex":
      case "quakey": {
        const amp = num(0, 4);
        const ms = num(1, 400);
        this.quake = {
          until: performance.now() + ms,
          amp,
          horizontal: name !== "quakey",
          vertical: name !== "quakex",
        };
        break;
      }
      case "flushout":
        break;

      // ---- traps / modes
      case "trap":
        if (arg(0).toLowerCase() === "off") this.trapLabel = null;
        else this.trapLabel = normalizeLabelArg(arg(0));
        break;
      case "skipoff":
        this.skipMode = false;
        break;
      case "saveoff":
        this.saveEnabled = false;
        break;
      case "saveon":
        this.saveEnabled = true;
        break;

      // ---- misc
      case "mpegplay": {
        this.stopTyping();
        const file = this.evalStr(arg(0));
        await this.hooks.movie(file);
        break;
      }
      case "systemcall": {
        const what = arg(0).toLowerCase();
        if (what === "lookback") this.hooks.backlog(this.history);
        else if (what === "skip") this.skipMode = true;
        else if (what === "windowerase") this.textLines = [];
        break;
      }
      case "isfull": {
        this.setVar(this.numIndex(arg(0)), document.fullscreenElement ? 1 : 0);
        break;
      }
      case "menu_full":
        void document.documentElement.requestFullscreen?.().catch(() => undefined);
        break;
      case "menu_automode":
        this.autoMode = true;
        this.scheduleAuto();
        break;
      case "menu_window":
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        break;
      case "lookbackflush":
        this.history = [];
        break;
      case "lookbackoff":
        this.lookbackOn = false;
        break;
      case "lookbackon":
        this.lookbackOn = true;
        break;
      case "savetime": {
        const slot = this.evalNum(arg(0));
        const parts = this.saves.dateParts(slot);
        this.setVar(this.numIndex(arg(1)), parts.month);
        this.setVar(this.numIndex(arg(2)), parts.day);
        this.setVar(this.numIndex(arg(3)), parts.hour);
        this.setVar(this.numIndex(arg(4)), parts.minute);
        if (arg(5)) this.setVar(this.numIndex(arg(5)), new Date().getFullYear() % 100);
        break;
      }
      case "savegame":
      case "savegame2": {
        const slot = this.evalNum(arg(0));
        const snap = this.lastTextSnapshot ?? this.captureSnapshot(this.pc, this.textLines);
        this.saves.put(slot, snap);
        this.seedSaveLabels();
        break;
      }
      case "loadgame": {
        const slot = this.evalNum(arg(0));
        const s = this.saves.get(slot);
        if (s && s.snapshot.version === 2 && Array.isArray(s.snapshot.buttons)) {
          await this.restoreSnapshot(s.snapshot);
          this.cmdQueue = [];
          this.pc = s.snapshot.pc;
          this.callStack = [];
          this.loops = [];
          this.buttons = [];
          this.trapLabel = null;
          this.pendingGosub = null;
          this.menuLabel = null;
          this.menuReturnDepth = -1;
          this.menuResumePc = null;
          this.scheduleState();
          return true;
        }
        break;
      }
      case "end":
        this.finish();
        break;
      case "requestgosub":
        this.pendingGosub = normalizeLabelArg(arg(0));
        break;

      // ---- no-ops / definition-only directives
      case "game":
      case "caption":
      case "versionstr":
      case "automode":
      case "automode_time":
      case "kidokuskip":
      case "filelog":
      case "labellog":
      case "globalon":
      case "nsa":
      case "savenumber":
      case "noloaderror":
      case "resetmenu":
      case "deletemenu":
      case "defaultfont":
      case "selectcolor":
      case "lookbackcolor":
      case "lookbacksp":
      case "maxkaisoupage":
      case "noteraseman":
      case "humanz":
      case "windowback":
      case "underline":
      case "usewheel":
      case "useescspc":
      case "roff":
      case "effectcut":
      case "windoweffect":
      case "effect":
      case "transmode":
      case "intlimit":
      case "mp3fadeout":
      case "chkcdfile":
      case "cselbtn":
      case "getcselnum":
      case "defvoicevol":
      case "defsevol":
      case "defmp3vol":
      case "mid":
      case "split":
      case "cmp":
      case "sin":
      case "cos":
      case "tan":
      case "strsp":
      case "strsph":
        break;
      default:
        // Unknown commands are ignored, like NScripter does for unsupported
        // extensions. Keep a console note for reverse-engineering.
        if (!knownCommand(name)) console.debug("amehare: unhandled command", name);
        break;
    }
    return false;
  }

  bgmFile: string | null = null;

  // ---------------------------------------------------------------- helpers

  private async loadBtndef(file: string) {
    try {
      const img = await this.assets.raw(file);
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")?.drawImage(img, 0, 0);
      this.btndefImage = c;
    } catch {
      this.btndefImage = null;
    }
  }

  private setSprite(no: number, spec: ImageSpec, x: number, y: number, visible: boolean) {
    const old = this.sprites.get(no);
    this.sprites.set(no, {
      no,
      spec,
      x,
      y,
      visible,
      cell: old && old.spec.file === spec.file ? old.cell : 0,
    });
    void this.assets
      .loadSpec(spec)
      .then((li) => this.spriteDims.set(no, { w: li.cellW, h: li.cellH, cells: li.cells.length }))
      .catch(() => undefined);
  }

  private async placeTachi(idx: number, spec: ImageSpec) {
    try {
      const li = await this.assets.loadSpec(spec);
      const w = li.cellW;
      const h = li.cellH;
      const x = (800 * (idx + 1)) / 4 - w / 2;
      const y = this.script.define.underline - h;
      this.tachi[idx] = { slot: idx as 0 | 1 | 2, spec, x, y, visible: true };
    } catch {
      this.tachi[idx] = null;
    }
  }

  private applyControl(ctl: string) {
    let i = 0;
    while (i < ctl.length) {
      const c = ctl[i];
      if (c === "C" || c === "c") {
        i++;
        const a = readInt(ctl, i);
        i = a.pos;
        let b = a.value;
        if (ctl[i] === "-") {
          i++;
          const b2 = readInt(ctl, i);
          i = b2.pos;
          b = b2.value;
        }
        for (let n = a.value; n <= b; n++) {
          const sp = this.sprites.get(n);
          if (sp) sp.visible = false;
        }
      } else if (c === "P" || c === "p") {
        i++;
        const a = readInt(ctl, i);
        i = a.pos;
        let cell = 0;
        if (ctl[i] === ",") {
          i++;
          const b = readInt(ctl, i);
          i = b.pos;
          cell = b.value;
        }
        const sp = this.sprites.get(a.value);
        if (sp) {
          sp.visible = true;
          sp.cell = cell;
        }
      } else if (c === "M" || c === "m") {
        i++;
        const a = readInt(ctl, i);
        i = a.pos;
        const sp = this.sprites.get(a.value);
        if (sp && ctl[i] === ",") {
          i++;
          const b = readInt(ctl, i);
          i = b.pos;
          if (ctl[i] === ",") {
            i++;
            const d = readInt(ctl, i);
            i = d.pos;
            sp.x = b.value;
            sp.y = d.value;
          }
        }
      } else if (c === "S" || c === "s") {
        i++;
        while (i < ctl.length && ctl[i] !== ")") i++;
        if (ctl[i] === ")") i++;
      } else {
        i++;
      }
    }
  }

  private jump(token: string, isCall = false) {
    const label = normalizeLabelArg(token);
    this.trace(`jump ${label} menu=${this.menuLabel} pc=${this.pc} call=${isCall}`);
    const lower = label.toLowerCase();
    if (!isCall && this.menuLabel) {
      const prefix = menuPrefix(this.menuLabel);
      if (prefix && lower !== this.menuLabel.toLowerCase() && !lower.startsWith(prefix)) {
        this.menuLabel = null;
        this.menuReturnDepth = -1;
        this.menuResumePc = null;
        this.callStack = [];
        this.scheduleState();
      }
    }
    this.cmdQueue = [];
    this.pc = this.labelIndex(label);
  }

  private labelIndex(token: string): number {
    const label = normalizeLabelArg(token).toLowerCase();
    const idx = this.script.labels[label];
    if (idx === undefined) {
      throw new Error(`label not found: ${token}`);
    }
    this.lastLabel = label;
    return idx;
  }

  private buildLineLabels() {
    let current = "";
    this.lineLabels = this.script.lines.map((line) => {
      if (line.kind === "label" && line.label) current = line.label;
      return current;
    });
  }

  private labelForPc(pc: number): string {
    return this.lineLabels[pc] ?? "";
  }

  private trace(msg: string) {
    const g = globalThis as unknown as { __AMEHARE_TRACE?: boolean; __trace?: string[] };
    if (g.__AMEHARE_TRACE) {
      if (!g.__trace) g.__trace = [];
      g.__trace.push(msg);
      if (g.__trace.length > 5000) g.__trace.splice(0, g.__trace.length - 5000);
    }
  }

  private updateStoryPosition(pc: number) {
    if (this.menuLabel) return;
    this.storyPc = pc;
    this.storyLabel = this.labelForPc(pc);
    this.scheduleState();
  }

  private maybeCloseMenu() {
    this.trace(`maybeCloseMenu menu=${this.menuLabel} depth=${this.callStack.length} retDepth=${this.menuReturnDepth}`);
    if (this.menuLabel && this.callStack.length <= this.menuReturnDepth) {
      if (this.menuResumePc !== null) {
        if (this.lastTextSnapshot && this.lastTextSnapshot.pc === this.menuResumePc) {
          this.textLines = [...this.lastTextSnapshot.textLines];
          this.revealed = 0;
          this.revealedFrom = 0;
        }
        this.pc = this.menuResumePc;
        this.cmdQueue = [];
        this.menuResumePc = null;
      }
      this.menuLabel = null;
      this.menuReturnDepth = -1;
      this.scheduleState();
    }
  }

  private scheduleState() {
    if (this.suppressState) return;
    if (this.stateTimer !== null) return;
    this.stateTimer = window.setTimeout(() => {
      this.stateTimer = null;
      this.emitState();
    }, 250);
  }

  private emitState() {
    if (this.suppressState) return;
    const snapshot = this.storySnapshot();
    const state: UrlState = {
      scene: this.storyLabel,
      cmd: this.storyPc,
      menu: this.menuLabel,
      snapshot,
    };
    this.hooks.state?.(state);
  }

  storySnapshot(): Snapshot {
    if (this.lastTextSnapshot && this.lastTextSnapshot.pc === this.storyPc) {
      return this.lastTextSnapshot;
    }
    return this.captureSnapshot(this.storyPc, this.textLines);
  }

  private numIndex(arg: string): number {
    const s = arg.trim();
    if (!s.startsWith("%")) throw new Error(`not a numeric variable: ${arg}`);
    return this.evalNum(s.slice(1)) | 0;
  }

  private strIndex(arg: string): number {
    const s = arg.trim();
    if (!s.startsWith("$")) throw new Error(`not a string variable: ${arg}`);
    const rest = s.slice(1).trim();
    if (rest.startsWith("%")) {
      const m = /^%([0-9]+)/.exec(rest);
      const varNo = m ? parseInt(m[1], 10) : 0;
      return this.getVar(varNo) | 0;
    }
    const n = parseInt(rest, 10);
    return Number.isFinite(n) ? n : 0;
  }

  getVar(i: number): number {
    return this.vars[i] ?? 0;
  }

  setVar(i: number, v: number) {
    let x = Math.trunc(Number(v) || 0);
    const lim = this.script.define.intLimits[i];
    if (lim) x = Math.max(lim[0], Math.min(lim[1], x));
    this.vars[i] = x;
    if (i >= GLOBAL_BORDER) this.scheduleGlobals();
  }

  getStr(i: number): string {
    return this.strs[i] ?? "";
  }

  setStr(i: number, v: string) {
    this.strs[i] = v;
    if (i >= GLOBAL_BORDER) this.scheduleGlobals();
  }

  private evalNum(expr: string, fallback = 0): number {
    try {
      const p = new ExprParser(expr, this);
      const v = p.parse();
      if (p.pos < expr.trim().length) return typeof v === "number" ? v : parseInt(v, 10) || fallback;
      return typeof v === "number" ? v : parseInt(v, 10) || fallback;
    } catch {
      return fallback;
    }
  }

  private evalStr(expr: string): string {
    const s = expr.trim();
    if (!s) return "";
    // NScripter file-log form: ("tag")"first""second". The tag is the CG
    // filename; "first" is the thumbnail shown once it has been logged and
    // "second" is the dummy used for unseen CGs. We always take the thumbnail.
    const tagged = /^\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*"((?:[^"\\]|\\.)*)"\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(s);
    if (tagged) return tagged[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (s.startsWith('"')) return unquote(s);
    if (s.startsWith("$")) return this.getStr(this.strIndex(s));
    return s;
  }

  // ---------------------------------------------------------------- saves

  private captureSnapshot(pc: number, lines: string[]): Snapshot {
    const vars: Record<number, number> = {};
    for (let i = 0; i < this.vars.length; i++) if (this.vars[i]) vars[i] = this.vars[i];
    const strs: Record<number, string> = {};
    for (let i = 0; i < this.strs.length; i++) if (this.strs[i]) strs[i] = this.strs[i];
    return {
      version: 2,
      pc,
      vars,
      strs,
      textLines: [...lines],
      textWindow: { ...this.textWindow },
      textColor: this.textColor,
      bg: this.bg,
      tachi: this.tachi.filter((t): t is TachiState => !!t).map((t) => ({ ...t })),
      sprites: Object.fromEntries([...this.sprites.entries()].map(([k, v]) => [k, { ...v }])),
      buttons: this.buttons.map((b) => ({
        no: b.no,
        kind: b.kind,
        spriteNo: b.spriteNo,
        ctl: b.ctl,
        rect: b.rect ? { ...b.rect } : undefined,
        src: b.src ? { ...b.src } : undefined,
      })),
      exbtnDefault: this.exbtnDefault,
      btndefFile: this.btndefFile,
      btntime: this.btntime,
      audio: (() => {
        const vol = this.audio.getVolumes();
        return { bgm: this.bgmFile, bgmVolume: vol.bgm, seVolume: vol.se, voiceVolume: vol.voice };
      })(),
      saveEnabled: this.saveEnabled,
      chapter: this.getStr(89),
      location: this.getStr(90),
      savedAt: Date.now(),
    };
  }

  async restoreSnapshot(s: Snapshot) {
    this.stopTyping();
    this.stopAuto();
    this.audio.stopAll();
    this.vars = new Array(1000).fill(0);
    this.strs = new Array(1000).fill("");
    for (const [k, v] of Object.entries(s.vars)) this.vars[Number(k)] = v;
    for (const [k, v] of Object.entries(s.strs)) this.strs[Number(k)] = v;
    this.textLines = [...s.textLines];
    this.textWindow = { ...s.textWindow };
    this.textColor = s.textColor;
    this.bg = s.bg;
    this.tachi = [null, null, null];
    for (const t of s.tachi) this.tachi[t.slot] = { ...t };
    this.sprites.clear();
    for (const [k, v] of Object.entries(s.sprites)) this.sprites.set(Number(k), { ...v });
    this.spriteDims.clear();
    const dims = await Promise.all(
      [...this.sprites.entries()].map(async ([no, sp]) => {
        try {
          const li = await this.assets.loadSpec(sp.spec);
          return [no, { w: li.cellW, h: li.cellH, cells: li.cells.length }] as const;
        } catch {
          return null;
        }
      }),
    );
    for (const d of dims) if (d) this.spriteDims.set(d[0], d[1]);
    this.saveEnabled = s.saveEnabled;
    this.exbtnDefault = s.exbtnDefault ?? null;
    this.btndefFile = s.btndefFile ?? null;
    this.btntime = s.btntime ?? 0;
    this.buttons = [];
    this.hoverButton = null;
    if (this.btndefFile) await this.loadBtndef(this.btndefFile);
    else this.btndefImage = null;
    for (const b of s.buttons ?? []) {
      if (b.kind === "rect") {
        if (!b.rect || !b.src || !this.btndefImage) continue;
        const c = document.createElement("canvas");
        c.width = b.rect.w;
        c.height = b.rect.h;
        c.getContext("2d")?.drawImage(
          this.btndefImage,
          b.src.x,
          b.src.y,
          b.src.w,
          b.src.h,
          0,
          0,
          b.rect.w,
          b.rect.h,
        );
        this.buttons.push({ no: b.no, kind: "rect", rect: b.rect, src: b.src, image: c });
      } else {
        this.buttons.push({ no: b.no, kind: b.kind, spriteNo: b.spriteNo, ctl: b.ctl });
      }
    }
    this.revealed = this.totalChars();
    this.revealedFrom = this.revealed;
    this.audio.setBgmVolume(s.audio.bgmVolume ?? this.script.define.defBgmVol);
    this.audio.setSeVolume(s.audio.seVolume ?? this.script.define.defSeVol);
    this.audio.setVoiceVolume(s.audio.voiceVolume ?? this.script.define.defVoiceVol);
    this.bgmFile = s.audio.bgm;
    if (s.audio.bgm) void this.audio.playBgm(s.audio.bgm).catch(() => undefined);
    this.storyPc = s.pc;
    this.storyLabel = this.labelForPc(s.pc);
    this.seedSaveLabels();
    this.persistGlobalsNow();
  }

  private seedSaveLabels() {
    for (const s of this.saves.all()) {
      if (!this.strs[200 + s.meta.slot]) this.strs[200 + s.meta.slot] = s.meta.chapter;
      if (!this.strs[248 + s.meta.slot]) this.strs[248 + s.meta.slot] = s.meta.location;
    }
  }

  private loadGlobals() {
    const g = this.saves.loadGlobals();
    if (!g) return;
    for (const [k, v] of Object.entries(g.vars)) {
      const i = Number(k);
      if (i >= GLOBAL_BORDER) this.vars[i] = v;
    }
    for (const [k, v] of Object.entries(g.strs)) {
      const i = Number(k);
      if (i >= GLOBAL_BORDER) this.strs[i] = v;
    }
  }

  private scheduleGlobals() {
    if (this.globalsTimer !== null) return;
    this.globalsTimer = window.setTimeout(() => {
      this.globalsTimer = null;
      this.persistGlobalsNow();
    }, 1000);
  }

  persistGlobalsNow() {
    const vars: Record<number, number> = {};
    const strs: Record<number, string> = {};
    for (let i = GLOBAL_BORDER; i < this.vars.length; i++) if (this.vars[i]) vars[i] = this.vars[i];
    for (let i = GLOBAL_BORDER; i < this.strs.length; i++) if (this.strs[i]) strs[i] = this.strs[i];
    this.saves.saveGlobals({ vars, strs });
  }

  hasSeenLabel(label: string): boolean {
    return this.seenLabels.has(label.toLowerCase());
  }

  setTranslations(t: TranslationData | null) {
    this.translations = t;
    this.hooks.requestRender();
  }

  setLanguage(lang: "ja" | "en") {
    this.language = lang;
    this.stopTyping();
    this.revealed = this.totalChars();
    this.typing = false;
    this.hooks.requestRender();
  }

  translateLine(text: string): string {
    if (this.language !== "en" || !this.translations) return text;
    return this.translations.text[text] ?? this.translations.text[text.trim()] ?? text;
  }

  translateSprite(text: string): string {
    if (this.language !== "en" || !this.translations) return text;
    return this.translations.sprites[text] ?? this.translations.sprites[text.trim()] ?? text;
  }

  speakerText(): string | null {
    const sp = this.sprites.get(91);
    if (!sp || sp.spec.mode !== "s") return null;
    return this.translateSprite(sp.spec.file);
  }

  private markLabel(label: string) {
    const key = label.toLowerCase();
    if (this.seenLabels.has(key)) return;
    this.seenLabels.add(key);
    if (this.seenTimer !== null) return;
    this.seenTimer = window.setTimeout(() => {
      this.seenTimer = null;
      try {
        localStorage.setItem("amehare.seen.v1", JSON.stringify([...this.seenLabels]));
      } catch {
        /* ignore quota */
      }
    }, 500);
  }

  private loadSeenLabels() {
    try {
      const raw = localStorage.getItem("amehare.seen.v1");
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        for (const x of arr) if (typeof x === "string") this.seenLabels.add(x.toLowerCase());
      }
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- UI hooks

  requestGosub(label: string) {
    const menu = normalizeLabelArg(label);
    this.menuLabel = menu;
    this.menuReturnDepth = this.callStack.length;
    if (this.waitKind === "text" && this.lastTextSnapshot) {
      this.menuResumePc = this.lastTextSnapshot.pc;
    } else if (this.waitKind === "button") {
      this.menuResumePc = this.storyPc;
    } else {
      this.menuResumePc = this.pc;
    }
    this.scheduleState();
    if (this.waitKind === "text" && this.waiter) {
      this.pendingGosub = menu;
      this.stopTyping();
      this.waiter({ type: "gosub", label: menu });
      return;
    }
    if (this.waitKind === "button" && this.waiter) {
      this.pendingGosub = menu;
      this.waiter({ type: "gosub", label: menu });
      return;
    }
    if (this.waitKind === "none" && !this.typing) {
      this.pendingGosub = menu;
      return;
    }
    this.pendingGosub = menu;
  }

  toggleAuto() {
    this.autoMode = !this.autoMode;
    if (this.autoMode) this.scheduleAuto();
    else this.stopAuto();
  }

  toggleSkip() {
    this.skipMode = !this.skipMode;
    if (this.skipMode) {
      this.autoMode = false;
      if (this.waitKind === "text") {
        this.revealed = this.totalChars();
        this.stopTyping();
        this.waiter?.({ type: "left" });
      }
    }
  }

  debugState(): DebugState {
    const line = this.script.lines[this.pc];
    const vars: Record<string, number> = {};
    for (let i = 0; i < 250; i++) if (this.vars[i]) vars[`%${i}`] = this.vars[i];
    return {
      pc: this.pc,
      line: line?.no ?? 0,
      label: this.lastLabel,
      command: line?.raw ?? "",
      waiting: this.waitKind,
      text: [...this.textLines],
      bg: this.bg,
      sprites: this.sprites.size,
      vars,
      saveEnabled: this.saveEnabled,
      skip: this.skipMode,
      auto: this.autoMode,
    };
  }

  currentCommand(): ScriptLine | undefined {
    return this.script.lines[this.pc];
  }

  waitKindText(): boolean {
    return this.waitKind === "text" || this.waitKind === "delay" || this.waitKind === "timer";
  }

  menuOpen(): boolean {
    return this.menuLabel !== null;
  }

  overlayVisible(): boolean {
    return this.textVisible && this.waitKind !== "button";
  }

  persistState() {
    this.emitState();
  }
}

// ------------------------------------------------------------------ expression

class ExprParser {
  readonly s: string;
  pos = 0;
  private vm: Vm;

  constructor(s: string, vm: Vm) {
    this.s = s;
    this.vm = vm;
  }

  parse(): Value {
    return this.parseOr();
  }

  private ws() {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }

  private parseOr(): Value {
    let v = this.parseAnd();
    while (true) {
      this.ws();
      if (this.s[this.pos] !== "|") break;
      this.pos++;
      const r = this.parseAnd();
      v = truthy(v) || truthy(r) ? 1 : 0;
    }
    return v;
  }

  private parseAnd(): Value {
    let v = this.parseCompare();
    while (true) {
      this.ws();
      if (this.s[this.pos] !== "&") break;
      this.pos++;
      const r = this.parseCompare();
      v = truthy(v) && truthy(r) ? 1 : 0;
    }
    return v;
  }

  private parseCompare(): Value {
    const left = this.parseAdd();
    this.ws();
    const two = this.s.slice(this.pos, this.pos + 2);
    let op = "";
    if (two === "<>" || two === "<=" || two === ">=") {
      op = two;
      this.pos += 2;
    } else if ("<>=".includes(this.s[this.pos])) {
      op = this.s[this.pos];
      this.pos++;
    }
    if (!op) return left;
    const right = this.parseAdd();
    if (typeof left === "string" || typeof right === "string") {
      const a = String(left);
      const b = String(right);
      switch (op) {
        case "=":
          return a === b ? 1 : 0;
        case "<>":
          return a !== b ? 1 : 0;
        case "<":
          return a < b ? 1 : 0;
        case ">":
          return a > b ? 1 : 0;
        case "<=":
          return a <= b ? 1 : 0;
        case ">=":
          return a >= b ? 1 : 0;
      }
    }
    const a = Number(left);
    const b = Number(right);
    switch (op) {
      case "=":
        return a === b ? 1 : 0;
      case "<>":
        return a !== b ? 1 : 0;
      case "<":
        return a < b ? 1 : 0;
      case ">":
        return a > b ? 1 : 0;
      case "<=":
        return a <= b ? 1 : 0;
      case ">=":
        return a >= b ? 1 : 0;
    }
    return left;
  }

  private parseAdd(): Value {
    let v = this.parseMul();
    while (true) {
      this.ws();
      const c = this.s[this.pos];
      if (c !== "+" && c !== "-") break;
      this.pos++;
      const r = this.parseMul();
      if (typeof v === "string" || typeof r === "string") {
        v = String(v) + String(r);
      } else {
        v = c === "+" ? v + r : v - r;
      }
    }
    return v;
  }

  private parseMul(): Value {
    let v = this.parseUnary();
    while (true) {
      this.ws();
      const c = this.s[this.pos];
      if (c !== "*" && c !== "/" && c !== "%") break;
      this.pos++;
      const r = this.parseUnary();
      const a = Number(v);
      const b = Number(r);
      if (c === "*") v = a * b;
      else if (c === "/") v = b === 0 ? 0 : Math.trunc(a / b);
      else v = b === 0 ? 0 : a % b;
    }
    return v;
  }

  private parseUnary(): Value {
    this.ws();
    const c = this.s[this.pos];
    if (c === "-") {
      this.pos++;
      return -Number(this.parseUnary());
    }
    if (c === "+") {
      this.pos++;
      return Number(this.parseUnary());
    }
    if (c === "!") {
      this.pos++;
      return truthy(this.parseUnary()) ? 0 : 1;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Value {
    this.ws();
    if (this.s.startsWith("lchk", this.pos)) {
      const after = this.pos + 4;
      if (after >= this.s.length || this.s[after] === " " || this.s[after] === "\t" || this.s[after] === "*") {
        this.pos = after;
        this.ws();
        if (this.s[this.pos] === "*") this.pos++;
        let n = "";
        while (this.pos < this.s.length && /[A-Za-z0-9_]/.test(this.s[this.pos])) n += this.s[this.pos++];
        return this.vm.hasSeenLabel(n) ? 1 : 0;
      }
    }
    const c = this.s[this.pos];
    if (c === undefined) return 0;
    if (c === "(") {
      this.pos++;
      const v = this.parseOr();
      this.ws();
      if (this.s[this.pos] === ")") this.pos++;
      return v;
    }
    if (c === '"') {
      this.pos++;
      let out = "";
      while (this.pos < this.s.length) {
        const ch = this.s[this.pos++];
        if (ch === "\\" && this.pos < this.s.length) {
          out += this.s[this.pos++];
        } else if (ch === '"') {
          break;
        } else {
          out += ch;
        }
      }
      return out;
    }
    if (c === "%") {
      this.pos++;
      let n = "";
      while (this.pos < this.s.length && /[0-9]/.test(this.s[this.pos])) n += this.s[this.pos++];
      if (!n) return 0;
      return this.vm["getVar"](parseInt(n, 10));
    }
    if (c === "$") {
      this.pos++;
      if (this.s[this.pos] === "%") {
        this.pos++;
        let n = "";
        while (this.pos < this.s.length && /[0-9]/.test(this.s[this.pos])) n += this.s[this.pos++];
        const idx = this.vm["getVar"](parseInt(n || "0", 10));
        return this.vm["getStr"](idx);
      }
      let n = "";
      while (this.pos < this.s.length && /[0-9]/.test(this.s[this.pos])) n += this.s[this.pos++];
      return this.vm["getStr"](parseInt(n || "0", 10));
    }
    if (/[0-9]/.test(c)) {
      let n = "";
      while (this.pos < this.s.length && /[0-9]/.test(this.s[this.pos])) n += this.s[this.pos++];
      return parseInt(n, 10);
    }
    // Stop at a command keyword; leave the position untouched.
    return 0;
  }
}

function truthy(v: Value): boolean {
  if (typeof v === "string") return v !== "" && v !== "0";
  return v !== 0;
}

function readInt(s: string, pos: number): { value: number; pos: number } {
  let i = pos;
  let n = "";
  while (i < s.length && /[0-9]/.test(s[i])) n += s[i++];
  return { value: parseInt(n || "0", 10), pos: i };
}

function normalizeLabelArg(s: string): string {
  let t = s.trim();
  if (t.startsWith("*")) t = t.slice(1);
  return t;
}

function menuPrefix(label: string): string {
  const map: Record<string, string> = {
    save_menu: "sm_",
    load_menu: "lm_",
    config_menu: "cm_",
    backtitle_dlg: "btd_",
    append_menu: "am_",
    music_menu: "mm_",
    gallery_menu: "ga_",
    replay_menu: "rm_",
    omake_menu: "om_",
    title_menu: "tm_",
  };
  return map[label.toLowerCase()] ?? "";
}

function toFullWidth(s: string): string {
  return s.replace(/[0-9]/g, (c) => String.fromCharCode(0xff10 + (c.charCodeAt(0) - 48)));
}

const KNOWN = new Set([
  "mov", "mov3", "mov4", "mov5", "mov6", "mov7", "mov8", "mov9", "mov10",
  "add", "sub", "mul", "div", "mod", "inc", "dec", "itoa", "itoa2", "len",
  "atoi", "rnd", "rnd2", "goto", "gosub", "return", "tablegoto", "for", "next",
  "break", "textclear", "textoff", "texton", "erasetextwindow", "texec",
  "getpageup", "gettab", "getfunction", "textgosub", "textspeed", "ispage",
  "getcursorpos", "print", "bg", "ld", "cl", "lsp", "lsph", "csp", "vsp",
  "msp", "amsp", "cell", "spstr", "spbtn", "cellcheckspbtn", "exbtn",
  "cellcheckexbtn", "exbtn_d", "btndef", "btn", "btntime", "btnwait", "btnwait2",
  "spclclk", "csel", "cselgoto", "bgm", "bgmonce", "bgmstop", "dwave", "dwavestop",
  "mp3vol", "bgmvol", "sevol", "voicevol", "stop", "delay", "resettimer",
  "waittimer", "quake", "quakex", "quakey", "flushout", "trap", "skipoff",
  "saveoff", "saveon", "mpegplay", "systemcall", "isfull", "menu_full",
  "menu_automode", "menu_window", "lookbackflush", "lookbackoff", "lookbackon", "savetime",
  "savegame", "savegame2", "loadgame", "end",
]);

function knownCommand(name: string): boolean {
  return KNOWN.has(name);
}
