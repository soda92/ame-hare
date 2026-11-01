package nsa

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func buildArchive(t *testing.T) []byte {
	t.Helper()
	type ent struct {
		name string
		data []byte
	}
	ents := []ent{
		{"a.bmp", []byte("abc")},
		{"b.bin", []byte("de")},
	}
	var dir bytes.Buffer
	_ = binary.Write(&dir, binary.BigEndian, uint16(len(ents)))
	_ = binary.Write(&dir, binary.BigEndian, uint32(0)) // patched below
	off := uint32(0)
	for _, e := range ents {
		dir.WriteString(e.name)
		dir.WriteByte(0)
		dir.WriteByte(0) // no compression
		_ = binary.Write(&dir, binary.BigEndian, off)
		_ = binary.Write(&dir, binary.BigEndian, uint32(len(e.data)))
		_ = binary.Write(&dir, binary.BigEndian, uint32(len(e.data)))
		off += uint32(len(e.data))
	}
	base := uint32(dir.Len())
	buf := dir.Bytes()
	binary.BigEndian.PutUint32(buf[2:6], base)
	for _, e := range ents {
		buf = append(buf, e.data...)
	}
	return buf
}

func TestArchiveRead(t *testing.T) {
	buf := buildArchive(t)
	a, err := Open(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		t.Fatal(err)
	}
	if len(a.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(a.Entries))
	}
	e, ok := a.Find("B.BIN")
	if !ok {
		t.Fatal("case-insensitive find failed")
	}
	got, err := a.Read(e)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "de" {
		t.Fatalf("got %q", got)
	}
}

func TestDecodeSPB1x1(t *testing.T) {
	// 1x1 image, three planes with one raw 8-bit starting sample each.
	src := []byte{0, 1, 0, 1, 10, 20, 30}
	img, err := DecodeSPBImage(src)
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 1 || img.Bounds().Dy() != 1 {
		t.Fatalf("bad size %v", img.Bounds())
	}
	p := img.NRGBAAt(0, 0)
	if p.R != 30 || p.G != 20 || p.B != 10 || p.A != 0xff {
		t.Fatalf("bad pixel %v", p)
	}
}
