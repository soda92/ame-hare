// Package disc reads ISO 9660 (and Joliet) file systems from plain ISO images
// and raw CloneCD / Alcohol 120% images (2352- and 2448-byte sectors).
package disc

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"strings"
)

// Sector layout constants.
const (
	isoSector    = 2048
	rawSector    = 2352 // sync(12) + header(4) + data(2048) + ecc(288)
	rawSubSector = 2448 // rawSector + 96-byte subchannel
	userOffset   = 16
)

// Image is a mounted disc image.
type Image struct {
	Path       string
	f          *os.File
	Size       int64
	SectorSize int64 // physical sector size (2048, 2352 or 2448)
	DataOffset int64 // offset of user data within a physical sector
}

// Open detects the sector layout of an image and validates its ISO 9660 PVD.
func Open(path string) (*Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	img := &Image{Path: path, f: f, Size: st.Size()}
	if err := img.detect(); err != nil {
		f.Close()
		return nil, err
	}
	return img, nil
}

func (img *Image) detect() error {
	type layout struct {
		sector int64
		data   int64
	}
	candidates := []layout{
		{isoSector, 0},
		{rawSector, userOffset},
		{rawSubSector, userOffset},
	}
	for _, c := range candidates {
		if img.Size%c.sector != 0 {
			continue
		}
		hdr := make([]byte, 6)
		off := 16*c.sector + c.data
		if off+6 > img.Size {
			continue
		}
		if _, err := img.f.ReadAt(hdr, off); err != nil {
			continue
		}
		if string(hdr[1:6]) == "CD001" {
			img.SectorSize = c.sector
			img.DataOffset = c.data
			return nil
		}
	}
	return fmt.Errorf("disc: %s is not a recognized ISO 9660 image", img.Path)
}

// Close closes the image file.
func (img *Image) Close() error { return img.f.Close() }

// Sector returns the 2048-byte user data of a logical sector.
func (img *Image) Sector(lba uint32) ([]byte, error) {
	buf := make([]byte, isoSector)
	off := int64(lba)*img.SectorSize + img.DataOffset
	if off+isoSector > img.Size {
		return nil, fmt.Errorf("disc: sector %d out of range", lba)
	}
	if _, err := img.f.ReadAt(buf, off); err != nil {
		return nil, err
	}
	return buf, nil
}

// File is a file or directory in the ISO 9660 tree.
type File struct {
	Path string
	Dir  bool
	LBA  uint32
	Size uint32
}

// Files walks the ISO 9660 directory tree and returns every entry.
//
// If a Joliet supplementary volume descriptor is present it is preferred, so
// names longer than 8.3 (for example the voice files) are reported in full.
func (img *Image) Files() ([]File, error) {
	lba, size, joliet, err := img.root()
	if err != nil {
		return nil, err
	}
	var out []File
	seen := map[uint32]bool{}
	var walk func(lba, size uint32, prefix string) error
	walk = func(lba, size uint32, prefix string) error {
		if seen[lba] {
			return nil
		}
		seen[lba] = true
		// Directory records may not cross sector boundaries.
		for off := uint32(0); off < size; {
			sector := lba + off/isoSector
			data, err := img.Sector(sector)
			if err != nil {
				return err
			}
			for in := off % isoSector; in < isoSector; {
				if in >= uint32(len(data)) {
					break
				}
				recLen := uint32(data[in])
				if recLen == 0 {
					in = isoSector
					break
				}
				if in+recLen > isoSector || recLen < 34 {
					break
				}
				rec := data[in : in+recLen]
				nlen := uint32(rec[32])
				if 33+nlen > recLen {
					break
				}
				name, ok := decodeName(rec[33:33+nlen], joliet)
				if ok && name != "\x00" && name != "\x01" {
					name = strings.TrimSuffix(name, ";1")
					flags := rec[25]
					f := File{
						Path: join(prefix, name),
						Dir:  flags&0x02 != 0,
						LBA:  binary.LittleEndian.Uint32(rec[2:6]),
						Size: binary.LittleEndian.Uint32(rec[10:14]),
					}
					out = append(out, f)
					if f.Dir {
						if err := walk(f.LBA, f.Size, f.Path); err != nil {
							return err
						}
					}
				}
				in += recLen
			}
			off += isoSector
		}
		return nil
	}
	if err := walk(lba, size, ""); err != nil {
		return nil, err
	}
	return out, nil
}

