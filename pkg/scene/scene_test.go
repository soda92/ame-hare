package scene

import (
	"bytes"
	"testing"
)

func TestDecodeXORAndCP932(t *testing.T) {
	plain := "こんにちは\r\n;mode800\r\n"
	sjis := []byte{
		0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd, 0x0d, 0x0a,
		';', 'm', 'o', 'd', 'e', '8', '0', '0', 0x0d, 0x0a,
	}
	raw := make([]byte, len(sjis))
	for i, b := range sjis {
		raw[i] = b ^ XORKey
	}
	got, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got != plain {
		t.Fatalf("got %q", got)
	}
	if !bytes.Contains([]byte(got), []byte(";mode800")) {
		t.Fatal("expected directive")
	}
}
