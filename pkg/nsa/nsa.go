// Package nsa reads NScripter NSA archives and decodes their SPB-compressed
// bitmap payloads.
//
// The archive header is big-endian:
//
//	uint16 file count
//	uint32 base offset
//
// followed by one record per file:
//
//	name (NUL terminated, CP932/ASCII)
//	uint8  compression type (0 = none, 1 = SPB, 2 = LZSS, 4 = NBZ)
//	uint32 offset (relative to base offset)
//	uint32 stored length
//	uint32 original length
package nsa

import (
	"encoding/binary"
	"fmt"
	"io"
	"sort"
	"strings"
)

// Compression types used by NScripter.
const (
	None = 0
	SPB  = 1
	LZSS = 2
	NBZ  = 4
)

// Entry is one file in an archive.
type Entry struct {
	Name        string
	Compression uint8
	Offset      uint32 // relative to the archive's base offset
	Length      uint32 // stored size
	Original    uint32 // uncompressed size
	Index       int
}

// Archive is an NSA archive backed by a random-access reader.
type Archive struct {
	r       io.ReaderAt
	size    int64
	Base    uint32
	Entries []Entry
	byName  map[string]int
}

// Open reads the archive directory.
func Open(r io.ReaderAt, size int64) (*Archive, error) {
	if size < 6 {
		return nil, fmt.Errorf("nsa: file too small")
	}
	var hdr [6]byte
	if _, err := r.ReadAt(hdr[:], 0); err != nil {
		return nil, err
	}
	count := int(binary.BigEndian.Uint16(hdr[0:2]))
	base := binary.BigEndian.Uint32(hdr[2:6])
	if count < 0 || count > 100000 {
		return nil, fmt.Errorf("nsa: implausible file count %d", count)
	}

	sr := io.NewSectionReader(r, 6, size-6)
	br := newByteReader(sr)
	a := &Archive{r: r, size: size, Base: base, byName: map[string]int{}}
	a.Entries = make([]Entry, 0, count)
	for i := 0; i < count; i++ {
		name, err := br.readCString()
		if err != nil {
			return nil, fmt.Errorf("nsa: entry %d name: %w", i, err)
		}
		var rest [13]byte
		if _, err := io.ReadFull(br, rest[:]); err != nil {
			return nil, fmt.Errorf("nsa: entry %d header: %w", i, err)
		}
		e := Entry{
			Name:        name,
			Compression: rest[0],
			Offset:      binary.BigEndian.Uint32(rest[1:5]),
			Length:      binary.BigEndian.Uint32(rest[5:9]),
			Original:    binary.BigEndian.Uint32(rest[9:13]),
			Index:       i,
		}
		if uint64(base)+uint64(e.Offset)+uint64(e.Length) > uint64(size) {
			return nil, fmt.Errorf("nsa: entry %d (%s) is outside the archive", i, name)
		}
		a.Entries = append(a.Entries, e)
		key := normalize(e.Name)
		if _, ok := a.byName[key]; !ok {
			a.byName[key] = len(a.Entries) - 1
		}
	}
	return a, nil
}

// OpenSize reads an archive from r using size.
func OpenSize(r io.ReaderAt, size int64) (*Archive, error) { return Open(r, size) }

// Find returns the entry with the given (case-insensitive) name.
func (a *Archive) Find(name string) (Entry, bool) {
	i, ok := a.byName[normalize(name)]
	if !ok {
		return Entry{}, false
	}
	return a.Entries[i], true
}

// Stored returns the raw stored bytes of an entry.
func (a *Archive) Stored(e Entry) ([]byte, error) {
	buf := make([]byte, e.Length)
	off := int64(a.Base + e.Offset)
	if _, err := a.r.ReadAt(buf, off); err != nil && err != io.EOF {
		return nil, err
	}
	return buf, nil
}

// Read returns the decoded bytes of an entry.
func (a *Archive) Read(e Entry) ([]byte, error) {
	buf, err := a.Stored(e)
	if err != nil {
		return nil, err
	}
	switch e.Compression {
	case None:
		return buf, nil
	case SPB:
		return DecodeSPB(buf)
	default:
		return nil, fmt.Errorf("nsa: %s uses unsupported compression %d", e.Name, e.Compression)
	}
}

// Names returns every entry name in archive order.
func (a *Archive) Names() []string {
	out := make([]string, len(a.Entries))
	for i, e := range a.Entries {
		out[i] = e.Name
	}
	return out
}

// SortedNames returns entry names sorted case-insensitively.
func (a *Archive) SortedNames() []string {
	out := a.Names()
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i]) < strings.ToLower(out[j]) })
	return out
}

func normalize(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	return strings.ToLower(name)
}

type byteReader struct {
	r   io.Reader
	buf [1]byte
}

func newByteReader(r io.Reader) *byteReader { return &byteReader{r: r} }

func (b *byteReader) ReadByte() (byte, error) {
	if _, err := io.ReadFull(b.r, b.buf[:]); err != nil {
		return 0, err
	}
	return b.buf[0], nil
}

func (b *byteReader) Read(p []byte) (int, error) { return b.r.Read(p) }

func (b *byteReader) readCString() (string, error) {
	var out []byte
	for {
		c, err := b.ReadByte()
		if err != nil {
			return "", err
		}
		if c == 0 {
			return decodeCP932(out), nil
		}
		out = append(out, c)
		if len(out) > 4096 {
			return "", fmt.Errorf("name too long")
		}
	}
}

func decodeCP932(b []byte) string {
	// Archive names are ASCII in this game; keep the helper simple and lossless.
	return string(b)
}
