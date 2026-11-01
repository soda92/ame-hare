import type { ImageSpec } from "./types";
import { isStringSpec, specKey } from "./script";

export interface LoadedImage {
  cells: HTMLCanvasElement[];
  cellW: number;
  cellH: number;
  width: number;
  height: number;
}

const IMAGE_ROOT = "/media/images";

function normalizeFile(file: string): string {
  let f = file.trim().replace(/\\/g, "/").toLowerCase();
  f = f.replace(/^\/+/, "");
  const dot = f.lastIndexOf(".");
  if (dot >= 0) f = f.slice(0, dot);
  return `${IMAGE_ROOT}/${encodeURI(f)}.png`;
}

export class AssetStore {
  private rawCache = new Map<string, Promise<HTMLImageElement>>();
  private specCache = new Map<string, Promise<LoadedImage>>();
  private fontFamily: string;

  constructor(fontFamily: string) {
    this.fontFamily = fontFamily;
  }

  setFontFamily(fontFamily: string) {
    this.fontFamily = fontFamily;
    this.specCache.clear();
  }

  imageUrl(file: string): string {
    return normalizeFile(file);
  }

  async raw(file: string): Promise<HTMLImageElement> {
    const url = normalizeFile(file);
    let p = this.rawCache.get(url);
    if (!p) {
      p = new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`image not found: ${url}`));
        img.src = url;
      });
      this.rawCache.set(url, p);
    }
    return p;
  }

  async loadSpec(spec: ImageSpec): Promise<LoadedImage> {
    const key = specKey(spec);
    let p = this.specCache.get(key);
    if (!p) {
      p = this.buildSpec(spec);
      this.specCache.set(key, p);
      p.catch(() => this.specCache.delete(key));
    }
    return p;
  }

  private async buildSpec(spec: ImageSpec): Promise<LoadedImage> {
    if (isStringSpec(spec)) return this.renderString(spec);
    const img = await this.raw(spec.file);
    return this.process(img, spec);
  }

  private renderString(spec: ImageSpec): LoadedImage {
    const font = spec.font ?? { w: 24, h: 24, pitchX: 24, pitchY: 24, flags: 0 };
    const text = spec.file;
    const colors = spec.colors.length ? spec.colors : ["#ffffff"];
    const cells: HTMLCanvasElement[] = [];
    const count = Math.max(1, colors.length);
    let maxW = 1;
    for (let c = 0; c < count; c++) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      ctx.font = `${font.h}px ${this.fontFamily}`;
      ctx.textBaseline = "top";
      ctx.fillStyle = colors[Math.min(c, colors.length - 1)];
      let x = 0;
      for (const ch of text) {
        ctx.fillText(ch, x, 0);
        x += ch.charCodeAt(0) < 0x80 ? Math.max(1, ctx.measureText(ch).width) : font.pitchX;
      }
      const w = Math.max(1, x);
      const h = Math.max(1, font.pitchY);
      canvas.width = w;
      canvas.height = h;
      const ctx2 = canvas.getContext("2d");
      if (!ctx2) throw new Error("2d context unavailable");
      ctx2.font = `${font.h}px ${this.fontFamily}`;
      ctx2.textBaseline = "top";
      ctx2.fillStyle = colors[Math.min(c, colors.length - 1)];
      let x2 = 0;
      for (const ch of text) {
        ctx2.fillText(ch, x2, 0);
        x2 += ch.charCodeAt(0) < 0x80 ? Math.max(1, ctx2.measureText(ch).width) : font.pitchX;
      }
      maxW = Math.max(maxW, w);
      cells.push(canvas);
    }
    return { cells, cellW: maxW, cellH: Math.max(1, font.pitchY), width: maxW * count, height: font.pitchY };
  }

  private process(img: HTMLImageElement, spec: ImageSpec): LoadedImage {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const count = Math.max(1, spec.cells);
    const cellW = Math.max(1, Math.floor(W / count));
    const tmp = document.createElement("canvas");
    tmp.width = W;
    tmp.height = H;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    if (!tctx) throw new Error("2d context unavailable");
    tctx.drawImage(img, 0, 0);
    const data = tctx.getImageData(0, 0, W, H).data;

    const mode = spec.mode;
    const cells: HTMLCanvasElement[] = [];
    let outW = cellW;

    if (mode === "a") {
      outW = Math.max(1, Math.floor(cellW / 2));
      const out = document.createElement("canvas");
      out.width = outW;
      out.height = H;
      const octx = out.getContext("2d", { willReadFrequently: true });
      if (!octx) throw new Error("2d context unavailable");
      const outData = octx.createImageData(outW, H);
      for (let c = 0; c < count; c++) {
        const base = c * cellW;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < outW; x++) {
            const si = (y * W + base + x) * 4;
            const ai = (y * W + base + outW + x) * 4;
            const di = (y * outW + x) * 4;
            outData.data[di] = data[si];
            outData.data[di + 1] = data[si + 1];
            outData.data[di + 2] = data[si + 2];
            outData.data[di + 3] = 255 - data[ai + 2];
          }
        }
        const cell = document.createElement("canvas");
        cell.width = outW;
        cell.height = H;
        cell.getContext("2d")?.putImageData(outData, 0, 0);
        cells.push(cell);
      }
      return { cells, cellW: outW, cellH: H, width: outW * count, height: H };
    }

    const ref = mode === "r" ? [data[(W - 1) * 4], data[(W - 1) * 4 + 1], data[(W - 1) * 4 + 2]] : [data[0], data[1], data[2]];
    const useKey = mode === "l" || mode === "r" || mode === "#";
    for (let c = 0; c < count; c++) {
      const base = c * cellW;
      const cell = document.createElement("canvas");
      cell.width = cellW;
      cell.height = H;
      const cctx = cell.getContext("2d", { willReadFrequently: true });
      if (!cctx) throw new Error("2d context unavailable");
      const out = cctx.createImageData(cellW, H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < cellW; x++) {
          const si = (y * W + base + x) * 4;
          const di = (y * cellW + x) * 4;
          out.data[di] = data[si];
          out.data[di + 1] = data[si + 1];
          out.data[di + 2] = data[si + 2];
          const keyed = useKey && data[si] === ref[0] && data[si + 1] === ref[1] && data[si + 2] === ref[2];
          out.data[di + 3] = keyed ? 0 : 255;
        }
      }
      cctx.putImageData(out, 0, 0);
      cells.push(cell);
    }
    return { cells, cellW: outW, cellH: H, width: outW * count, height: H };
  }
}
