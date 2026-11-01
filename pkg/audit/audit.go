// Package audit statically checks an extracted NScripter script for broken
// labels, unbalanced loops, unhandled commands, and missing assets.
package audit

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type Level string

const (
	Error Level = "error"
	Warn  Level = "warn"
	Info  Level = "info"
)

type Issue struct {
	Line    int    `json:"line"`
	Level   Level  `json:"level"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

type Report struct {
	Script        string         `json:"script"`
	Lines         int            `json:"lines"`
	Labels        int            `json:"labels"`
	Commands      map[string]int `json:"commands"`
	MissingAssets []string       `json:"missingAssets,omitempty"`
	NoopCommands  []string       `json:"noopCommands,omitempty"`
	Issues        []Issue        `json:"issues"`
	Errors        int            `json:"errors"`
	Warnings      int            `json:"warnings"`
}

type Options struct {
	ScriptPath string
	DataDir    string
	VMSource   string
	Verbose    bool
	NoAssets   bool
	NoopCheck  bool
}

var (
	commandRe = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)`)
	labelRe   = regexp.MustCompile(`\*([A-Za-z_][A-Za-z0-9_]*)`)
	caseRe    = regexp.MustCompile(`case\s+"([a-z0-9_]+)"`)
	forRe     = regexp.MustCompile(`^%[0-9]+\s*=\s*.+?\s+to\s+.+`)
	taggedRe  = regexp.MustCompile(`^\(\s*"([^"]*)"\s*\)\s*"([^"]*)"\s*"([^"]*)"\s*$`)
)

// noop lists commands that the VM currently accepts but does not act on.
// They are reported for visibility, not as failures.
var noop = map[string]bool{
	"game": true, "caption": true, "versionstr": true,
	"automode": true, "automode_time": true, "kidokuskip": true,
	"filelog": true, "labellog": true, "globalon": true, "nsa": true,
	"savenumber": true, "noloaderror": true, "resetmenu": true,
	"deletemenu": true, "defaultfont": true, "selectcolor": true,
	"lookbackcolor": true, "lookbacksp": true, "maxkaisoupage": true,
	"noteraseman": true, "humanz": true, "windowback": true,
	"underline": true, "usewheel": true, "useescspc": true, "roff": true,
	"effectcut": true, "windoweffect": true, "effect": true,
	"transmode": true, "intlimit": true, "mp3fadeout": true,
	"chkcdfile": true, "mid": true, "split": true, "cmp": true,
	"sin": true, "cos": true, "tan": true, "strsp": true, "strsph": true,
}

type auditor struct {
	opts            Options
	report          Report
	labels          map[string]int
	labelRefs       []labelRef
	unknownReported map[string]bool
	missing         map[string]int
	forStack        []int
	forLabel        string
}

type labelRef struct {
	line  int
	label string
}

// Run parses script and returns a report.
func Run(script string, opts Options) Report {
	a := &auditor{
		opts: opts,
		report: Report{
			Script:   opts.ScriptPath,
			Commands: map[string]int{},
			Issues:   []Issue{},
		},
		labels:          map[string]int{},
		unknownReported: map[string]bool{},
		missing:         map[string]int{},
	}
	if opts.VMSource != "" {
		a.report.Commands = map[string]int{}
	}
	vmCommands := loadVMCommands(opts.VMSource)
	if opts.VMSource != "" && vmCommands == nil {
		a.issue(0, Warn, "vm-source", fmt.Sprintf("could not read VM command list: %s", opts.VMSource))
	}
	if vmCommands != nil {
		vmCommands["if"] = true
		vmCommands["notif"] = true
		vmCommands["#"] = true
	}

	lines := strings.Split(strings.ReplaceAll(script, "\r\n", "\n"), "\n")
	a.report.Lines = len(lines)
	// First pass: labels.
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "*") {
			name := strings.TrimSpace(line[1:])
			key := strings.ToLower(name)
			if name == "" {
				a.issue(i+1, Error, "label", "empty label")
				continue
			}
			if prev, ok := a.labels[key]; ok {
				a.issue(i+1, Error, "label", fmt.Sprintf("duplicate label %s (first at line %d)", name, prev))
				continue
			}
			a.labels[key] = i + 1
		}
	}
	a.report.Labels = len(a.labels)

	// Second pass: commands, loops, refs.
	for i, raw := range lines {
		lineNo := i + 1
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "*") {
			if len(a.forStack) > 0 {
				for _, at := range a.forStack {
					a.issue(at, Error, "for", "for loop is not closed before the next label")
				}
				a.forStack = nil
			}
			a.forLabel = strings.ToLower(strings.TrimSpace(line[1:]))
			continue
		}
		if !isCommandStart(line) {
			continue
		}
		for _, part := range splitTopLevel(line, ':') {
			a.scanPart(lineNo, part, vmCommands)
		}
	}
	for _, at := range a.forStack {
		a.issue(at, Error, "for", "for loop is never closed")
	}

	// Third pass: validate label references.
	for _, ref := range a.labelRefs {
		if _, ok := a.labels[strings.ToLower(ref.label)]; !ok {
			a.issue(ref.line, Error, "label", fmt.Sprintf("label not found: %s", ref.label))
		}
	}

	if !opts.NoAssets {
		a.checkDataDir()
	}
	a.finish()
	return a.report
}

