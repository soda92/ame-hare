package audit

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fixture(t *testing.T) (string, string) {
	t.Helper()
	data := t.TempDir()
	writeFile(t, data, "images/bg01.png", "png")
	writeFile(t, data, "images/a.png", "png")
	writeFile(t, data, "audio/voice/v1.wav", "wav")
	writeFile(t, data, "audio/bgm/b1.wav", "wav")
	writeFile(t, data, "movie/cio.mp4", "mp4")

	vm := filepath.Join(t.TempDir(), "vm.ts")
	cases := `case "bg":
case "lsp":
case "dwave":
case "bgm":
case "mpegplay":
case "for":
case "next":
case "goto":
case "csel":
case "gosub":
case "return":
case "caption":
case "game":
`
	writeFile(t, filepath.Dir(vm), filepath.Base(vm), cases)
	return data, vm
}

func TestRunClean(t *testing.T) {
	data, vm := fixture(t)
	script := `*define
caption "test"
game
*start
bg "bg01.bmp",2
lsp 1,":a/2,0,3;a.bmp",0,0
dwave 0,"voice\v1.wav"
bgm "bgm\b1.wav"
mpegplay "cio.dat",1
for %0=0 to 2
next
if %0=1 gosub *sub
csel "a",*start,"b",*sub
goto *sub
*sub
return
`
	rep := Run(script, Options{ScriptPath: "test.txt", DataDir: data, VMSource: vm})
	if rep.Errors != 0 {
		t.Fatalf("unexpected errors: %+v", rep.Issues)
	}
	if len(rep.MissingAssets) != 0 {
		t.Fatalf("unexpected missing assets: %v", rep.MissingAssets)
	}
}

func TestRunIssues(t *testing.T) {
	data, vm := fixture(t)
	script := `*start
bg "missing.bmp",2
next
frobnicate 1
csel "a",*start,"b"
goto *nowhere
for %0=0 to 2
`
	rep := Run(script, Options{ScriptPath: "test.txt", DataDir: data, VMSource: vm})
	if rep.Errors == 0 {
		t.Fatal("expected errors")
	}
	want := map[string]bool{
		"missing asset":     false,
		"next without":      false,
		"unhandled command": false,
		"csel needs":        false,
		"label not found":   false,
		"never closed":      false,
	}
	for _, is := range rep.Issues {
		for key := range want {
			if contains(is.Message, key) {
				want[key] = true
			}
		}
	}
	for key, ok := range want {
		if !ok {
			t.Errorf("missing expected issue %q in %+v", key, rep.Issues)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
