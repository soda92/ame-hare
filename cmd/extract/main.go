// Command extract unpacks the game's ISO/CCD media into web-friendly assets.
//
// The game uses NScripter: CISCENE.DAT is an XOR-0x84 CP932 script, CIG.DAT is
// an NSA archive of SPB bitmaps, and disc 2 contains the voice WAVs.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"image/png"
	"io"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"amehare/pkg/disc"
	"amehare/pkg/nsa"
	"amehare/pkg/scene"
)

const title = "雨のち晴れのち こみっくアイランド"

type source struct {
	label   string
	dir     string
	img     *disc.Image
	files   []disc.File
	byPath  map[string]disc.File // normalized path -> file
	dirPath map[string]string    // normalized path -> absolute path
}

func main() {
	disc1 := flag.String("disc1", "", "disc 1 image (.img/.iso), its directory, or an extracted directory")
	disc2 := flag.String("disc2", "", "disc 2 image (.img/.iso), its directory, or an extracted directory")
	out := flag.String("out", "./data", "output directory")
	force := flag.Bool("force", false, "overwrite existing assets")
	jobs := flag.Int("jobs", runtime.NumCPU(), "image decode workers")
	skipImages := flag.Bool("skip-images", false, "skip CIG.DAT image extraction")
	skipAudio := flag.Bool("skip-audio", false, "skip WAV extraction")
	skipScript := flag.Bool("skip-script", false, "skip script extraction")
	skipMovie := flag.Bool("skip-movie", false, "skip movie extraction")
	flag.Parse()

	if *disc1 == "" {
		log.Fatal("extract: -disc1 is required")
	}
	if *jobs < 1 {
		*jobs = 1
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}

	s1, err := openSource(*disc1)
	if err != nil {
		log.Fatalf("disc1: %v", err)
	}
	defer s1.close()
	var s2 *source
	if *disc2 != "" {
		s2, err = openSource(*disc2)
		if err != nil {
			log.Fatalf("disc2: %v", err)
		}
		defer s2.close()
	}

	m := manifest{
		Title:  title,
		Screen: screen{Width: 800, Height: 600},
		Images: []string{},
		BGM:    []string{},
		Voice:  []string{},
		Source: sourceInfo{Disc1: s1.label},
	}
	if s2 != nil {
		m.Source.Disc2 = s2.label
	}

	if err := os.MkdirAll(filepath.Join(*out, "images"), 0o755); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(*out, "audio", "bgm"), 0o755); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(*out, "audio", "voice"), 0o755); err != nil {
		log.Fatal(err)
	}

	if !*skipScript {
		if err := extractScript(s1, *out); err != nil {
			log.Printf("script: %v", err)
		}
	}

	if !*skipImages {
		names, err := extractImages(s1, *out, *jobs, *force)
		if err != nil {
			log.Printf("images: %v", err)
		} else {
			m.Images = names
		}
	}

	if !*skipAudio {
		bgm, err := copyAudio(s1, "bgm/", filepath.Join(*out, "audio", "bgm"), *force)
		if err != nil {
			log.Printf("bgm: %v", err)
		}
		m.BGM = bgm
		if s2 != nil {
			voice, err := copyAudio(s2, "voice/", filepath.Join(*out, "audio", "voice"), *force)
			if err != nil {
				log.Printf("voice: %v", err)
			}
			m.Voice = voice
		}
	}

	if !*skipMovie {
		movie, err := extractMovie(s1, *out)
		if err != nil {
			log.Printf("movie: %v", err)
		}
		m.Movie = movie
	}

	m.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	enc, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(*out, "manifest.json"), append(enc, '\n'), 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("done: %d images, %d bgm, %d voice, script=%t movie=%q",
		len(m.Images), len(m.BGM), len(m.Voice), !*skipScript, m.Movie)
}

type manifest struct {
	Title       string     `json:"title"`
	Screen      screen     `json:"screen"`
	Script      string     `json:"script"`
	Images      []string   `json:"images"`
	BGM         []string   `json:"bgm"`
	Voice       []string   `json:"voice"`
	Movie       string     `json:"movie,omitempty"`
	Source      sourceInfo `json:"source"`
	GeneratedAt string     `json:"generatedAt"`
}