func (a *auditor) scanPart(lineNo int, part string, vmCommands map[string]bool) {
	part = strings.TrimSpace(part)
	if part == "" {
		return
	}
	name := commandName(part)
	if name == "" {
		return
	}
	rest := strings.TrimSpace(part[len(name):])
	if name != "if" && name != "notif" {
		a.report.Commands[name]++
		if vmCommands != nil && !vmCommands[name] && !a.unknownReported[name] {
			a.unknownReported[name] = true
			a.issue(lineNo, Error, "command", fmt.Sprintf("unhandled command: %s", name))
		}
	}
	for _, m := range labelRe.FindAllStringSubmatch(part, -1) {
		a.labelRefs = append(a.labelRefs, labelRef{line: lineNo, label: m[1]})
	}

	switch name {
	case "if", "notif":
		body := bodyOf(stripLchk(rest))
		if body == "" {
			a.issue(lineNo, Warn, "if", "conditional has no body")
			return
		}
		for _, sub := range splitTopLevel(body, ':') {
			a.scanPart(lineNo, sub, vmCommands)
		}
		return
	case "for":
		if !forRe.MatchString(rest) {
			a.issue(lineNo, Warn, "for", "unrecognised for syntax")
		}
		a.forStack = append(a.forStack, lineNo)
	case "next":
		if len(a.forStack) == 0 {
			a.issue(lineNo, Error, "next", "next without a matching for")
		} else {
			a.forStack = a.forStack[:len(a.forStack)-1]
		}
	case "csel":
		args := splitArgs(rest)
		if len(args)%2 != 0 {
			a.issue(lineNo, Error, "csel", "csel needs text/label pairs")
		}
	}

	args := splitArgs(rest)
	arg := func(i int) string {
		if i < len(args) {
			return args[i]
		}
		return ""
	}
	switch name {
	case "bg":
		a.checkImage(lineNo, arg(0))
	case "ld":
		a.checkImage(lineNo, arg(1))
	case "lsp", "lsph":
		a.checkImage(lineNo, arg(1))
	case "btndef":
		v := strings.TrimSpace(unquote(arg(0)))
		if v != "" && !strings.EqualFold(v, "clear") {
			a.checkImage(lineNo, v)
		}
	case "setwindow":
		if len(args) > 11 {
			a.checkImage(lineNo, arg(11))
		}
	case "bgm", "wave", "waveloop", "mp3", "mp3loop", "play", "playonce":
		a.checkAudio(lineNo, arg(0))
	case "dwave", "dwaveloop":
		a.checkAudio(lineNo, arg(1))
	case "mpegplay", "movieplay", "aviplay":
		a.checkMovie(lineNo, arg(0))
	}
}

func (a *auditor) checkImage(lineNo int, raw string) {
	if a.opts.NoAssets {
		return
	}
	v := strings.TrimSpace(unquote(raw))
	if v == "" {
		return
	}
	if m := taggedRe.FindStringSubmatch(v); m != nil {
		// ("tag")"thumbnail""dummy": audit the thumbnail, not the tag/dummy.
		v = m[2]
	}
	if strings.EqualFold(v, "black") || strings.EqualFold(v, "white") || strings.HasPrefix(v, "#") {
		return
	}
	if strings.HasPrefix(v, "$") || strings.Contains(v, "%") {
		a.issue(lineNo, Info, "asset", fmt.Sprintf("dynamic image reference: %s", v))
		return
	}
	if strings.HasPrefix(v, ":") {
		s := v[1:]
		for len(s) > 0 && (s[0] == 'b' || s[0] == 'f') {
			s = s[1:]
		}
		if len(s) > 0 && s[0] == 's' {
			return // string sprite, no file
		}
		if i := strings.IndexByte(s, ';'); i >= 0 {
			s = s[i+1:]
		} else {
			return
		}
		v = s
	}
	if v == "" {
		return
	}
	v = strings.ReplaceAll(v, "\\", "/")
	v = strings.ToLower(v)
	ext := path.Ext(v)
	if ext != "" {
		v = strings.TrimSuffix(v, ext)
	}
	a.missingAsset("images/"+v+".png", lineNo)
}

func (a *auditor) checkAudio(lineNo int, raw string) {
	if a.opts.NoAssets {
		return
	}
	v := strings.TrimSpace(unquote(raw))
	if v == "" {
		return
	}
	if strings.HasPrefix(v, "$") || strings.Contains(v, "%") {
		a.issue(lineNo, Info, "asset", fmt.Sprintf("dynamic audio reference: %s", v))
		return
	}
	v = strings.ToLower(strings.ReplaceAll(v, "\\", "/"))
	a.missingAsset("audio/"+v, lineNo)
}

