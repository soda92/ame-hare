// Command server serves the AmeHare web player and extracted game data.
package main

import (
	"flag"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type server struct {
	dataDir string
	webDir  string
}

func main() {
	data := flag.String("data", "./data", "extracted data directory")
	web := flag.String("web", "./web-app/dist", "built frontend directory")
	addr := flag.String("addr", ":8080", "listen address")
	dev := flag.Bool("dev", false, "proxy frontend requests to the Vite dev server")
	viteAddr := flag.String("vite", "http://localhost:5173", "Vite dev server URL for -dev")
	flag.Parse()

	s := &server{dataDir: *data, webDir: *web}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/manifest", s.handleManifest)
	mux.HandleFunc("/api/script", s.handleScript)
	mux.Handle("/media/", http.StripPrefix("/media/", withCache(http.FileServer(http.Dir(s.dataDir)), 24*time.Hour)))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok\n"))
	})

	if *dev {
		target, err := url.Parse(*viteAddr)
		if err != nil || target.Scheme == "" || target.Host == "" {
			log.Fatalf("invalid -vite URL %q", *viteAddr)
		}
		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.FlushInterval = -1
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("vite proxy: %v", err)
			http.Error(w, "Vite dev server is not reachable at "+target.String(), http.StatusBadGateway)
		}
		mux.Handle("/", proxy)
		log.Printf("ame-hare: serving %s with Vite dev proxy %s on %s", *data, target.String(), *addr)
	} else {
		mux.Handle("/", http.FileServer(http.Dir(*web)))
		log.Printf("ame-hare: serving %s on %s", *data, *addr)
	}
	if err := http.ListenAndServe(*addr, logRequests(mux)); err != nil {
		log.Fatal(err)
	}
}

func (s *server) handleManifest(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(s.dataDir, "manifest.json")
	buf, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "manifest.json not found; run cmd/extract first", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(buf)
}

func (s *server) handleScript(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(s.dataDir, "script.txt")
	buf, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "script.txt not found; run cmd/extract first", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(buf)
}

func withCache(h http.Handler, d time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".wav") || strings.HasSuffix(r.URL.Path, ".png") ||
			strings.HasSuffix(r.URL.Path, ".mp4") {
			w.Header().Set("Cache-Control", "public, max-age="+strconv.Itoa(int(d.Seconds())))
		}
		h.ServeHTTP(w, r)
	})
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if !strings.HasPrefix(r.URL.Path, "/media/") || strings.HasSuffix(r.URL.Path, ".mp4") {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