type screen struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type sourceInfo struct {
	Disc1 string `json:"disc1"`
	Disc2 string `json:"disc2,omitempty"`
}

func openSource(p string) (*source, error) {
	st, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		img, err := disc.Open(p)
		if err != nil {
			return nil, err
		}
		return sourceFromImage(p, img)
	}
	// A directory containing a disc image.
	for _, name := range []string{"image.img", "image.iso", "image.mdf"} {
		q := filepath.Join(p, name)
		if _, err := os.Stat(q); err == nil {
			img, err := disc.Open(q)
			if err != nil {
				return nil, err
			}
			return sourceFromImage(q, img)
		}
	}
	s := &source{label: p, dir: p, dirPath: map[string]string{}}
	err = filepath.WalkDir(p, func(q string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(p, q)
		if err != nil {
			return err
		}
		rel = strings.ReplaceAll(rel, string(filepath.Separator), "/")
		s.dirPath[strings.ToLower(rel)] = q
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s, nil
}

func sourceFromImage(p string, img *disc.Image) (*source, error) {
	files, err := img.Files()
	if err != nil {
		img.Close()
		return nil, err
	}
	s := &source{label: p, img: img, files: files, byPath: map[string]disc.File{}}
	for _, f := range files {
		if f.Dir {
			continue
		}
		s.byPath[strings.ToLower(strings.ReplaceAll(f.Path, "\\", "/"))] = f
	}
	return s, nil
}

func (s *source) close() {
	if s.img != nil {
		s.img.Close()
	}
}

func (s *source) list(prefix string) []string {
	prefix = strings.ToLower(prefix)
	var out []string
	if s.img != nil {
		for p := range s.byPath {
			if strings.HasPrefix(p, prefix) {
				out = append(out, p)
			}
		}
	} else {
		for p := range s.dirPath {
			if strings.HasPrefix(p, prefix) {
				out = append(out, p)
			}
		}
	}
	sort.Strings(out)
	return out
}

func (s *source) find(name string) (string, bool) {
	key := strings.ToLower(strings.ReplaceAll(name, "\\", "/"))
	if s.img != nil {
		_, ok := s.byPath[key]
		return key, ok
	}
	_, ok := s.dirPath[key]
	return key, ok
}

func (s *source) read(name string) ([]byte, error) {
	key, ok := s.find(name)
	if !ok {
		return nil, os.ErrNotExist
	}
	if s.img != nil {
		return s.img.ReadFile(s.byPath[key])
	}
	return os.ReadFile(s.dirPath[key])
}

func (s *source) readerAt(name string) (io.ReaderAt, int64, io.Closer, error) {
	key, ok := s.find(name)
	if !ok {
		return nil, 0, nil, os.ErrNotExist
	}
	if s.img != nil {
		f := s.byPath[key]
		return s.img.ReaderAt(f), int64(f.Size), nil, nil
	}
	f, err := os.Open(s.dirPath[key])
	if err != nil {
		return nil, 0, nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, nil, err
	}
	return f, st.Size(), f, nil
}

func extractScript(s *source, out string) error {
	raw, err := s.read("ciscene.dat")
	if err != nil {
		return err
	}
	text, err := scene.Decode(raw)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(text, ";mode800") {
		log.Printf("script: unexpected header: %q", firstLine(text))
	}
	if err := os.WriteFile(filepath.Join(out, "script.txt"), []byte(text), 0o644); err != nil {
		return err
	}
	log.Printf("script: %d bytes", len(text))
	return nil
}

func extractImages(s *source, out string, jobs int, force bool) ([]string, error) {
	r, size, closer, err := s.readerAt("cig.dat")
	if err != nil {
		return nil, err
	}
	if closer != nil {
		defer closer.Close()
	}
	a, err := nsa.Open(r, size)
	if err != nil {
		return nil, err
	}
	log.Printf("images: %d entries in cig.dat", len(a.Entries))

	root := filepath.Join(out, "images")
	var names []string
	var mu sync.Mutex
	var done atomic.Int64
	var failed atomic.Int64
	work := make(chan nsa.Entry)
	var wg sync.WaitGroup
	for i := 0; i < jobs; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for e := range work {
				rel := strings.ToLower(strings.ReplaceAll(e.Name, "\\", "/"))
				rel = strings.TrimPrefix(path.Clean("/"+rel), "/")
				if rel == "" || strings.HasPrefix(rel, "..") {
					failed.Add(1)
					continue
				}
				rel = strings.TrimSuffix(rel, path.Ext(rel)) + ".png"
				dst := filepath.Join(root, filepath.FromSlash(rel))
				if !force {
					if st, err := os.Stat(dst); err == nil && st.Size() > 0 {
						mu.Lock()
						names = append(names, strings.ToLower(e.Name))
						mu.Unlock()
						done.Add(1)
						continue
					}
				}
				bmp, err := a.Stored(e)
				if err != nil {
					failed.Add(1)
					log.Printf("image %s: %v", e.Name, err)
					continue
				}
				img, err := nsa.DecodeSPBImage(bmp)
				if err != nil {
					failed.Add(1)
					log.Printf("image %s: %v", e.Name, err)
					continue
				}
				if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
					failed.Add(1)
					continue
				}
				f, err := os.Create(dst)
				if err != nil {
					failed.Add(1)
					continue
				}
				enc := png.Encoder{CompressionLevel: png.DefaultCompression}
				err = enc.Encode(f, img)
				f.Close()
				if err != nil {
					failed.Add(1)
					log.Printf("image %s: %v", e.Name, err)
					continue
				}
				mu.Lock()
				names = append(names, strings.ToLower(e.Name))
				mu.Unlock()
				if n := done.Add(1); n%100 == 0 {
					log.Printf("images: %d/%d", n, len(a.Entries))
				}
			}
		}()
	}
	for _, e := range a.Entries {
		work <- e
	}
	close(work)
	wg.Wait()
	sort.Strings(names)
	if failed.Load() > 0 {
		log.Printf("images: %d failed", failed.Load())
	}
	log.Printf("images: wrote %d png files", len(names))
	return names, nil
}

