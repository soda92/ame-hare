// Command translate builds data/translations.json from the extracted NScripter
// script. It translates dialogue lines and :s string sprites with the public
// Google Translate web endpoint, batches requests, retries rate limits, and
// writes progress after every batch so it can be resumed.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const endpoint = "https://clients5.google.com/translate_a/t"

var (
	spriteRe  = regexp.MustCompile(`:s/[^;]*;(?:#[0-9A-Fa-f]{6})+([^"]*)`)
	quotedRe  = regexp.MustCompile(`"((?:[^"\\]|\\.)*)"`)
	chapterRe = regexp.MustCompile(`mov\s+\$(?:89|90)\s*,\s*"((?:[^"\\]|\\.)*)"`)
)

var overrides = map[string]string{
	"えーーー！\u3000どうしてぇ！！": "Whaaat!? Why!?",
	"え？\u3000あれ？":        "Huh? What?",
	"え？\u3000わ、私！？":      "Huh? M-me!?",
	"おっ、戻ってきたぞ。蒼介！":      "Oh, you're back, Sosuke!",
	"おっ！いい根性してるな？":       "Oh! You've got guts, huh?",
	"おっ！真名はやる気満々だな":      "Oh! Mana is raring to go.",
	"大ッ嫌いっ！！":            "I hate you!!",
	"大丈夫ですか？留奈さん！":       "Are you okay, Runa?",
	"大丈夫なのかよ！？":          "Are you really okay!?",
	"こむぎ":                "Komugi",
	"ももの桃源郷":             "Momo's Paradise",
	"真名":                 "Mana",
	"真名の過去":              "Mana's Past",
	"真名の部屋":              "Mana's Room",
	"『真名の生い立ち』篇":         `"Mana's Background" Arc`,
	"真名と月姫・秘密":           "Mana and Tsukihime's Secret",
	"真名と蒼介・告白":           "Mana and Sosuke's Confession",
	"未来と蒼介・告白":           "Mirai and Sosuke's Confession",
	"第５話：真名・思い切り笑う":      "Episode 5: Mana Laughs Heartily",
	"第１０話：蒼介・剣崎に告白する":    "Episode 10: Sosuke Confesses to Kenzaki",
	"第１０話：蒼介・深崎に告白する":    "Episode 10: Sosuke Confesses to Fukasaki",
	"第９話：一乃瀬・蒼介の部屋へ":     "Episode 9: Ichinose Goes to Sosuke's Room",
	"第９話：橘・蒼介の部屋へ":       "Episode 9: Tachibana Goes to Sosuke's Room",
	"第１話：閑話休題『もも＆マスター篇』": "Episode 1: Interlude - Momo & Master",
	"第１話：閑話休題『剣崎＆神無月篇』":  "Episode 1: Interlude - Kenzaki & Kannazuki",
}

var nameFixes = [][2]string{
	{"Sousuke", "Sosuke"},
	{"Ruuna", "Runa"},
	{"Kannaduki", "Kannazuki"},
	{"Kensaki", "Kenzaki"},
	{"Tukihime", "Tsukihime"},
	{"True Name", "Mana"},
	{"True name", "Mana"},
}

type translationFile struct {
	Version int               `json:"version"`
	Source  string            `json:"source"`
	Target  string            `json:"target"`
	Text    map[string]string `json:"text"`
	Sprites map[string]string `json:"sprites"`
}

type job struct {
	source map[string]string
	kind   string
}

