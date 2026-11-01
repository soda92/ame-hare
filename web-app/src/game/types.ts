export type LineKind = "label" | "command" | "text" | "blank" | "comment";

export interface ScriptLine {
  no: number;
  kind: LineKind;
  raw: string;
  label?: string;
  text?: string;
  click?: boolean;
}

export interface CompiledScript {
  lines: ScriptLine[];
  labels: Record<string, number>;
  start: number;
  define: DefineState;
}

export type TransMode = "a" | "l" | "r" | "c" | "s" | "#" | "!";

export interface ImageSpec {
  mode: TransMode;
  cells: number;
  file: string;
  colors: string[];
  font?: {
    w: number;
    h: number;
    pitchX: number;
    pitchY: number;
    flags: number;
  };
}

export interface TextWindow {
  x: number;
  y: number;
  cols: number;
  rows: number;
  fontW: number;
  fontH: number;
  pitchX: number;
  pitchY: number;
  wait: number;
  bold: boolean;
  shadow: boolean;
  bg?: ImageSpec;
  bgX: number;
  bgY: number;
  bgW?: number;
  bgH?: number;
}

export interface DefineState {
  screenW: number;
  screenH: number;
  textWindow: TextWindow;
  textColor: string;
  defaultMode: TransMode;
  chooseColor: [string, string];
  underline: number;
  saveNumber: number;
  fontFamily: string;
  defVoiceVol: number;
  defSeVol: number;
  defBgmVol: number;
  bgmFadeOut: number;
  intLimits: Record<number, [number, number]>;
  caption: string;
  automode: boolean;
  automodeTime: number;
}

export interface SpriteState {
  no: number;
  spec: ImageSpec;
  x: number;
  y: number;
  visible: boolean;
  cell: number;
}

export interface TachiState {
  slot: 0 | 1 | 2;
  spec: ImageSpec;
  x: number;
  y: number;
  visible: boolean;
}

export interface Choice {
  text: string;
  label: string;
}

export interface Manifest {
  title: string;
  screen: { width: number; height: number };
  script: string;
  images: string[];
  bgm: string[];
  voice: string[];
  movie?: string;
  source: { disc1: string; disc2?: string };
  generatedAt: string;
}

export interface SaveMeta {
  slot: number;
  savedAt: number;
  chapter: string;
  location: string;
  image: string;
}

export interface SaveSlot {
  meta: SaveMeta;
  snapshot: Snapshot;
}

export interface Snapshot {
  version: 2;
  pc: number;
  vars: Record<number, number>;
  strs: Record<number, string>;
  textLines: string[];
  textWindow: TextWindow;
  textColor: string;
  bg: string | null;
  tachi: TachiState[];
  sprites: Record<number, SpriteState>;
  buttons: ButtonSnapshot[];
  exbtnDefault: string | null;
  btndefFile: string | null;
  btntime: number;
  audio: {
    bgm: string | null;
    bgmVolume: number;
    seVolume: number;
    voiceVolume: number;
  };
  saveEnabled: boolean;
  chapter: string;
  location: string;
  savedAt: number;
}

export interface ButtonSnapshot {
  no: number;
  kind: "sprite" | "rect" | "exbtn";
  spriteNo?: number;
  ctl?: string;
  rect?: { x: number; y: number; w: number; h: number };
  src?: { x: number; y: number; w: number; h: number };
}

export interface VmHooks {
  choose(choices: Choice[]): Promise<number>;
  movie(file: string): Promise<void>;
  backlog(lines: string[]): void;
  status(text: string): void;
  log(text: string): void;
  error(message: string): void;
  ended(): void;
  requestRender(): void;
  /** Called at stable points so the host can persist scene/command/menu state. */
  state?(state: UrlState): void;
}

export interface UrlState {
  scene: string;
  cmd: number;
  menu: string | null;
  snapshot: Snapshot;
}

export interface DebugState {
  pc: number;
  line: number;
  label: string;
  command: string;
  waiting: string;
  text: string[];
  bg: string | null;
  sprites: number;
  vars: Record<string, number>;
  saveEnabled: boolean;
  skip: boolean;
  auto: boolean;
}
