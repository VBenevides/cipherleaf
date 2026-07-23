package vault

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

var benchmarkKeySink []byte

func benchmarkIndexedVault(b *testing.B, noteCount int) *Store {
	b.Helper()
	store, _ := benchmarkVault(b, 0)
	notes := make([]NoteSummary, noteCount)
	index := make(map[string]string, noteCount)
	targetID := fmt.Sprintf("%032x", 1)
	for item := range noteCount {
		id := fmt.Sprintf("%032x", item+1)
		notes[item] = NoteSummary{
			ID: id, Title: fmt.Sprintf("Note %05d", item), OutgoingLinks: []string{"Target|note:" + targetID},
		}
		index[id] = fmt.Sprintf("indexed searchable content %d", item)
	}
	store.mu.Lock()
	store.manifest.Notes = notes
	store.searchIndex = index
	store.noteIndexes = nil
	store.mu.Unlock()
	return store
}

func reportRuntimeMetrics(b *testing.B, before runtime.MemStats) {
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	operations := float64(max(b.N, 1))
	b.ReportMetric(float64(after.NumGC-before.NumGC)/operations, "gc/op")
	b.ReportMetric(float64(after.PauseTotalNs-before.PauseTotalNs)/operations, "gc-pause-ns/op")
	b.ReportMetric(float64(after.HeapSys), "heap-sys-B")
}

func reportVaultDiskMetrics(b *testing.B, root string) {
	var bytes, files int64
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			bytes += info.Size()
			files++
		}
		return nil
	}); err != nil {
		b.Fatal(err)
	}
	b.ReportMetric(float64(bytes), "vault-B")
	b.ReportMetric(float64(files), "vault-files")
}

func BenchmarkOptimizationScaling(b *testing.B) {
	for _, noteCount := range []int{100, 1000, 10000} {
		store := benchmarkIndexedVault(b, noteCount)
		b.Run(fmt.Sprintf("list_notes_%d", noteCount), func(b *testing.B) {
			b.ReportAllocs()
			var memory runtime.MemStats
			var result []NoteSummary
			runtime.ReadMemStats(&memory)
			b.ResetTimer()
			for b.Loop() {
				var err error
				if result, err = store.ListNotes(); err != nil {
					b.Fatal(err)
				}
			}
			b.StopTimer()
			reportRuntimeMetrics(b, memory)
			b.ReportMetric(float64(noteCount), "items/op")
			b.ReportMetric(float64(len(result)), "results/op")
		})
		for _, query := range []string{"searchable", "missing"} {
			b.Run(fmt.Sprintf("indexed_search_%s_%d", query, noteCount), func(b *testing.B) {
				b.ReportAllocs()
				var memory runtime.MemStats
				var result []FindMatch
				runtime.ReadMemStats(&memory)
				b.ResetTimer()
				for b.Loop() {
					var err error
					if result, err = store.FindInNotes(query, 5); err != nil {
						b.Fatal(err)
					}
				}
				b.StopTimer()
				reportRuntimeMetrics(b, memory)
				b.ReportMetric(float64(noteCount), "items/op")
				b.ReportMetric(float64(len(result)), "results/op")
			})
		}
		b.Run(fmt.Sprintf("backlinks_%d", noteCount), func(b *testing.B) {
			b.ReportAllocs()
			var memory runtime.MemStats
			var result []FindMatch
			runtime.ReadMemStats(&memory)
			b.ResetTimer()
			for b.Loop() {
				var err error
				if result, err = store.ListBacklinks(fmt.Sprintf("%032x", 1)); err != nil {
					b.Fatal(err)
				}
			}
			b.StopTimer()
			reportRuntimeMetrics(b, memory)
			b.ReportMetric(float64(noteCount), "items/op")
			b.ReportMetric(float64(len(result)), "results/op")
		})
	}
}

func BenchmarkSearchCases(b *testing.B) {
	store, _ := benchmarkVault(b, 1000)
	for _, query := range []string{"Note 00000", "searchable", "missing"} {
		b.Run(query, func(b *testing.B) {
			b.ReportAllocs()
			var result []NoteSummary
			for b.Loop() {
				var err error
				if result, err = store.Search(query); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(len(result)), "results/op")
		})
	}
}

func BenchmarkAutosaveWorkflow(b *testing.B) {
	store, target := benchmarkVault(b, 1000)
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	b.ReportAllocs()
	var result SavedNote
	b.ResetTimer()
	for index := 0; b.Loop(); index++ {
		note, err := store.SaveNote(target.ID, target.Title, fmt.Sprintf("workflow revision %d", index))
		if err != nil {
			b.Fatal(err)
		}
		summary, err := store.GetNoteSummary(target.ID)
		if err != nil {
			b.Fatal(err)
		}
		result = SavedNote{Note: note, Summary: summary}
	}
	b.StopTimer()
	payload, err := json.Marshal(result)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportMetric(float64(len(payload)), "payload-B")
	b.ReportMetric(1, "results/op")
	reportRuntimeMetrics(b, memory)
	reportVaultDiskMetrics(b, store.root)
}

