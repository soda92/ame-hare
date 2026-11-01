package main

import (
	"strings"
	"testing"
)

func TestExtractTextSpritesAndChoices(t *testing.T) {
	script := `*define
caption "test"
game
*start
こんにちは？\
lsp 1,":s/20,20,0;#372C19蒼介"
csel "「さらに聞く」",*a,"「待つ」",*b
goto *a
`
	texts, sprites := extract(script)
	joined := strings.Join(texts, "\n")
	for _, want := range []string{"こんにちは？", "「さらに聞く」", "「待つ」"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing text %q in %q", want, joined)
		}
	}
	if len(sprites) != 1 || sprites[0] != "蒼介" {
		t.Fatalf("sprites = %#v", sprites)
	}
}

func TestMissingFor(t *testing.T) {
	existing := map[string]string{"a": "A", "b": ""}
	got := missingFor(existing, "text", []string{"a", "b", "c"}, nil, false)
	if len(got) != 2 || got[0] != "b" || got[1] != "c" {
		t.Fatalf("missing = %#v", got)
	}
	got = missingFor(existing, "text", []string{"a", "b", "c"}, nil, true)
	if len(got) != 3 {
		t.Fatalf("force missing = %#v", got)
	}
}
