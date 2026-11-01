// Package scene decodes the encrypted NScripter script file used by the game.
package scene

import (
	"fmt"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/transform"
)

// XORKey is used by NScripter for nscript.dat / ciscene.dat.
const XORKey = 0x84

// Decode removes the NScripter XOR obfuscation and converts CP932 to UTF-8.
func Decode(raw []byte) (string, error) {
	buf := make([]byte, len(raw))
	for i, b := range raw {
		buf[i] = b ^ XORKey
	}
	out, _, err := transform.Bytes(japanese.ShiftJIS.NewDecoder(), buf)
	if err != nil {
		return "", fmt.Errorf("scene: decode CP932: %w", err)
	}
	return string(out), nil
}
