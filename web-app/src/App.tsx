import { useEffect, useRef, useState } from "react";
import type { Choice, Manifest, ScriptLine, Snapshot, UrlState } from "./game/types";
import { parseScript } from "./game/script";
import { AssetStore } from "./game/assets";
import { AudioEngine } from "./game/audio";
import { SaveStore } from "./game/save";
import { Vm } from "./game/vm";
import { StageRenderer } from "./game/stage";

const SESSION_KEY = "amehare.session.v1";

interface StoredSession {
  state: UrlState;
  savedAt: number;
}

function readSession(): StoredSession | null {
  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      const raw = store.getItem(SESSION_KEY);
      if (raw) return JSON.parse(raw) as StoredSession;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function writeSession(state: UrlState): void {
  const payload = JSON.stringify({ state, savedAt: Date.now() } satisfies StoredSession);
  try {
    window.sessionStorage.setItem(SESSION_KEY, payload);
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.setItem(SESSION_KEY, payload);
  } catch {
    /* ignore */
  }
}

function urlForState(state: UrlState): string {
  const p = new URLSearchParams();
  if (state.scene) p.set("scene", state.scene);
  p.set("cmd", String(state.cmd));
  if (state.menu) p.set("menu", state.menu);
  const q = p.toString();
  return `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vmRef = useRef<Vm | null>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const choiceResolve = useRef<((i: number) => void) | null>(null);
  const movieResolve = useRef<(() => void) | null>(null);
  const startOptsRef = useRef<{ snapshot?: Snapshot; pc?: number; menu?: string | null }>({});
  const startingRef = useRef(false);
  const [resumeMode, setResumeMode] = useState(false);

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [movie, setMovie] = useState<string | null>(null);
  const [backlog, setBacklog] = useState<string[] | null>(null);
  const [ended, setEnded] = useState(false);
  const [debug, setDebug] = useState(false);
  const [debugLine, setDebugLine] = useState<ScriptLine | undefined>(undefined);
  const [status, setStatus] = useState("");
  const [muted, setMuted] = useState(false);
  const [auto, setAuto] = useState(false);
  const [skip, setSkip] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mres, sres] = await Promise.all([fetch("/api/manifest"), fetch("/api/script")]);
        if (!mres.ok) throw new Error("manifest.json missing; run cmd/extract first");
        if (!sres.ok) throw new Error("script.txt missing; run cmd/extract first");
        const manifest = (await mres.json()) as Manifest;
        const text = await sres.text();
        if (cancelled) return;
        setManifest(manifest);
        const params = new URLSearchParams(window.location.search);
        const sceneParam = params.get("scene");
        const hasCmd = params.has("cmd");
        const cmdRaw = params.get("cmd");
        const cmdParam = cmdRaw !== null ? parseInt(cmdRaw, 10) : NaN;
        const menuParam = params.get("menu");
        let restored: UrlState | null = null;
        if (sceneParam !== null || hasCmd) {
          const stored = readSession();
          if (stored) {
            const st = stored.state;
            const sameScene = sceneParam === null || st.scene === sceneParam;
            const sameCmd = !Number.isFinite(cmdParam) || st.cmd === cmdParam;
            const sameMenu = (st.menu ?? null) === (menuParam ?? null);
            if (
              sameScene &&
              sameCmd &&
              sameMenu &&
              st.snapshot?.version === 2 &&
              Array.isArray(st.snapshot.buttons)
            ) {
              restored = st;
            }
          }
          startOptsRef.current = {
            snapshot: restored?.snapshot,
            // Without a matching snapshot, restart from *start rather than a
            // half-initialized mid-line state (which can leave button screens
            // with no buttons).
            pc: undefined,
            menu: menuParam,
          };
          setResumeMode(true);
        } else {
          startOptsRef.current = {};
        }
        const script = parseScript(text);
        const assets = new AssetStore(script.define.fontFamily);
        const audio = new AudioEngine();
        const saves = new SaveStore();
        const vm = new Vm(
          script,
          {
            choose: (choices) =>
              new Promise<number>((resolve) => {
                choiceResolve.current = resolve;
                setChoices(choices);
              }),
            movie: () =>
              new Promise<void>((resolve) => {
                if (!manifest.movie) {
                  window.setTimeout(resolve, 250);
                  return;
                }
                movieResolve.current = resolve;
                setMovie(manifest.movie);
              }),
            backlog: (lines) => setBacklog([...lines]),
            status: (s) => setStatus(s),
            log: (s) => console.log("[amehare]", s),
            error: (s) => setError(s),
            ended: () => setEnded(true),
            requestRender: () => undefined,
            state: (state) => {
              try {
                window.history.replaceState(null, "", urlForState(state));
              } catch {
                /* ignore */
              }
              writeSession(state);
            },
          },
          assets,
          audio,
          saves,
        );
        vmRef.current = vm;
        (window as unknown as { __amehare?: unknown }).__amehare = {
          vm,
          script,
          assets,
          audio,
          saves,
        };
        if (canvasRef.current) {
          rendererRef.current = new StageRenderer(canvasRef.current, assets, vm);
        }
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let id = 0;
    const tick = (t: number) => {
      rendererRef.current?.draw(t);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [ready]);

  useEffect(() => {
    const int = window.setInterval(() => {
      const vm = vmRef.current;
      if (!vm) return;
      setDebugLine(vm.currentCommand());
      if (vm.strs[89] || vm.strs[90]) setStatus([vm.strs[89], vm.strs[90]].filter(Boolean).join("  "));
    }, 400);
    return () => clearInterval(int);
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const begin = async () => {
    const vm = vmRef.current;
    if (!vm || startingRef.current) return;
    startingRef.current = true;
    await vm.audio.resume();
    setStarted(true);
    void vm.start(startOptsRef.current);
  };

  const logical = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * 800) / r.width, y: ((e.clientY - r.top) * 600) / r.height };
  };

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!started || choices || movie) return;
    const p = logical(e);
    void vmRef.current?.click(p.x, p.y);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!started || choices || movie) return;
    const p = logical(e);
    vmRef.current?.hover(p.x, p.y);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const vm = vmRef.current;
      if (!started) {
        if ((e.key === "Enter" || e.key === " ") && ready) {
          e.preventDefault();
          void begin();
        }
        return;
      }
      if (!vm) return;
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void vm.keyEnter();
      } else if (e.key === "Escape") {
        void vm.advanceSpecial("escape");
      } else if (e.key === "Control") {
        if (!skip) {
          vm.toggleSkip();
          setSkip(true);
        }
      } else if (e.key === "a" || e.key === "A") {
        vm.toggleAuto();
        setAuto(!auto);
      } else if (e.key === "d" || e.key === "D") {
        setDebug((d) => !d);
      } else if (e.key === "m" || e.key === "M") {
        vm.audio.setMuted(!muted);
        setMuted(!muted);
      } else if (e.key === "f" || e.key === "F") {
        void toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, ready, skip, auto, muted]);

  useEffect(() => {
    const onUnload = () => vmRef.current?.persistState();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    else await document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const finishMovie = () => {
    const r = movieResolve.current;
    movieResolve.current = null;
    setMovie(null);
    r?.();
  };

  const pickChoice = (i: number) => {
    const r = choiceResolve.current;
    choiceResolve.current = null;
    setChoices(null);
    r?.(i);
  };

  const gosub = (label: string) => {
    vmRef.current?.requestGosub(label);
  };

  return (
    <div className="app">
      <div className="stage-wrap">
        <canvas
          ref={canvasRef}
          className="stage"
          onPointerDown={onPointer}
          onPointerMove={onMove}
          onContextMenu={(e) => {
            e.preventDefault();
            const vm = vmRef.current;
            if (!vm) return;
            vm.audio.resume();
            if (vm.waitKindText()) vm.advanceSpecial("right");
            else setBacklog([...vm.history]);
          }}
        />
        {!started && (
          <div
            className="veil start-veil"
            onPointerDown={() => {
              if (ready) void begin();
            }}
          >
            <h1>{manifest?.title ?? "雨のち晴れのち こみっくアイランド"}</h1>
            <p>NScripter web engine · 800×600</p>
            <button
              disabled={!ready}
              onClick={(e) => {
                e.stopPropagation();
                void begin();
              }}
            >
              {!ready
                ? "Loading…"
                : resumeMode
                  ? startOptsRef.current.snapshot
                    ? "つづきから / Continue"
                    : "URL の位置から / Resume"
                  : "はじめる / Start"}
            </button>
            {ready && (
              <p className="hint">
                {resumeMode ? "クリックで前回の位置から再開します" : "画面をクリックして開始"}
              </p>
            )}
            {resumeMode && startOptsRef.current.snapshot && (
              <p className="resume-info">
                {[startOptsRef.current.snapshot.chapter, startOptsRef.current.snapshot.location]
                  .filter(Boolean)
                  .join("  ")}
              </p>
            )}
            {error && <p className="error">{error}</p>}
            {!manifest && ready === false && !error && <p className="hint">読み込み中…</p>}
          </div>
        )}
        {choices && (
          <div className="veil choice-veil">
            <div className="choices">
              {choices.map((c, i) => (
                <button key={i} onClick={() => pickChoice(i)}>
                  {c.text}
                </button>
              ))}
            </div>
          </div>
        )}
        {movie && (
          <div className="veil movie-veil" onClick={finishMovie}>
            <video src={`/media/${movie}`} autoPlay playsInline onEnded={finishMovie} onError={finishMovie} />
            <div className="movie-skip">クリックでスキップ</div>
          </div>
        )}
        {backlog && (
          <div className="backlog">
            <div className="backlog-head">
              <span>バックログ</span>
              <button onClick={() => setBacklog(null)}>閉じる</button>
            </div>
            <div className="backlog-body">
              {backlog.length === 0 && <p className="hint">まだログがありません。</p>}
              {backlog.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        )}
        {ended && (
          <div className="veil end-veil">
            <h1>終了</h1>
            <button onClick={() => window.location.reload()}>タイトルへ戻る</button>
          </div>
        )}
      </div>

      {started && (
        <div className="toolbar">
          <button onClick={() => gosub("*save_menu")}>Save</button>
          <button onClick={() => gosub("*load_menu")}>Load</button>
          <button onClick={() => gosub("*config_menu")}>Config</button>
          <button onClick={() => setBacklog([...(vmRef.current?.history ?? [])])}>Log</button>
          <button
            className={auto ? "on" : ""}
            onClick={() => {
              vmRef.current?.toggleAuto();
              setAuto(!auto);
            }}
          >
            Auto
          </button>
          <button
            className={skip ? "on" : ""}
            onClick={() => {
              vmRef.current?.toggleSkip();
              setSkip(!skip);
            }}
          >
            Skip
          </button>
          <button onClick={() => gosub("*backtitle_dlg")}>Title</button>
          <button onClick={() => void toggleFullscreen()}>{fullscreen ? "Window" : "Full"}</button>
          <button onClick={() => { vmRef.current?.audio.setMuted(!muted); setMuted(!muted); }}>
            {muted ? "Unmute" : "Mute"}
          </button>
          <button onClick={() => setDebug((d) => !d)}>Debug</button>
          <span className="status">{status}</span>
        </div>
      )}

      {debug && (
        <div className="debug">
          <div>pc {vmRef.current?.pc}</div>
          <div>label {vmRef.current?.debugState().label}</div>
          <div>line {debugLine?.no}</div>
          <div className="cmd">{debugLine?.raw}</div>
          <pre>{JSON.stringify(vmRef.current?.debugState().vars, null, 1)}</pre>
        </div>
      )}
    </div>
  );
}
