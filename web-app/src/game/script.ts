import type {
  CompiledScript,
  DefineState,
  ImageSpec,
  ScriptLine,
  TextWindow,
  TransMode,
} from "./types";

const DEFAULT_WINDOW: TextWindow = {
  x: 0,
  y: 0,
  cols: 24,
  rows: 3,
  fontW: 24,
  fontH: 24,
  pitchX: 24,
  pitchY: 24,
  wait: 0,
  bold: false,
  shadow: false,
  bgX: 0,
  bgY: 0,
};

export function defaultDefine(): DefineState {
  return {
    screenW: 640,
    screenH: 480,
    textWindow: { ...DEFAULT_WINDOW },
    textColor: "#ffffff",
    defaultMode: "a",
    chooseColor: ["#ffffff", "#999999"],
    underline: 480,
    saveNumber: 9,
    fontFamily: '"MS Gothic", "Noto Sans CJK JP", "Noto Sans JP", sans-serif',
    defVoiceVol: 100,
    defSeVol: 100,
    defBgmVol: 100,
    bgmFadeOut: 500,
    intLimits: {},
    caption: "",
    automode: false,
    automodeTime: 1500,
  };
}

/** Parse the whole script into lines plus the *define directives. */
export function parseScript(source: string): CompiledScript {
  const text = source.replace(/\r\n?/g, "\n");
  const rawLines = text.split("\n");
  const lines: ScriptLine[] = [];
  const labels: Record<string, number> = {};
  let inDefine = false;
  let defineDone = false;
  const define = defaultDefine();

  for (let i = 0; i < rawLines.length; i++) {
    const original = rawLines[i];
    const trimmed = trimAscii(original);
    const no = i + 1;
    if (trimmed === "") {
      lines.push({ no, kind: "blank", raw: "" });
      continue;
    }
    if (trimmed.startsWith(";")) {
      lines.push({ no, kind: "comment", raw: trimmed });
      continue;
    }
    if (trimmed.startsWith("*")) {
      const name = trimmed.slice(1).trim();
      labels[normalizeLabel(name)] = lines.length;
      lines.push({ no, kind: "label", raw: trimmed, label: name });
      if (name.toLowerCase() === "define") inDefine = true;
      continue;
    }
    if (isCommandStart(trimmed)) {
      if (inDefine && !defineDone) {
        const name = commandName(trimmed);
        if (name === "game") {
          defineDone = true;
          inDefine = false;
        }
        applyDefine(define, trimmed);
      }
      lines.push({ no, kind: "command", raw: trimmed });
      continue;
    }
    // Text line. A trailing \ or @ is a click/page wait marker.
    let body = trimmed;
    let click = false;
    const last = body[body.length - 1];
    if (last === "\\" || last === "@") {
      click = true;
      body = body.slice(0, -1);
    }
    lines.push({ no, kind: "text", raw: trimmed, text: body, click });
  }

  const start = labels[normalizeLabel("start")] ?? 0;
  // `game` marks the end of the definition block; execution begins at *start.
  return { lines, labels, start, define };
}

function trimAscii(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, "");
}

function normalizeLabel(name: string): string {
  return name.toLowerCase();
}

