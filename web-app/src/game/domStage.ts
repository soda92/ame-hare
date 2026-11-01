import type { ImageSpec } from "./types";
import type { Vm } from "./vm";
import { specKey } from "./script";
import type { AssetStore } from "./assets";

const W = 800;
const H = 600;

/** Logical 800×600 pixels as container-query width units. */
function u(v: number): string {
  return `${(v / W) * 100}cqw`;
}

interface SpecNode {
  wrap: HTMLDivElement;
  img: HTMLImageElement;
  label: HTMLSpanElement;
  key: string;
}

interface BgNode {
  wrap: HTMLDivElement;
  img: HTMLImageElement;
  file: string | null;
}

/** Minimal high-level DOM renderer for the ADV stage. */
export class DomStageRenderer {
  private root: HTMLDivElement;
  private bgLayer: HTMLDivElement;
  private tachiLayer: HTMLDivElement;
  private spriteLayer: HTMLDivElement;
  private frameLayer: HTMLDivElement;
  private windowLayer: HTMLDivElement;
  private textLayer: HTMLDivElement;
  private frontLayer: HTMLDivElement;
  private buttonLayer: HTMLDivElement;

  private bgNodes: BgNode[] = [];
  private tachiNodes: SpecNode[] = [];
  private spriteNodes = new Map<number, SpecNode>();
  private frameNodes = new Map<number, SpecNode>();
  private frontNodes = new Map<number, SpecNode>();
  private windowNode: SpecNode;
  private textEl: HTMLDivElement;
  private speakerEl: HTMLDivElement;
  private bodyEl: HTMLDivElement;
  private buttonNodes = new Map<object, HTMLImageElement>();

  private urls = new WeakMap<HTMLCanvasElement, string>();
  private masked = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
  private bgDims = new Map<string, { w: number; h: number }>();
  private lastText = "";

  private assets: AssetStore;
  private vm: Vm;

  constructor(container: HTMLElement, assets: AssetStore, vm: Vm) {
    this.assets = assets;
    this.vm = vm;

    this.root = document.createElement("div");
    this.root.className = "dom-stage";

    this.bgLayer = this.layer("dom-bg", 0);
    this.tachiLayer = this.layer("dom-tachi", 100);
    this.spriteLayer = this.layer("dom-sprites", 200);
    this.frameLayer = this.layer("dom-frame", 1000);
    this.windowLayer = this.layer("dom-window", 2000);
    this.textLayer = this.layer("dom-text", 3000);
    this.frontLayer = this.layer("dom-front", 3001);
    this.buttonLayer = this.layer("dom-buttons", 3005);

    for (let i = 0; i < 2; i++) {
      const wrap = document.createElement("div");
      wrap.className = "dom-bg-img";
      wrap.style.zIndex = String(i);
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      wrap.appendChild(img);
      this.bgLayer.appendChild(wrap);
      this.bgNodes.push({ wrap, img, file: null });
    }

    for (let i = 0; i < 3; i++) {
      const node = this.makeSpecNode(this.tachiLayer);
      node.wrap.style.zIndex = String(i);
      this.tachiNodes.push(node);
    }

    this.windowNode = this.makeSpecNode(this.windowLayer);

    this.textEl = document.createElement("div");
    this.textEl.className = "dom-dialogue";
    this.speakerEl = document.createElement("div");
    this.speakerEl.className = "dom-speaker";
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "dom-body";
    this.textEl.append(this.speakerEl, this.bodyEl);
    this.textLayer.appendChild(this.textEl);

    container.replaceChildren(this.root);
  }

  destroy() {
    this.root.remove();
    this.spriteNodes.clear();
    this.frameNodes.clear();
    this.frontNodes.clear();
    this.buttonNodes.clear();
  }