func decodeName(raw []byte, joliet bool) (string, bool) {
	if !joliet {
		return string(raw), true
	}
	if len(raw)%2 != 0 {
		return "", false
	}
	buf := make([]rune, 0, len(raw)/2)
	for i := 0; i+1 < len(raw); i += 2 {
		r := rune(binary.BigEndian.Uint16(raw[i : i+2]))
		if r == 0 {
			break
		}
		buf = append(buf, r)
	}
	return string(buf), true
}

// root finds the best volume descriptor root directory.
func (img *Image) root() (lba, size uint32, joliet bool, err error) {
	var primary *[]byte
	for sector := uint32(16); sector < 16+64; sector++ {
		d, e := img.Sector(sector)
		if e != nil {
			break
		}
		if string(d[1:6]) != "CD001" {
			break
		}
		switch d[0] {
		case 1:
			primary = &d
		case 2:
			// Joliet escape sequences are %/@, %/C or %/E.
			if d[88] == '%' && d[89] == '/' && (d[90] == '@' || d[90] == 'C' || d[90] == 'E') {
				root := d[156:]
				if len(root) >= 34 {
					return binary.LittleEndian.Uint32(root[2:6]), binary.LittleEndian.Uint32(root[10:14]), true, nil
				}
			}
		case 255:
			sector = 16 + 64
		}
	}
	if primary == nil {
		return 0, 0, false, fmt.Errorf("disc: missing ISO 9660 primary volume descriptor")
	}
	root := (*primary)[156:]
	if len(root) < 34 {
		return 0, 0, false, fmt.Errorf("disc: malformed root directory record")
	}
	return binary.LittleEndian.Uint32(root[2:6]), binary.LittleEndian.Uint32(root[10:14]), false, nil
}

// Find returns a file by case-insensitive path.
func (img *Image) Find(files []File, name string) (File, bool) {
	for _, f := range files {
		if !f.Dir && strings.EqualFold(f.Path, name) {
			return f, true
		}
	}
	return File{}, false
}

// ReaderAt returns a random-access reader over a file's contents.
func (img *Image) ReaderAt(f File) io.ReaderAt {
	return &fileReader{img: img, lba: f.LBA, size: int64(f.Size)}
}

// ReadFile reads a whole file into memory.
func (img *Image) ReadFile(f File) ([]byte, error) {
	buf := make([]byte, f.Size)
	if _, err := img.ReaderAt(f).ReadAt(buf, 0); err != nil && err != io.EOF {
		return nil, err
	}
	return buf, nil
}

// ExtractFile copies a file to w.
func (img *Image) ExtractFile(f File, w io.Writer) (int64, error) {
	var n int64
	for off := uint32(0); off < f.Size; off += isoSector {
		data, err := img.Sector(f.LBA + off/isoSector)
		if err != nil {
			return n, err
		}
		want := f.Size - off
		if want > isoSector {
			want = isoSector
		}
		m, err := w.Write(data[:want])
		n += int64(m)
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

type fileReader struct {
	img  *Image
	lba  uint32
	size int64
}

func (r *fileReader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off >= r.size {
		return 0, io.EOF
	}
	if int64(len(p)) > r.size-off {
		p = p[:r.size-off]
	}
	read := 0
	for read < len(p) {
		logical := off + int64(read)
		sector := r.lba + uint32(logical/isoSector)
		in := int(logical % isoSector)
		data, err := r.img.Sector(sector)
		if err != nil {
			return read, err
		}
		n := copy(p[read:], data[in:])
		read += n
	}
	return read, nil
}

func join(a, b string) string {
	if a == "" {
		return b
	}
	return a + "/" + b
}
