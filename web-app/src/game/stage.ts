import type { ImageSpec } from "./types";
import type { Vm } from "./vm";
import { specKey } from "./script";
import type { AssetStore, LoadedImage } from "./assets";

export class StageRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private assets: AssetStore;
  private vm: Vm;
  private specCache = new Map<string, LoadedImage>();
  private rawCache = new Map<string, HTMLImageElement>();
  private pending = new Set<string>();
  private signCache = new WeakMap<HTMLCanvasElement, boolean>();

  constructor(canvas: HTMLCanvasElement, assets: AssetStore, vm: Vm) {
    this.canvas = canvas;
    this.canvas.width = 800;
    this.canvas.height = 600;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.assets = assets;
    this.vm = vm;
  }

  private getSpec(spec: ImageSpec): LoadedImage | null {
    const key = specKey(spec);
    const hit = this.specCache.get(key);
    if (hit) return hit;
    if (!this.pending.has(key)) {
      this.pending.add(key);
      this.assets
        .loadSpec(spec)
        .then((li) => this.specCache.set(key, li))
        .catch(() => undefined)
        .finally(() => this.pending.delete(key));
    }
    return null;
  }

  private getRaw(file: string): HTMLImageElement | null {
    const hit = this.rawCache.get(file);
    if (hit) return hit;
    if (!this.pending.has("raw:" + file)) {
      this.pending.add("raw:" + file);
      this.assets
        .raw(file)
        .then((img) => this.rawCache.set(file, img))
        .catch(() => undefined)
        .finally(() => this.pending.delete("raw:" + file));
    }
    return null;
  }

  draw(time: number) {
    const ctx = this.ctx;
    const vm = this.vm;
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 800, 600);

    let qx = 0;
    let qy = 0;
    if (vm.quake) {
      if (time > vm.quake.until) {
        vm.quake = null;
      } else {
        const phase = Math.sin(time / 17) * vm.quake.amp;
        if (vm.quake.horizontal) qx = phase;
        if (vm.quake.vertical) qy = phase;
      }
    }
    if (qx || qy) ctx.translate(qx, qy);

    this.drawBackground(time);
    this.drawTachi();
    this.drawSprites(true);
    this.drawWindowBack();
    this.drawText();
    this.drawSprites(false);
    this.drawRectButtons();
    ctx.restore();
  }

  private drawBackground(time: number) {
    const vm = this.vm;
    const ctx = this.ctx;
    if (vm.bgTransitionDuration > 0 && vm.bgFrom && vm.bgFrom !== vm.bg) {
      const t = Math.min(1, (time - vm.bgTransitionStart) / vm.bgTransitionDuration);
      this.drawBgImage(vm.bgFrom, 1);
      this.drawBgImage(vm.bg, t);
      if (t >= 1) {
        vm.bgFrom = null;
        vm.bgTransitionDuration = 0;
      }
    } else {
      this.drawBgImage(vm.bg, 1);
    }
    ctx.fillStyle = "rgba(0,0,0,0)";
  }

  private drawBgImage(file: string | null, alpha: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (!file || file.toLowerCase() === "black") {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 800, 600);
    } else {
      const img = this.getRaw(file);
      if (img) {
        const y = Math.floor((600 - img.naturalHeight) / 2);
        ctx.drawImage(img, 0, y);
      } else {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 800, 600);
      }
    }
    ctx.restore();
  }

  private drawWindowBack() {
    if (!this.vm.textVisible) return;
    const w = this.vm.textWindow;
    if (!w.bg) return;
    const img = this.getSpec(w.bg);
    if (!img) return;
    const cell = img.cells[0];
    if (!cell) return;
    this.ctx.drawImage(cell, w.bgX, w.bgY);
  }

  private drawTachi() {
    for (let i = 0; i < 3; i++) {
      const t = this.vm.tachi[i];
      if (!t || !t.visible) continue;
      const img = this.getSpec(t.spec);
      if (!img) continue;
      const cell = img.cells[Math.min(t.spec.cells - 1, 0)];
      if (cell) this.ctx.drawImage(cell, t.x, t.y);
    }
  }

  private drawSprites(beforeWindow: boolean) {
    const entries = [...this.vm.sprites.values()].sort((a, b) => b.no - a.no);
    for (const sp of entries) {
      const isWindowFrame = sp.no === 108 || sp.no === 109;
      if (isWindowFrame !== beforeWindow) continue;
      if (!sp.visible) continue;
      const img = this.getSpec(sp.spec);
      if (!img) continue;
      const cell = img.cells[Math.max(0, Math.min(img.cells.length - 1, sp.cell))];
      if (cell) {
        this.ctx.drawImage(cell, sp.x, sp.y);
        if (sp.no === 108) this.maskSmokingSign(cell, sp.x, sp.y);
      }
    }
  }

  /**
   * The default top-bar art (mw_bg01u.bmp) includes a decorative, clipped
   * "禁煙 / NO SMOKING" sticker at the far right. It is not a button and looks
   * like an artifact at 800×600, so mask it with the surrounding bar colour.
   */
  private maskSmokingSign(cell: HTMLCanvasElement, x: number, y: number) {
    let has = this.signCache.get(cell);
    if (has === undefined) {
      has = false;
      const cctx = cell.getContext("2d", { willReadFrequently: true });
      const w = Math.min(44, cell.width);
      if (cctx && w > 0) {
        const data = cctx.getImageData(cell.width - w, 0, w, 28).data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 150 && data[i + 1] < 80 && data[i + 2] < 80) {
            has = true;
            break;
          }
        }
      }
      this.signCache.set(cell, has);
    }
    if (!has) return;
    const cctx = cell.getContext("2d", { willReadFrequently: true });
    const sample = cctx?.getImageData(Math.max(0, cell.width - 60), 5, 1, 1).data;
    this.ctx.fillStyle = sample ? `rgb(${sample[0]},${sample[1]},${sample[2]})` : "#262626";
    this.ctx.fillRect(x + cell.width - 44, y, 44, 28);
  }

  private drawText() {
    const vm = this.vm;
    if (!vm.textVisible || vm.textLines.length === 0) return;
    const w = vm.textWindow;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${w.bold ? "bold " : ""}${w.fontH}px ${definitionFont(vm)}`;
    ctx.textBaseline = "top";
    ctx.fillStyle = vm.textColor;
    let remaining = vm.typing ? vm.revealed : Number.POSITIVE_INFINITY;
    for (let row = 0; row < vm.textLines.length && row < w.rows; row++) {
      const line = vm.textLines[row];
      let x = w.x;
      const y = w.y + row * w.pitchY;
      for (const ch of line) {
        if (remaining <= 0) break;
        ctx.fillText(ch, x, y);
        const adv = ch.charCodeAt(0) < 0x80 ? Math.max(1, Math.floor(w.pitchX / 2)) : w.pitchX;
        x += adv;
        remaining--;
      }
      if (remaining <= 0) break;
    }
    ctx.restore();
  }

  private drawRectButtons() {
    for (const b of this.vm.buttons) {
      if (b.kind !== "rect" || !b.image || !b.rect) continue;
      this.ctx.drawImage(b.image, b.rect.x, b.rect.y);
    }
  }
}

function definitionFont(vm: Vm): string {
  return vm.script.define.fontFamily;
}
