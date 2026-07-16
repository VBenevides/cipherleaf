package vault

import (
	"errors"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

type trackingLabelAction uint8

const (
	trackingLabelCreate trackingLabelAction = iota
	trackingLabelRename
	trackingLabelArchive
	trackingLabelRestore
)

func (s *Store) GetTimeTrackingCatalog() (TimeTrackingCatalog, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return TimeTrackingCatalog{}, err
	}
	if s.timeTrackingCatalog == nil {
		return TimeTrackingCatalog{Projects: []TimeProject{}, Tags: []TimeTag{}}, nil
	}
	return TimeTrackingCatalog{
		Projects: slices.Clone(s.timeTrackingCatalog.Projects),
		Tags:     slices.Clone(s.timeTrackingCatalog.Tags),
	}, nil
}

func (s *Store) ListTimeTrackingConflicts() ([]TimeTrackingConflict, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.requireUnlocked(); err != nil {
		return nil, err
	}
	if s.timeTrackingCatalog == nil {
		return []TimeTrackingConflict{}, nil
	}
	return slices.Clone(s.timeTrackingCatalog.Conflicts), nil
}

func (s *Store) ResolveTimeTrackingConflict(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	if s.timeTrackingCatalog == nil {
		return errors.New("time-tracking conflict not found")
	}
	catalog := cloneTimeTrackingCatalog(*s.timeTrackingCatalog)
	index := slices.IndexFunc(catalog.Conflicts, func(conflict TimeTrackingConflict) bool { return conflict.ID == id })
	if index < 0 {
		return errors.New("time-tracking conflict not found")
	}
	catalog.Conflicts = append(catalog.Conflicts[:index], catalog.Conflicts[index+1:]...)
	advanceTrackingCatalogRevision(&catalog, time.Now().UTC())
	if err := s.writeTimeTrackingCatalogLocked(catalog); err != nil {
		return err
	}
	s.timeTrackingCatalog = &catalog
	return nil
}

func (s *Store) CreateProject(name string) (TimeProject, error) {
	return s.changeProject("", name, trackingLabelCreate)
}

func (s *Store) RenameProject(id, name string) (TimeProject, error) {
	return s.changeProject(id, name, trackingLabelRename)
}

func (s *Store) ArchiveProject(id string) (TimeProject, error) {
	return s.changeProject(id, "", trackingLabelArchive)
}

func (s *Store) RestoreProject(id string) (TimeProject, error) {
	return s.changeProject(id, "", trackingLabelRestore)
}

func (s *Store) changeProject(id, name string, action trackingLabelAction) (TimeProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return TimeProject{}, err
	}
	if err := s.ensureTimeTrackingEnabledLocked(); err != nil {
		return TimeProject{}, err
	}
	catalog := *s.timeTrackingCatalog
	catalog.Projects = slices.Clone(catalog.Projects)
	index := slices.IndexFunc(catalog.Projects, func(project TimeProject) bool { return project.ID == id })
	now := time.Now().UTC()
	if action == trackingLabelCreate {
		var err error
		name, err = normalizeTrackingLabelName(name)
		if err != nil {
			return TimeProject{}, err
		}
		if activeProjectNameExists(catalog.Projects, name, "") {
			return TimeProject{}, errors.New("an active project with that name already exists")
		}
		id, err = randomID(16)
		if err != nil {
			return TimeProject{}, err
		}
		stamp := now.Format(time.RFC3339Nano)
		catalog.Projects = append(catalog.Projects, TimeProject{ID: id, Name: name, CreatedAtUTC: stamp, UpdatedAtUTC: stamp, ModifiedAt: now.UnixMilli(), Revision: 1})
		index = len(catalog.Projects) - 1
	} else if index < 0 {
		return TimeProject{}, errors.New("project not found")
	} else if err := updateProject(&catalog.Projects[index], catalog.Projects, name, action, now); err != nil {
		return TimeProject{}, err
	}
	advanceTrackingCatalogRevision(&catalog, now)
	if err := s.writeTimeTrackingCatalogLocked(catalog); err != nil {
		return TimeProject{}, err
	}
	s.timeTrackingCatalog = &catalog
	return catalog.Projects[index], nil
}

func (s *Store) CreateTag(name string) (TimeTag, error) {
	return s.changeTag("", name, trackingLabelCreate)
}

func (s *Store) RenameTag(id, name string) (TimeTag, error) {
	return s.changeTag(id, name, trackingLabelRename)
}

func (s *Store) ArchiveTag(id string) (TimeTag, error) {
	return s.changeTag(id, "", trackingLabelArchive)
}

func (s *Store) RestoreTag(id string) (TimeTag, error) {
	return s.changeTag(id, "", trackingLabelRestore)
}