  private layer(name: string, z: number): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `dom-layer ${name}`;
    el.style.zIndex = String(z);
    this.root.appendChild(el);
    return el;
  }

  private makeSpecNode(parent: HTMLElement): SpecNode {
    const wrap = document.createElement("div");
    wrap.className = "dom-spec";
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    const label = document.createElement("span");
    label.className = "dom-string";
    wrap.append(img, label);
    parent.appendChild(wrap);
    return { wrap, img, label, key: "" };
  }

  draw(time: number) {
    const vm = this.vm;
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
    this.root.style.transform = qx || qy ? `translate(${u(qx)}, ${u(qy)})` : "";

    this.drawBackground(time);
    this.drawTachi();
    this.drawBackSprites();
    this.drawFrameSprites();
    this.drawWindowBack();
    this.drawText();
    this.drawFrontSprites();
    this.drawButtons();
  }

  // --------------------------------------------------------------- background

  private drawBackground(time: number) {
    const vm = this.vm;
    if (vm.bgTransitionDuration > 0 && vm.bgFrom && vm.bgFrom !== vm.bg) {
      const t = Math.min(1, (time - vm.bgTransitionStart) / vm.bgTransitionDuration);
      this.syncBg(0, vm.bgFrom, 1);
      this.syncBg(1, vm.bg, t);
      if (t >= 1) {
        vm.bgFrom = null;
        vm.bgTransitionDuration = 0;
      }
    } else {
      this.syncBg(0, vm.bg, 1);
      this.bgNodes[1].wrap.style.display = "none";
    }
  }

  private syncBg(slot: number, file: string | null, alpha: number) {
    const node = this.bgNodes[slot];
    node.wrap.style.opacity = String(alpha);
    if (!file) {
      node.wrap.style.display = "none";
      return;
    }
    node.wrap.style.display = "block";
    const low = file.toLowerCase();
    if (low === "black" || low === "white") {
      node.file = file;
      node.img.style.display = "none";
      node.wrap.style.background = low === "white" ? "#fff" : "#000";
      return;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(file)) {
      node.file = file;
      node.img.style.display = "none";
      node.wrap.style.background = file;
      return;
    }
    node.wrap.style.background = "#000";
    node.img.style.display = "block";
    if (node.file === file) return;
    node.file = file;
    node.img.style.visibility = "hidden";
    node.img.src = this.assets.imageUrl(file);
    const cached = this.bgDims.get(file.toLowerCase());
    if (cached) {
      this.applyBgDims(node, cached);
      return;
    }
    void this.assets
      .raw(file)
      .then((img) => {
        const dims = { w: img.naturalWidth, h: img.naturalHeight };
        this.bgDims.set(file.toLowerCase(), dims);
        if (node.file === file) this.applyBgDims(node, dims);
      })
      .catch(() => undefined);
  }

  private applyBgDims(node: BgNode, dims: { w: number; h: number }) {
    node.img.style.width = u(dims.w);
    node.img.style.height = u(dims.h);
    node.img.style.left = "0";
    node.img.style.top = u((H - dims.h) / 2);
    node.img.style.visibility = "visible";
  }

  // ------------------------------------------------------------------ sprites

  private drawTachi() {
    for (let i = 0; i < 3; i++) {
      const t = this.vm.tachi[i];
      const node = this.tachiNodes[i];
      if (!t || !t.visible || !t.spec) {
        node.wrap.style.display = "none";
        continue;
      }
      node.wrap.style.display = "block";
      this.syncSpec(node, t.spec, t.x, t.y, 0, false);
    }
  }

  private drawBackSprites() {
    this.syncSprites(
      this.spriteNodes,
      this.spriteLayer,
      (no) => no !== 108 && no !== 109 && no >= 100,
      false,
    );
  }

  private drawFrameSprites() {
    this.syncSprites(
      this.frameNodes,
      this.frameLayer,
      (no) => no === 108 || no === 109,
      true,
    );
  }

  private drawFrontSprites() {
    this.syncSprites(
      this.frontNodes,
      this.frontLayer,
      (no) =>
        no !== 108 &&
        no !== 109 &&
        no < 100 &&
        !(this.vm.language === "en" && no === 91),
      false,
    );
  }

  private syncSprites(
    target: Map<number, SpecNode>,
    layer: HTMLElement,
    include: (no: number) => boolean,
    maskSign: boolean,
  ) {
    const seen = new Set<number>();
    for (const sp of this.vm.sprites.values()) {
      if (!include(sp.no)) continue;
      seen.add(sp.no);
      let node = target.get(sp.no);
      if (!node) {
        node = this.makeSpecNode(layer);
        target.set(sp.no, node);
      }
      if (!sp.visible || !sp.spec) {
        node.wrap.style.display = "none";
        continue;
      }
      node.wrap.style.display = "block";
      node.wrap.style.zIndex = String(5000 - sp.no);
      this.syncSpec(node, sp.spec, sp.x, sp.y, sp.cell, maskSign && sp.no === 108);
    }
    for (const [no, node] of [...target]) {
      if (!seen.has(no)) {
        node.wrap.remove();
        target.delete(no);
      }
    }
  }

  private drawWindowBack() {
    const w = this.vm.textWindow;
    if (!this.vm.textVisible || !w.bg) {
      this.windowNode.wrap.style.display = "none";
      return;
    }
    this.windowNode.wrap.style.display = "block";
    this.syncSpec(this.windowNode, w.bg, w.bgX, w.bgY, 0, false);
  }

  private syncSpec(
    node: SpecNode,
    spec: ImageSpec,
    x: number,
    y: number,
    cell: number,
    maskSign: boolean,
  ) {
    node.wrap.style.left = u(x);
    node.wrap.style.top = u(y);
    if (spec.mode === "s") {
      const text = this.vm.translateSprite(spec.file);
      const color = spec.colors[Math.min(cell, Math.max(0, spec.colors.length - 1))] ?? "#ffffff";
      const font = spec.font ?? { w: 24, h: 24, pitchX: 24, pitchY: 24, flags: 0 };
      node.img.style.display = "none";
      node.label.style.display = "block";
      node.wrap.style.width = "auto";
      node.wrap.style.height = "auto";
      if (node.label.textContent !== text) node.label.textContent = text;
      node.label.style.color = color;
      node.label.style.fontFamily = this.vm.script.define.fontFamily;
      node.label.style.fontSize = u(font.h);
      node.label.style.lineHeight = "1";
      node.label.style.letterSpacing = u(font.pitchX - font.w);
      node.key = `s|${specKey(spec)}|${cell}`;
      return;
    }

    node.label.style.display = "none";
    node.img.style.display = "block";
    const key = `${specKey(spec)}|${cell}|${maskSign ? "m" : ""}`;
    if (node.key === key) return;
    node.key = key;
    node.img.style.visibility = "hidden";
    void this.assets
      .loadSpec(spec)
      .then((li) => {
        if (node.key !== key) return;
        const raw = li.cells[Math.max(0, Math.min(li.cells.length - 1, cell))];
        if (!raw) return;
        const c = maskSign ? this.maskSign(raw) : raw;
        node.img.src = this.dataUrl(c);
        node.img.style.width = u(c.width);
        node.img.style.height = u(c.height);
        node.img.style.visibility = "visible";
        node.wrap.style.width = u(c.width);
        node.wrap.style.height = u(c.height);
      })
      .catch(() => undefined);
  }

  private dataUrl(cell: HTMLCanvasElement): string {
    const hit = this.urls.get(cell);
    if (hit) return hit;
    const url = cell.toDataURL("image/png");
    this.urls.set(cell, url);
    return url;
  }

  /**
   * The default top-bar art includes a decorative, clipped "禁煙 / NO
   * SMOKING" sticker. Mask it with the surrounding bar colour, as the canvas
   * renderer did.
   */
  private maskSign(cell: HTMLCanvasElement): HTMLCanvasElement {
    const hit = this.masked.get(cell);
    if (hit) return hit;
    let sticker = false;
    const cctx = cell.getContext("2d", { willReadFrequently: true });
    const w = Math.min(44, cell.width);
    if (cctx && w > 0) {
      const data = cctx.getImageData(cell.width - w, 0, w, 28).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 150 && data[i + 1] < 80 && data[i + 2] < 80) {
          sticker = true;
          break;
        }
      }
    }
    if (!sticker) {
      this.masked.set(cell, cell);
      return cell;
    }
    const out = document.createElement("canvas");
    out.width = cell.width;
    out.height = cell.height;
    const ctx = out.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(cell, 0, 0);
      const sample = cctx?.getImageData(Math.max(0, cell.width - 60), 5, 1, 1).data;
      ctx.fillStyle = sample ? `rgb(${sample[0]},${sample[1]},${sample[2]})` : "#262626";
      ctx.fillRect(cell.width - 44, 0, 44, 28);
    }
    this.masked.set(cell, out);
    return out;
  }

  // --------------------------------------------------------------------- text

  private drawText() {
    const vm = this.vm;
    const w = vm.textWindow;
    const english = vm.language === "en";
    const visible = vm.textVisible && vm.textLines.length > 0 && (!english || vm.overlayVisible());
    if (!visible) {
      this.textEl.style.display = "none";
      this.lastText = "";
      return;
    }
    this.textEl.style.display = "block";
    const lines = english
      ? vm.textLines.map((line) => vm.translateLine(line))
      : vm.textLines;
    const speaker = english ? vm.speakerText() : null;
    this.speakerEl.style.display = speaker ? "block" : "none";
    if (speaker && this.speakerEl.textContent !== speaker) this.speakerEl.textContent = speaker;
    let text: string;
    if (english) {
      text = lines.join("\n");
    } else {
      let remaining = vm.typing ? vm.revealed : Number.POSITIVE_INFINITY;
      text = lines
        .map((line) => {
          if (remaining <= 0) return "";
          const chars = [...line];
          const take = Math.min(chars.length, remaining);
          remaining -= take;
          return chars.slice(0, take).join("");
        })
        .join("\n");
    }
    if (text !== this.lastText) {
      this.bodyEl.textContent = text;
      this.lastText = text;
    }

    this.textEl.classList.toggle("en", english);
    this.textEl.style.left = u(w.x);
    this.textEl.style.width = u(w.cols * w.pitchX);
    this.textEl.style.fontWeight = w.bold ? "700" : "400";
    if (english) {
      this.textEl.style.top = "auto";
      this.textEl.style.bottom = u(H - (w.y + w.rows * w.pitchY));
      this.textEl.style.minHeight = u(w.rows * w.pitchY);
      this.textEl.style.maxHeight = u(240);
      this.textEl.style.fontSize = u(Math.max(w.fontH, 19));
      this.textEl.style.lineHeight = "1.4";
      this.textEl.style.letterSpacing = "0";
      this.textEl.style.fontFamily =
        '"Noto Sans", "Noto Sans JP", system-ui, sans-serif';
      this.textEl.style.color = "#372c19";
    } else {
      this.textEl.style.top = u(w.y);
      this.textEl.style.bottom = "auto";
      this.textEl.style.minHeight = u(w.rows * w.pitchY);
      this.textEl.style.maxHeight = u(w.rows * w.pitchY);
      this.textEl.style.fontSize = u(w.fontH);
      this.textEl.style.lineHeight = u(w.pitchY);
      this.textEl.style.letterSpacing = u(w.pitchX - w.fontW);
      this.textEl.style.fontFamily = vm.script.define.fontFamily;
      this.textEl.style.color = vm.textColor;
    }
    this.textEl.style.textShadow = w.shadow ? "0 1px 2px rgba(0,0,0,0.5)" : "none";
  }

  // ------------------------------------------------------------------ buttons

  private drawButtons() {
    const seen = new Set<object>();
    for (const b of this.vm.buttons) {
      if (b.kind !== "rect" || !b.image || !b.rect) continue;
      seen.add(b);
      let img = this.buttonNodes.get(b);
      if (!img) {
        img = document.createElement("img");
        img.className = "dom-rect";
        img.alt = "";
        img.draggable = false;
        this.buttonLayer.appendChild(img);
        this.buttonNodes.set(b, img);
      }
      const url = this.dataUrl(b.image);
      if (img.dataset.url !== url) {
        img.src = url;
        img.dataset.url = url;
      }
      img.style.left = u(b.rect.x);
      img.style.top = u(b.rect.y);
      img.style.width = u(b.rect.w);
      img.style.height = u(b.rect.h);
    }
    for (const [key, img] of [...this.buttonNodes]) {
      if (!seen.has(key)) {
        img.remove();
        this.buttonNodes.delete(key);
      }
    }
  }
}