func (a *auditor) checkMovie(lineNo int, raw string) {
	if a.opts.NoAssets {
		return
	}
	v := strings.TrimSpace(unquote(raw))
	if v == "" || strings.HasPrefix(v, "$") {
		return
	}
	v = strings.ToLower(strings.ReplaceAll(v, "\\", "/"))
	ext := path.Ext(v)
	if ext != "" {
		v = strings.TrimSuffix(v, ext)
	}
	a.missingAsset("movie/"+v+".mp4", lineNo)
}

func (a *auditor) missingAsset(rel string, lineNo int) {
	if _, ok := a.missing[rel]; !ok {
		a.missing[rel] = lineNo
	}
	if _, err := os.Stat(filepath.Join(a.opts.DataDir, filepath.FromSlash(rel))); err != nil {
		// recorded at finish()
	}
}

func (a *auditor) checkDataDir() {
	if a.opts.DataDir == "" {
		return
	}
	if st, err := os.Stat(a.opts.DataDir); err != nil || !st.IsDir() {
		a.issue(0, Error, "data", fmt.Sprintf("data directory not found: %s", a.opts.DataDir))
	}
}

func (a *auditor) finish() {
	for rel, line := range a.missing {
		if _, err := os.Stat(filepath.Join(a.opts.DataDir, filepath.FromSlash(rel))); err != nil {
			a.issue(line, Error, "asset", "missing asset: "+rel)
			a.report.MissingAssets = append(a.report.MissingAssets, rel)
		}
	}
	sort.Strings(a.report.MissingAssets)
	if a.opts.NoopCheck {
		for name := range a.report.Commands {
			if noop[name] {
				a.report.NoopCommands = append(a.report.NoopCommands, name)
			}
		}
		sort.Strings(a.report.NoopCommands)
	}
	sort.SliceStable(a.report.Issues, func(i, j int) bool {
		if a.report.Issues[i].Line != a.report.Issues[j].Line {
			return a.report.Issues[i].Line < a.report.Issues[j].Line
		}
		return a.report.Issues[i].Message < a.report.Issues[j].Message
	})
	for _, is := range a.report.Issues {
		switch is.Level {
		case Error:
			a.report.Errors++
		case Warn:
			a.report.Warnings++
		}
	}
}

func (a *auditor) issue(line int, level Level, kind, message string) {
	a.report.Issues = append(a.report.Issues, Issue{Line: line, Level: level, Kind: kind, Message: message})
}

func loadVMCommands(file string) map[string]bool {
	if file == "" {
		return nil
	}
	buf, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	out := map[string]bool{}
	for _, m := range caseRe.FindAllStringSubmatch(string(buf), -1) {
		out[m[1]] = true
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func commandName(s string) string {
	m := commandRe.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1])
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

func stripLchk(s string) string {
	t := strings.TrimSpace(s)
	lower := strings.ToLower(t)
	if !strings.HasPrefix(lower, "lchk") {
		return s
	}
	if len(t) > 4 {
		c := t[4]
		if c != ' ' && c != '\t' && c != '*' {
			return s
		}
	}
	t = strings.TrimSpace(t[4:])
	if strings.HasPrefix(t, "*") {
		t = t[1:]
	}
	i := 0
	for i < len(t) {
		c := t[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' {
			i++
		} else {
			break
		}
	}
	return strings.TrimSpace(t[i:])
}

func bodyOf(rest string) string {
	quote := false
	depth := 0
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if c == '"' {
			quote = !quote
			continue
		}
		if quote {
			continue
		}
		if c == '(' {
			depth++
			continue
		}
		if c == ')' {
			if depth > 0 {
				depth--
			}
			continue
		}
		if depth == 0 && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_') {
			return strings.TrimSpace(rest[i:])
		}
	}
	return ""
}

func splitTopLevel(s string, sep byte) []string {
	var out []string
	start := 0
	quote := false
	depth := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' {
			quote = !quote
			continue
		}
		if quote {
			continue
		}
		if c == '(' {
			depth++
		} else if c == ')' {
			if depth > 0 {
				depth--
			}
		} else if c == sep && depth == 0 {
			if v := strings.TrimSpace(s[start:i]); v != "" {
				out = append(out, v)
			}
			start = i + 1
		}
	}
	if v := strings.TrimSpace(s[start:]); v != "" {
		out = append(out, v)
	}
	return out
}

func splitArgs(s string) []string {
	return splitTopLevel(s, ',')
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		s = s[1 : len(s)-1]
		s = strings.ReplaceAll(s, `\"`, `"`)
		s = strings.ReplaceAll(s, `\\`, `\`)
	}
	return s
}