func main() {
	scriptPath := flag.String("script", "./data/script.txt", "UTF-8 extracted script")
	out := flag.String("out", "./data/translations.json", "translation sidecar")
	batchSize := flag.Int("batch", 40, "strings per request")
	maxChars := flag.Int("max-chars", 600, "approximate source characters per request")
	sleep := flag.Duration("sleep", 500*time.Millisecond, "delay between batches")
	limit := flag.Int("limit", 0, "maximum strings per kind (0 = all)")
	force := flag.Bool("force", false, "retranslate existing entries")
	kind := flag.String("kind", "all", "all, text, or sprites")
	dryRun := flag.Bool("dry-run", false, "only report the work that would be done")
	repair := flag.Bool("repair", false, "retry entries whose English still contains Japanese")
	retries := flag.Int("retries", 6, "attempts per batch")
	flag.Parse()

	raw, err := os.ReadFile(*scriptPath)
	if err != nil {
		log.Fatalf("translate: %v", err)
	}
	if *kind != "all" && *kind != "text" && *kind != "sprites" {
		log.Fatalf("translate: -kind must be all, text, or sprites")
	}
	texts, sprites := extract(string(raw))
	if len(texts) == 0 && len(sprites) == 0 {
		log.Fatal("translate: no text found")
	}

	file, err := readFile(*out)
	if err != nil {
		log.Fatal(err)
	}
	jobs := []job{}
	if *kind == "all" || *kind == "text" {
		jobs = append(jobs, job{source: file.Text, kind: "text"})
	}
	if *kind == "all" || *kind == "sprites" {
		jobs = append(jobs, job{source: file.Sprites, kind: "sprites"})
	}

	if *dryRun {
		for _, j := range jobs {
			missing := missingFor(j.source, j.kind, texts, sprites, *force)
			log.Printf("%s: %d unique, %d to translate", j.kind, countFor(j.kind, texts, sprites), len(missing))
		}
		return
	}

	client := &http.Client{Timeout: 45 * time.Second}
	for _, j := range jobs {
		missing := missingFor(j.source, j.kind, texts, sprites, *force)
		if *limit > 0 && len(missing) > *limit {
			missing = missing[:*limit]
		}
		if len(missing) == 0 {
			log.Printf("%s: nothing to do", j.kind)
			continue
		}
		log.Printf("%s: translating %d strings", j.kind, len(missing))
		for start := 0; start < len(missing); {
			end := start + *batchSize
			if end > len(missing) {
				end = len(missing)
			}
			chars := 0
			for end > start {
				chars = 0
				for _, s := range missing[start:end] {
					chars += len([]rune(s))
				}
				if chars <= *maxChars || end == start+1 {
					break
				}
				end--
			}
			batch := missing[start:end]
			translated, err := translateBatch(client, batch, *retries)
			if err != nil {
				log.Fatalf("translate %s batch %d-%d: %v", j.kind, start, end, err)
			}
			for i, src := range batch {
				j.source[src] = translated[i]
			}
			if err := writeFile(*out, file); err != nil {
				log.Fatal(err)
			}
			start = end
			log.Printf("%s: %d/%d", j.kind, start, len(missing))
			if start < len(missing) {
				time.Sleep(*sleep)
			}
		}
	}
	if *repair {
		for _, j := range jobs {
			repairEntries(client, j.source, j.kind, *retries)
			if err := writeFile(*out, file); err != nil {
				log.Fatal(err)
			}
		}
	}
	if err := writeFile(*out, file); err != nil {
		log.Fatal(err)
	}
	log.Printf("done: %s", *out)
}

func extract(script string) ([]string, []string) {
	textSet := map[string]bool{}
	spriteSet := map[string]bool{}
	for _, raw := range strings.Split(strings.ReplaceAll(script, "\r\n", "\n"), "\n") {
		line := strings.Trim(raw, " \t")
		if line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "*") {
			continue
		}
		if isCommandStart(line) {
			for _, m := range spriteRe.FindAllStringSubmatch(line, -1) {
				v := strings.TrimSpace(m[1])
				if v != "" && !strings.ContainsAny(v, "$%") {
					spriteSet[v] = true
				}
			}
			for _, m := range chapterRe.FindAllStringSubmatch(line, -1) {
				v := strings.TrimSpace(m[1])
				if v != "" && !strings.ContainsAny(v, "$%") {
					spriteSet[v] = true
				}
			}
			lower := strings.ToLower(line)
			if strings.HasPrefix(lower, "csel") || strings.HasPrefix(lower, "select") {
				for _, m := range quotedRe.FindAllStringSubmatch(line, -1) {
					v := strings.TrimSpace(m[1])
					if v != "" {
						textSet[v] = true
					}
				}
			}
			continue
		}
		if line[len(line)-1] == '\\' || line[len(line)-1] == '@' {
			line = line[:len(line)-1]
		}
		if line != "" {
			textSet[line] = true
		}
	}
	return sorted(textSet), sorted(spriteSet)
}

func isCommandStart(s string) bool {
	if s == "" {
		return false
	}
	c := s[0]
	if c == '#' || c == '!' {
		return true
	}
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}

