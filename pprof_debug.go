//go:build debug

package main

import (
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"
	"strings"
)

func startPprofServer() {
	addr := strings.TrimSpace(os.Getenv("CIPHERLEAF_PPROF_ADDR"))
	if addr == "" {
		return
	}
	go func() {
		log.Printf("pprof listening on http://%s/debug/pprof/", addr)
		if err := http.ListenAndServe(addr, nil); err != nil {
			log.Printf("pprof server stopped: %v", err)
		}
	}()
}
