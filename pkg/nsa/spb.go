package nsa

import (
	"encoding/binary"
	"fmt"
	"image"
)

// DecodeSPB decompresses an NScripter SPB bitmap payload. The result is a
// 24-bit BGR image; callers that need alpha apply the NScripter trans mode
// (`:a`, `:l`, `:r`, ...) themselves.
func DecodeSPB(src []byte) ([]byte, error) {
	if len(src) < 4 {
		return nil, fmt.Errorf("spb: payload too small")
	}
	width := int(binary.BigEndian.Uint16(src[0:2]))
	height := int(binary.BigEndian.Uint16(src[2:4]))
	if width <= 0 || height <= 0 || width > 8192 || height > 8192 {
		return nil, fmt.Errorf("spb: bad dimensions %dx%d", width, height)
	}
	pad := (4 - (width*3)%4) % 4
	stride := width*3 + pad
	total := stride*height + 54

	out := make([]byte, total)
	copy(out[0:2], "BM")
	binary.LittleEndian.PutUint32(out[2:6], uint32(total))
	out[10] = 54
	binary.LittleEndian.PutUint32(out[14:18], 40)
	binary.LittleEndian.PutUint32(out[18:22], uint32(width))
	binary.LittleEndian.PutUint32(out[22:26], uint32(height))
	binary.LittleEndian.PutUint16(out[26:28], 1)
	binary.LittleEndian.PutUint16(out[28:30], 24)
	binary.LittleEndian.PutUint32(out[34:38], uint32(stride*height))

	br := newBitReader(src[4:])
	planeSize := width * height
	body := out[54:]
	for p := 0; p < 3; p++ {
		plane, err := decodePlane(br, planeSize)
		if err != nil {
			return nil, fmt.Errorf("spb: plane %d: %w", p, err)
		}
		pbuf := (height-1)*stride + p
		ps := 0
		for j := 0; j < height; j++ {
			if j&1 == 1 {
				for k := 0; k < width; k++ {
					body[pbuf] = plane[ps]
					ps++
					pbuf -= 3
				}
				pbuf -= stride - 3
			} else {
				for k := 0; k < width; k++ {
					body[pbuf] = plane[ps]
					ps++
					pbuf += 3
				}
				pbuf -= stride + 3
			}
		}
	}
	return out, nil
}

// DecodeSPBImage decompresses SPB and converts it to an NRGBA image.
func DecodeSPBImage(src []byte) (*image.NRGBA, error) {
	bmp, err := DecodeSPB(src)
	if err != nil {
		return nil, err
	}
	if len(bmp) < 54 {
		return nil, fmt.Errorf("spb: short bitmap")
	}
	width := int(binary.LittleEndian.Uint32(bmp[18:22]))
	height := int(binary.LittleEndian.Uint32(bmp[22:26]))
	stride := ((width*3 + 3) / 4) * 4
	if 54+stride*height > len(bmp) {
		return nil, fmt.Errorf("spb: bitmap body truncated")
	}
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	body := bmp[54:]
	for y := 0; y < height; y++ {
		row := body[(height-1-y)*stride:]
		dst := img.Pix[y*img.Stride:]
		for x := 0; x < width; x++ {
			s := x * 3
			d := x * 4
			dst[d+0] = row[s+2]
			dst[d+1] = row[s+1]
			dst[d+2] = row[s+0]
			dst[d+3] = 0xff
		}
	}
	return img, nil
}

func decodePlane(br *bitReader, size int) ([]byte, error) {
	plane := make([]byte, size)
	count := 0
	c, err := br.get(8)
	if err != nil {
		return nil, err
	}
	plane[count] = byte(c)
	count++
	for count < size {
		n, err := br.get(3)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			for i := 0; i < 4 && count < size; i++ {
				plane[count] = byte(c)
				count++
			}
			continue
		}
		var m int
		if n == 7 {
			b, err := br.get(1)
			if err != nil {
				return nil, err
			}
			m = b + 1
		} else {
			m = n + 2
		}
		for j := 0; j < 4; j++ {
			if m == 8 {
				c, err = br.get(8)
				if err != nil {
					return nil, err
				}
			} else {
				k, err := br.get(m)
				if err != nil {
					return nil, err
				}
				if k&1 == 1 {
					c += (k >> 1) + 1
				} else {
					c -= k >> 1
				}
				c &= 0xff
			}
			if count < size {
				plane[count] = byte(c)
				count++
			}
		}
	}
	return plane, nil
}

type bitReader struct {
	data []byte
	pos  int
}

func newBitReader(data []byte) *bitReader { return &bitReader{data: data} }

func (b *bitReader) get(n int) (int, error) {
	if n == 0 {
		return 0, nil
	}
	if b.pos+n > len(b.data)*8 {
		return 0, fmt.Errorf("out of data at bit %d", b.pos)
	}
	v := 0
	for i := 0; i < n; i++ {
		by := b.data[b.pos>>3]
		bit := (by >> (7 - uint(b.pos&7))) & 1
		v = (v << 1) | int(bit)
		b.pos++
	}
	return v, nil
}