export function isCommandStart(s: string): boolean {
  const c = s[0];
  if (!c) return false;
  if (c === "#" || c === "!") return true;
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

export function commandName(s: string): string {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(s);
  return m ? m[1].toLowerCase() : "";
}

function applyDefine(d: DefineState, raw: string): void {
  const name = commandName(raw);
  const rest = raw.slice(name.length).trim();
  switch (name) {
    case "mode800":
      d.screenW = 800;
      d.screenH = 600;
      d.underline = 504;
      break;
    case "mode640":
      d.screenW = 640;
      d.screenH = 480;
      d.underline = 384;
      break;
    case "mode400":
      d.screenW = 400;
      d.screenH = 300;
      d.underline = 240;
      break;
    case "transmode":
      if (rest.toLowerCase().startsWith("alpha")) d.defaultMode = "a";
      else if (rest.toLowerCase().startsWith("copy")) d.defaultMode = "c";
      break;
    case "underline":
      d.underline = intArg(rest, d.underline);
      break;
    case "savenumber":
      d.saveNumber = intArg(rest, d.saveNumber);
      break;
    case "selectcolor": {
      const args = splitArgs(rest);
      if (args[0]) d.chooseColor[0] = colorArg(args[0], d.chooseColor[0]);
      if (args[1]) d.chooseColor[1] = colorArg(args[1], d.chooseColor[1]);
      break;
    }
    case "defaultfont":
      d.fontFamily = `"${unquote(rest)}", "MS Gothic", "Noto Sans CJK JP", "Noto Sans JP", sans-serif`;
      break;
    case "defvoicevol":
      d.defVoiceVol = intArg(rest, d.defVoiceVol);
      break;
    case "defsevol":
      d.defSeVol = intArg(rest, d.defSeVol);
      break;
    case "defmp3vol":
      d.defBgmVol = intArg(rest, d.defBgmVol);
      break;
    case "mp3fadeout":
      d.bgmFadeOut = intArg(rest, d.bgmFadeOut);
      break;
    case "intlimit": {
      const a = splitArgs(rest).map((x) => parseInt(x, 10));
      if (a.length >= 3 && Number.isFinite(a[0])) d.intLimits[a[0]] = [a[1] || 0, a[2] || 0];
      break;
    }
    case "caption":
      d.caption = unquote(rest);
      break;
    case "automode":
      d.automode = true;
      break;
    case "automode_time":
      d.automodeTime = intArg(rest, d.automodeTime);
      break;
    case "setwindow": {
      d.textWindow = parseSetwindow(rest, d.defaultMode);
      break;
    }
    case "#": {
      const m = /^#([0-9a-fA-F]{6})/.exec(raw);
      if (m) d.textColor = `#${m[1]}`;
      break;
    }
    default:
      break;
  }
}

export function parseSetwindow(rest: string, defaultMode: TransMode): TextWindow {
  const a = splitArgs(rest);
  const nums = a.slice(0, 11).map((x) => parseInt(x, 10));
  const w: TextWindow = {
    x: num(nums[0], 0),
    y: num(nums[1], 0),
    cols: num(nums[2], 24),
    rows: num(nums[3], 3),
    fontW: num(nums[4], 24),
    fontH: num(nums[5], 24),
    pitchX: num(nums[4], 24) + num(nums[6], 0),
    pitchY: num(nums[5], 24) + num(nums[7], 0),
    wait: num(nums[8], 0),
    bold: !!nums[9],
    shadow: !!nums[10],
    bgX: parseInt(a[12] ?? "0", 10) || 0,
    bgY: parseInt(a[13] ?? "0", 10) || 0,
  };
  const bg = a[11] ? unquote(a[11]) : "";
  if (bg) {
    w.bg = parseSpec(bg, defaultMode);
    w.bgW = parseInt(a[14] ?? "0", 10) || undefined;
    w.bgH = parseInt(a[15] ?? "0", 10) || undefined;
  }
  return w;
}

export function colorArg(s: string, fallback: string): string {
  const m = /#([0-9a-fA-F]{6})/.exec(s);
  return m ? `#${m[1]}` : fallback;
}

function intArg(s: string, fallback: number): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Split a line on top-level `:` separators, respecting quotes and parens. */
export function splitTopLevel(s: string, sep = ":"): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      quote = !quote;
      continue;
    }
    if (quote) continue;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter((x) => x !== "");
}

/** Split a command's argument list on top-level commas. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      quote = !quote;
      continue;
    }
    if (quote) continue;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

export function unquote(s: string): string {
  let t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    t = t.slice(1, -1);
    t = t.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return t;
}

/**
 * Parse NScripter's image specification:
 *
 *   [:b|f][mode][/cells[,duration,loop]][;]filename
 *   :s/fontW,fontH[,pitchDelta[,flags]];#rrggbb...text
 */
export function parseSpec(raw: string, defaultMode: TransMode = "a"): ImageSpec {
  let s = raw.trim();
  let mode: TransMode = defaultMode;
  let cells = 1;
  const colors: string[] = [];
  let font: ImageSpec["font"];

  if (s.startsWith(":")) {
    s = s.slice(1);
    while (s[0] === "b" || s[0] === "f") s = s.slice(1);
    const m = s[0];
    if (m && "alrcsm#!".includes(m)) {
      mode = m as TransMode;
      s = s.slice(1);
    }
    if (mode === "s") {
      if (s[0] === "/") {
        s = s.slice(1);
        const end = s.indexOf(";");
        const opts = (end >= 0 ? s.slice(0, end) : s).split(",");
        const fw = parseInt(opts[0], 10) || 24;
        const fh = parseInt(opts[1], 10) || 24;
        const delta = parseInt(opts[2] ?? "0", 10) || 0;
        font = {
          w: fw,
          h: fh,
          pitchX: fw + delta,
          pitchY: fh,
          flags: parseInt(opts[3] ?? "0", 10) || 0,
        };
        s = end >= 0 ? s.slice(end + 1) : "";
      }
      while (s.startsWith("#")) {
        colors.push(s.slice(0, 7));
        s = s.slice(7);
      }
      return {
        mode: "s",
        cells: Math.max(1, colors.length),
        file: s,
        colors,
        font,
      };
    }
    while (s && s[0] !== "/" && s[0] !== ";") s = s.slice(1);
    if (s[0] === "/") {
      s = s.slice(1);
      const end = s.indexOf(";");
      const head = end >= 0 ? s.slice(0, end) : s;
      const n = parseInt(head.split(",")[0], 10);
      if (n > 0) cells = n;
      s = end >= 0 ? s.slice(end + 1) : s.slice(head.length);
    } else if (s[0] === ";") {
      s = s.slice(1);
    }
  }
  return { mode, cells, file: s, colors };
}

/** True when a spec is a string sprite (rendered with the text font). */
export function isStringSpec(spec: ImageSpec): boolean {
  return spec.mode === "s";
}

export function specKey(spec: ImageSpec): string {
  return [
    spec.mode,
    spec.cells,
    spec.file,
    spec.colors.join(""),
    spec.font ? `${spec.font.w}x${spec.font.h}/${spec.font.pitchX}/${spec.font.pitchY}/${spec.font.flags}` : "",
  ].join("|");
}
