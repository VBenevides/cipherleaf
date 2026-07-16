package vault

import (
	"errors"
	"fmt"
	"slices"
)

// TimeEntry is one logical tracking record. Empty EndedAtUTC means the entry
// is currently running.
type TimeEntry struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	ProjectID    string   `json:"projectId,omitempty"`
	TagIDs       []string `json:"tagIds"`
	StartedAtUTC string   `json:"startedAtUtc"`
	EndedAtUTC   string   `json:"endedAtUtc,omitempty"`
	CreatedAtUTC string   `json:"createdAtUtc"`
	UpdatedAtUTC string   `json:"updatedAtUtc"`
	ModifiedAt   int64    `json:"modifiedAt"`
	Revision     uint64   `json:"revision"`
}

type TimeProject struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ArchivedAtUTC string `json:"archivedAtUtc,omitempty"`
	CreatedAtUTC  string `json:"createdAtUtc"`
	UpdatedAtUTC  string `json:"updatedAtUtc"`
	ModifiedAt    int64  `json:"modifiedAt"`
	Revision      uint64 `json:"revision"`
}

type TimeTag struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ArchivedAtUTC string `json:"archivedAtUtc,omitempty"`
	CreatedAtUTC  string `json:"createdAtUtc"`
	UpdatedAtUTC  string `json:"updatedAtUtc"`
	ModifiedAt    int64  `json:"modifiedAt"`
	Revision      uint64 `json:"revision"`
}

type TimeEntryFilters struct {
	ProjectIDs []string `json:"projectIds"`
	TagIDs     []string `json:"tagIds"`
}

type TimeEntryRange struct {
	StartUTC string `json:"startUtc"`
	EndUTC   string `json:"endUtc"`
}

type TimeDashboard struct {
	ProjectCount      int                 `json:"projectCount"`
	TagCount          int                 `json:"tagCount"`
	TotalSeconds      int64               `json:"totalSeconds"`
	AverageDaySeconds int64               `json:"averageDaySeconds"`
	Projects          []TimeDurationGroup `json:"projects"`
	Tags              []TimeDurationGroup `json:"tags"`
	Tasks             []TimeTaskGroup     `json:"tasks"`
	Days              []TimeDashboardDay  `json:"days"`
}

type TimeDurationGroup struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	TotalSeconds int64  `json:"totalSeconds"`
}

type TimeTaskGroup struct {
	Name         string `json:"name"`
	TotalSeconds int64  `json:"totalSeconds"`
	EntryCount   int    `json:"entryCount"`
}

type TimeDashboardDay struct {
	LocalDate    string `json:"localDate"`
	TotalSeconds int64  `json:"totalSeconds"`
}

type TimeTrackingConflictKind string

const (
	TimeEntryEditConflict     TimeTrackingConflictKind = "entry-edit"
	TimeProjectRenameConflict TimeTrackingConflictKind = "project-rename"
	TimeTagRenameConflict     TimeTrackingConflictKind = "tag-rename"
	TimeEntryOverlapConflict  TimeTrackingConflictKind = "entry-overlap"
	TimeActiveEntriesConflict TimeTrackingConflictKind = "active-entries"
)

type TimeTrackingConflict struct {
	ID            string                   `json:"id"`
	Kind          TimeTrackingConflictKind `json:"kind"`
	ObjectID      string                   `json:"objectId"`
	Message       string                   `json:"message"`
	LocalEntry    *TimeEntry               `json:"localEntry,omitempty"`
	RemoteEntry   *TimeEntry               `json:"remoteEntry,omitempty"`
	LocalProject  *TimeProject             `json:"localProject,omitempty"`
	RemoteProject *TimeProject             `json:"remoteProject,omitempty"`
	LocalTag      *TimeTag                 `json:"localTag,omitempty"`
	RemoteTag     *TimeTag                 `json:"remoteTag,omitempty"`
}

type timeTrackingCatalog struct {
	FormatVersion   int                         `json:"format_version"`
	VaultID         string                      `json:"vault_id"`
	Projects        []TimeProject               `json:"projects"`
	Tags            []TimeTag                   `json:"tags"`
	Buckets         []timeTrackingBucketSummary `json:"buckets"`
	ActiveEntry     *timeTrackingEntryLocation  `json:"active_entry,omitempty"`
	DeletedEntries  []Tombstone                 `json:"deleted_entries"`
	DeletedProjects []Tombstone                 `json:"deleted_projects"`
	DeletedTags     []Tombstone                 `json:"deleted_tags"`
	ModifiedAt      int64                       `json:"modified_at"`
	Revision        uint64                      `json:"revision"`
	CiphertextHash  string                      `json:"ciphertext_hash,omitempty"`
}

type timeTrackingBucketSummary struct {
	ID             string `json:"id"`
	MonthUTC       string `json:"month_utc"`
	MinStartedAt   string `json:"min_started_at,omitempty"`
	MaxEndedAt     string `json:"max_ended_at,omitempty"`
	HasActiveEntry bool   `json:"has_active_entry,omitempty"`
	ModifiedAt     int64  `json:"modified_at"`
	Revision       uint64 `json:"revision"`
	CiphertextHash string `json:"ciphertext_hash,omitempty"`
}

type timeTrackingEntryLocation struct {
	EntryID  string `json:"entry_id"`
	BucketID string `json:"bucket_id"`
}

type timeTrackingBucket struct {
	FormatVersion int         `json:"format_version"`
	ID            string      `json:"id"`
	Entries       []TimeEntry `json:"entries"`
}

func newTimeTrackingCatalog(vaultID string) timeTrackingCatalog {
	return timeTrackingCatalog{
		FormatVersion:   TimeTrackingCatalogFormatVersion,
		VaultID:         vaultID,
		Projects:        []TimeProject{},
		Tags:            []TimeTag{},
		Buckets:         []timeTrackingBucketSummary{},
		DeletedEntries:  []Tombstone{},
		DeletedProjects: []Tombstone{},
		DeletedTags:     []Tombstone{},
	}
}

func hasTimeTrackingCapability(value manifest) bool {
	return value.FormatVersion == TimeTrackingManifestFormatVersion &&
		slices.Contains(value.Capabilities, TimeTrackingCapability)
}

func enableTimeTrackingCapability(value *manifest) error {
	if err := validateManifestCapabilities(value.FormatVersion, value.Capabilities); err != nil {
		return err
	}
	if hasTimeTrackingCapability(*value) {
		return nil
	}
	value.FormatVersion = TimeTrackingManifestFormatVersion
	value.Capabilities = []string{TimeTrackingCapability}
	return nil
}

func validateManifestCapabilities(formatVersion int, capabilities []string) error {
	switch formatVersion {
	case FormatVersion:
		if len(capabilities) != 0 {
			return errors.New("legacy manifest unexpectedly declares capabilities")
		}
		return nil
	case TimeTrackingManifestFormatVersion:
		if len(capabilities) != 1 || capabilities[0] != TimeTrackingCapability {
			return errors.New("manifest contains unsupported capabilities")
		}
		return nil
	default:
		return fmt.Errorf("unsupported manifest format version %d", formatVersion)
	}
}