func (s *Store) changeTag(id, name string, action trackingLabelAction) (TimeTag, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return TimeTag{}, err
	}
	if err := s.ensureTimeTrackingEnabledLocked(); err != nil {
		return TimeTag{}, err
	}
	catalog := *s.timeTrackingCatalog
	catalog.Tags = slices.Clone(catalog.Tags)
	index := slices.IndexFunc(catalog.Tags, func(tag TimeTag) bool { return tag.ID == id })
	now := time.Now().UTC()
	if action == trackingLabelCreate {
		var err error
		name, err = normalizeTrackingLabelName(name)
		if err != nil {
			return TimeTag{}, err
		}
		if activeTagNameExists(catalog.Tags, name, "") {
			return TimeTag{}, errors.New("an active tag with that name already exists")
		}
		id, err = randomID(16)
		if err != nil {
			return TimeTag{}, err
		}
		stamp := now.Format(time.RFC3339Nano)
		catalog.Tags = append(catalog.Tags, TimeTag{ID: id, Name: name, CreatedAtUTC: stamp, UpdatedAtUTC: stamp, ModifiedAt: now.UnixMilli(), Revision: 1})
		index = len(catalog.Tags) - 1
	} else if index < 0 {
		return TimeTag{}, errors.New("tag not found")
	} else if err := updateTag(&catalog.Tags[index], catalog.Tags, name, action, now); err != nil {
		return TimeTag{}, err
	}
	advanceTrackingCatalogRevision(&catalog, now)
	if err := s.writeTimeTrackingCatalogLocked(catalog); err != nil {
		return TimeTag{}, err
	}
	s.timeTrackingCatalog = &catalog
	return catalog.Tags[index], nil
}

func updateProject(project *TimeProject, projects []TimeProject, name string, action trackingLabelAction, now time.Time) error {
	switch action {
	case trackingLabelRename:
		var err error
		name, err = normalizeTrackingLabelName(name)
		if err != nil {
			return err
		}
		if project.ArchivedAtUTC == "" && activeProjectNameExists(projects, name, project.ID) {
			return errors.New("an active project with that name already exists")
		}
		project.Name = name
	case trackingLabelArchive:
		if project.ArchivedAtUTC != "" {
			return errors.New("project is already archived")
		}
		project.ArchivedAtUTC = now.Format(time.RFC3339Nano)
	case trackingLabelRestore:
		if project.ArchivedAtUTC == "" {
			return errors.New("project is not archived")
		}
		if activeProjectNameExists(projects, project.Name, project.ID) {
			return errors.New("an active project with that name already exists")
		}
		project.ArchivedAtUTC = ""
	default:
		return errors.New("invalid project change")
	}
	project.UpdatedAtUTC = now.Format(time.RFC3339Nano)
	project.ModifiedAt = now.UnixMilli()
	project.Revision++
	return nil
}

func updateTag(tag *TimeTag, tags []TimeTag, name string, action trackingLabelAction, now time.Time) error {
	switch action {
	case trackingLabelRename:
		var err error
		name, err = normalizeTrackingLabelName(name)
		if err != nil {
			return err
		}
		if tag.ArchivedAtUTC == "" && activeTagNameExists(tags, name, tag.ID) {
			return errors.New("an active tag with that name already exists")
		}
		tag.Name = name
	case trackingLabelArchive:
		if tag.ArchivedAtUTC != "" {
			return errors.New("tag is already archived")
		}
		tag.ArchivedAtUTC = now.Format(time.RFC3339Nano)
	case trackingLabelRestore:
		if tag.ArchivedAtUTC == "" {
			return errors.New("tag is not archived")
		}
		if activeTagNameExists(tags, tag.Name, tag.ID) {
			return errors.New("an active tag with that name already exists")
		}
		tag.ArchivedAtUTC = ""
	default:
		return errors.New("invalid tag change")
	}
	tag.UpdatedAtUTC = now.Format(time.RFC3339Nano)
	tag.ModifiedAt = now.UnixMilli()
	tag.Revision++
	return nil
}

func (s *Store) ensureTimeTrackingEnabledLocked() error {
	if s.timeTrackingCatalog != nil {
		return nil
	}
	previousManifest := s.manifest
	if err := enableTimeTrackingCapability(&s.manifest); err != nil {
		return err
	}
	catalog := newTimeTrackingCatalog(s.vaultID)
	if err := s.writeTimeTrackingCatalogLocked(catalog); err != nil {
		s.manifest = previousManifest
		return err
	}
	s.timeTrackingCatalog = &catalog
	if err := s.saveManifestLocked(); err != nil {
		s.timeTrackingCatalog = nil
		s.manifest = previousManifest
		return err
	}
	return nil
}

func normalizeTrackingLabelName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("name is required")
	}
	if utf8.RuneCountInString(name) > 120 || strings.ContainsAny(name, "\r\n") {
		return "", errors.New("name is invalid or too long")
	}
	return name, nil
}

func activeProjectNameExists(projects []TimeProject, name, exceptID string) bool {
	return slices.ContainsFunc(projects, func(project TimeProject) bool {
		return project.ID != exceptID && project.ArchivedAtUTC == "" && strings.EqualFold(project.Name, name)
	})
}

func activeTagNameExists(tags []TimeTag, name, exceptID string) bool {
	return slices.ContainsFunc(tags, func(tag TimeTag) bool {
		return tag.ID != exceptID && tag.ArchivedAtUTC == "" && strings.EqualFold(tag.Name, name)
	})
}

func advanceTrackingCatalogRevision(catalog *timeTrackingCatalog, now time.Time) {
	catalog.Revision++
	catalog.ModifiedAt = now.UnixMilli()
	catalog.CiphertextHash = ""
}