func sorted(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func missingFor(existing map[string]string, kind string, texts, sprites []string, force bool) []string {
	var source []string
	if kind == "text" {
		source = texts
	} else {
		source = sprites
	}
	var out []string
	for _, s := range source {
		if force || strings.TrimSpace(existing[s]) == "" {
			out = append(out, s)
		}
	}
	return out
}

func countFor(kind string, texts, sprites []string) int {
	if kind == "text" {
		return len(texts)
	}
	return len(sprites)
}

func readFile(path string) (*translationFile, error) {
	file := &translationFile{
		Version: 1,
		Source:  "ja",
		Target:  "en",
		Text:    map[string]string{},
		Sprites: map[string]string{},
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, file); err != nil {
		return nil, err
	}
	if file.Text == nil {
		file.Text = map[string]string{}
	}
	if file.Sprites == nil {
		file.Sprites = map[string]string{}
	}
	file.Version = 1
	file.Source = "ja"
	file.Target = "en"
	return file, nil
}

func writeFile(path string, file *translationFile) error {
	polishMap(file.Text)
	polishMap(file.Sprites)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func repairEntries(client *http.Client, entries map[string]string, kind string, retries int) {
	keys := make([]string, 0, len(entries))
	for k, v := range entries {
		if hasJapanese(v) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		log.Printf("%s: repair: nothing to do", kind)
		return
	}
	log.Printf("%s: repair: retrying %d entries", kind, len(keys))
	for _, k := range keys {
		out, err := translateBatch(client, []string{k}, retries)
		if err != nil {
			log.Printf("%s: repair %q: %v", kind, k, err)
			continue
		}
		if len(out) == 1 && strings.TrimSpace(out[0]) != "" && !hasJapanese(out[0]) {
			entries[k] = out[0]
		} else if len(out) == 1 {
			log.Printf("%s: repair %q still Japanese: %s", kind, k, out[0])
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func polishMap(m map[string]string) {
	for k, v := range m {
		if o, ok := overrides[k]; ok {
			m[k] = o
		} else {
			m[k] = polish(v)
		}
	}
}

var (
	spaceBeforePunct = regexp.MustCompile(`\s+([!?])`)
	splitPunct       = regexp.MustCompile(`([!?])\s+([!?])`)
)

func polish(s string) string {
	s = strings.ReplaceAll(s, "\u3000", " ")
	s = spaceBeforePunct.ReplaceAllString(s, "$1")
	s = splitPunct.ReplaceAllString(s, "$1$2")
	for _, p := range nameFixes {
		s = strings.ReplaceAll(s, p[0], p[1])
	}
	return strings.TrimSpace(s)
}

func hasJapanese(s string) bool {
	for _, r := range s {
		if (r >= 0x3040 && r <= 0x30ff) || (r >= 0x3400 && r <= 0x9fff) || (r >= 0xf900 && r <= 0xfaff) {
			return true
		}
	}
	return false
}

func translateBatch(client *http.Client, texts []string, retries int) ([]string, error) {
	if len(texts) == 0 {
		return []string{}, nil
	}
	values := url.Values{}
	values.Set("client", "dict-chrome-ex")
	values.Set("sl", "ja")
	values.Set("tl", "en")
	for _, text := range texts {
		values.Add("q", text)
	}
	target := endpoint + "?" + values.Encode()
	var lastErr error
	for attempt := 0; attempt < retries; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(1<<attempt) * time.Second)
		}
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		_ = resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			continue
		}
		if resp.StatusCode == http.StatusBadRequest && len(texts) > 1 {
			mid := len(texts) / 2
			left, err := translateBatch(client, texts[:mid], retries)
			if err != nil {
				return nil, err
			}
			right, err := translateBatch(client, texts[mid:], retries)
			if err != nil {
				return nil, err
			}
			return append(left, right...), nil
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}
		var raw []json.RawMessage
		if err := json.Unmarshal(body, &raw); err != nil {
			return nil, fmt.Errorf("decode: %w (%s)", err, string(body))
		}
		if len(raw) != len(texts) {
			return nil, fmt.Errorf("got %d results for %d inputs", len(raw), len(texts))
		}
		out := make([]string, len(raw))
		for i, item := range raw {
			var translated string
			if err := json.Unmarshal(item, &translated); err != nil {
				var nested []string
				if err := json.Unmarshal(item, &nested); err != nil || len(nested) == 0 {
					return nil, fmt.Errorf("unexpected result %s", item)
				}
				translated = nested[0]
			}
			out[i] = translated
		}
		return out, nil
	}
	return nil, lastErr
}