func BenchmarkOpenPhases(b *testing.B) {
	store, _ := benchmarkVaultFixture(b, 1000)
	root := store.root
	key := bytes.Clone(store.key)
	vaultID := store.vaultID
	var config vaultConfig
	if err := readJSON(filepath.Join(root, configFilename), 1024*1024, &config); err != nil {
		b.Fatal(err)
	}
	store.Lock()

	b.Run("unlock_kdf", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			var err error
			benchmarkKeySink, err = unwrapMasterKey(config, "benchmark-secret")
			if err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("manifest_load", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			candidate := NewStore()
			candidate.root, candidate.vaultID, candidate.key = root, vaultID, bytes.Clone(key)
			if err := candidate.loadManifestLocked(); err != nil {
				b.Fatal(err)
			}
		}
	})
	opened := NewStore()
	if _, err := opened.Open(root, "benchmark-secret"); err != nil {
		b.Fatal(err)
	}
	b.Run("search_index_rebuild", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if err := opened.rebuildSearchIndexLocked(); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("open_plus_first_search", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			candidate := NewStore()
			if _, err := candidate.Open(root, "benchmark-secret"); err != nil {
				b.Fatal(err)
			}
			if _, err := candidate.FindInNotes("searchable", 5); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkTimeDashboardCache(b *testing.B) {
	store, _ := benchmarkVault(b, 0)
	store.mu.Lock()
	if err := enableTimeTrackingCapability(&store.manifest); err != nil {
		store.mu.Unlock()
		b.Fatal(err)
	}
	if err := store.saveManifestLocked(); err != nil {
		store.mu.Unlock()
		b.Fatal(err)
	}
	bucket := timeTrackingBucket{FormatVersion: TimeTrackingCatalogFormatVersion, ID: fmt.Sprintf("%032x", 900)}
	for index := range 10000 {
		bucket.Entries = append(bucket.Entries, dashboardTestEntry(
			index+1000, "Dashboard task", "", nil, "2026-07-01T10:00:00Z", "2026-07-01T11:00:00Z",
		))
	}
	if err := store.writeTimeTrackingBucketLocked(bucket); err != nil {
		store.mu.Unlock()
		b.Fatal(err)
	}
	catalog := cloneTimeTrackingCatalog(*store.timeTrackingCatalog)
	catalog.Buckets = updateTimeTrackingBucketSummary(
		append(catalog.Buckets, timeTrackingBucketSummary{ID: bucket.ID, MonthUTC: "2026-07"}),
		bucket,
	)
	if err := store.writeTimeTrackingCatalogLocked(catalog); err != nil {
		store.mu.Unlock()
		b.Fatal(err)
	}
	store.timeTrackingCatalog = &catalog
	store.mu.Unlock()

	for _, mode := range []string{"cold", "warm"} {
		b.Run(mode, func(b *testing.B) {
			reads := 0
			store.mu.Lock()
			store.timeTrackingBucketRead = func(string) { reads++ }
			store.mu.Unlock()
			b.ReportAllocs()
			for b.Loop() {
				if mode == "cold" {
					store.mu.Lock()
					store.clearTimeTrackingBucketCacheLocked()
					store.mu.Unlock()
				}
				if _, err := store.GetTimeDashboard(
					"2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", TimeEntryFilters{},
				); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(reads)/float64(max(b.N, 1)), "bucket-reads/op")
		})
	}
}

func BenchmarkSyncLocalWorkloads(b *testing.B) {
	store, target := benchmarkVault(b, 200)
	snapshot := b.TempDir()
	if err := store.ExportRemoteSnapshot(snapshot); err != nil {
		b.Fatal(err)
	}
	b.Run("unchanged", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if err := store.ExportRemoteSnapshot(snapshot); err != nil {
				b.Fatal(err)
			}
		}
		b.ReportMetric(0, "changed-files/op")
		reportVaultDiskMetrics(b, snapshot)
	})
	b.Run("changed_1_mib", func(b *testing.B) {
		content := strings.Repeat("x", 1<<20)
		b.ReportAllocs()
		for index := 0; b.Loop(); index++ {
			if _, err := store.SaveNote(target.ID, target.Title, fmt.Sprintf("%d%s", index, content)); err != nil {
				b.Fatal(err)
			}
			if err := store.ExportRemoteSnapshot(snapshot); err != nil {
				b.Fatal(err)
			}
		}
		b.ReportMetric(1, "changed-files/op")
		reportVaultDiskMetrics(b, snapshot)
	})
}