func copyAudio(s *source, prefix, dst string, force bool) ([]string, error) {
	var names []string
	for _, p := range s.list(prefix) {
		if ext := strings.ToLower(path.Ext(p)); ext != ".wav" {
			continue
		}
		base := strings.ToLower(path.Base(p))
		target := filepath.Join(dst, base)
		if !force {
			if st, err := os.Stat(target); err == nil && st.Size() > 0 {
				names = append(names, base)
				continue
			}
		}
		buf, err := s.read(p)
		if err != nil {
			return names, fmt.Errorf("%s: %w", p, err)
		}
		if err := os.WriteFile(target, buf, 0o644); err != nil {
			return names, err
		}
		names = append(names, base)
	}
	sort.Strings(names)
	log.Printf("audio %s: %d wav files", prefix, len(names))
	return names, nil
}

func extractMovie(s *source, out string) (string, error) {
	if _, ok := s.find("cio.dat"); !ok {
		return "", nil
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		log.Printf("movie: ffmpeg not found; movie will be unavailable")
		return "", nil
	}
	tmp, err := os.CreateTemp("", "amehare-cio-*.dat")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	raw, err := s.read("cio.dat")
	if err != nil {
		tmp.Close()
		return "", err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return "", err
	}
	tmp.Close()
	dstDir := filepath.Join(out, "movie")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return "", err
	}
	dst := filepath.Join(dstDir, "cio.mp4")
	cmd := exec.Command(ffmpeg,
		"-hide_banner", "-loglevel", "warning", "-y",
		"-i", tmpName,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k",
		"-movflags", "+faststart",
		dst,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("ffmpeg: %w", err)
	}
	log.Printf("movie: wrote %s", dst)
	return "movie/cio.mp4", nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
