//go:build !debug

package main

func startPprofServer() {
	// Production builds intentionally omit the debug pprof server.
}
