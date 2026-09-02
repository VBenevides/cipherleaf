package vault

import (
	"errors"
	"fmt"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

var unsafeExportCharacter = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)
var portableAttachmentLink = regexp.MustCompile(`attachments/([a-f0-9]{32})\.webp`)
var portableFileLink = regexp.MustCompile(`attachments/([^\s)]+)`)
var portableImageFilename = regexp.MustCompile(`(?i)^[a-f0-9]{32}\.webp$`)

const attachmentLinkPrefix = "attachment:"

func portableName(value, fallback string) string {
	value = strings.TrimSpace(unsafeExportCharacter.ReplaceAllString(value, "_"))
	value = strings.Trim(value, ". ")
	if value == "" {
		return fallback
	}
	return value
}

func uniquePortablePath(directory, name, extension string, used map[string]struct{}) string {
	base := portableName(name, "Untitled")
	for suffix := 1; ; suffix++ {
		candidate := base
		if suffix > 1 {
			candidate = fmt.Sprintf("%s (%d)", base, suffix)
		}
		path := filepath.Join(directory, candidate+extension)
		key := strings.ToLower(path)
		if _, exists := used[key]; !exists {
			used[key] = struct{}{}
			return path
		}
	}
}

func (s *Store) ExportMarkdown(parent string) (PortabilityResult, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.validateExportAccessLocked(); err != nil {
		return PortabilityResult{}, err
	}
	parent, err := filepath.Abs(strings.TrimSpace(parent))
	if err != nil {
		return PortabilityResult{}, err
	}
	info, err := os.Stat(parent)
	if err != nil || !info.IsDir() {
		return PortabilityResult{}, errors.New("export destination is not a directory")
	}
	destination := filepath.Join(parent, "Cipherleaf Markdown Export")
	for suffix := 2; ; suffix++ {
		if _, err := os.Stat(destination); errors.Is(err, os.ErrNotExist) {
			break
		}
		destination = filepath.Join(parent, fmt.Sprintf("Cipherleaf Markdown Export (%d)", suffix))
	}
	if err := os.Mkdir(destination, 0o700); err != nil {
		return PortabilityResult{}, err
	}
	result := PortabilityResult{Path: destination}
	failed := true
	defer func() {
		if failed {
			_ = os.RemoveAll(destination)
		}
	}()
	folderPaths, err := s.exportMarkdownFoldersLocked(destination, &result)
	if err != nil {
		return PortabilityResult{}, err
	}
	usedFiles := make(map[string]struct{})
	usedAttachments := make(map[string]struct{})
	for _, summary := range s.manifest.Notes {
		attachments, err := s.exportMarkdownNoteLocked(summary, folderPaths[summary.FolderID], usedFiles, usedAttachments)
		if err != nil {
			return PortabilityResult{}, err
		}
		result.Attachments += attachments
		result.Notes++
	}
	failed = false
	return result, nil
}

func (s *Store) validateExportAccessLocked() error {
	if err := s.requireUnlocked(); err != nil {
		return err
	}
	for _, folder := range s.manifest.Folders {
		if err := s.requireFolderAccessibleLocked(folder.ID); err != nil {
			return err
		}
	}
	for _, note := range s.manifest.Notes {
		if err := s.requireNoteAccessibleLocked(note); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) exportMarkdownFoldersLocked(destination string, result *PortabilityResult) (map[string]string, error) {
	folderPaths := map[string]string{"": destination}
	remaining := slices.Clone(s.manifest.Folders)
	usedDirectories := make(map[string]struct{})
	for len(remaining) > 0 {
		progress := false
		for index := 0; index < len(remaining); {
			folder := remaining[index]
			parentPath, ready := folderPaths[folder.ParentID]
			if !ready {
				index++
				continue
			}
			path := uniquePortablePath(parentPath, folder.Name, "", usedDirectories)
			if err := os.MkdirAll(path, 0o700); err != nil {
				return nil, err
			}
			folderPaths[folder.ID] = path
			result.Folders++
			remaining = append(remaining[:index], remaining[index+1:]...)
			progress = true
		}
		if !progress {
			return nil, errors.New("folder hierarchy cannot be exported")
		}
	}
	return folderPaths, nil
}

func (s *Store) exportMarkdownNoteLocked(summary NoteSummary, directory string, usedFiles, usedAttachments map[string]struct{}) (int, error) {
	note, err := s.readNoteLocked(summary.ID)
	if err != nil {
		return 0, err
	}
	content := derivedMarkdownContent(note.Content)
	attachmentDirectory := filepath.Join(directory, "attachments")
	attachments := 0
	for _, id := range summary.AttachmentIDs {
		data, name, err := s.exportMarkdownAttachmentLocked(id, attachmentDirectory, usedAttachments)
		if err != nil {
			return 0, err
		}
		if err := os.MkdirAll(attachmentDirectory, 0o700); err != nil {
			return 0, err
		}
		if err := os.WriteFile(filepath.Join(attachmentDirectory, name), data, 0o600); err != nil {
			return 0, err
		}
		content = strings.ReplaceAll(content, attachmentLinkPrefix+id, "attachments/"+url.PathEscape(name))
		attachments++
	}
	path := uniquePortablePath(directory, note.Title, ".md", usedFiles)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return 0, err
	}
	return attachments, nil
}

func (s *Store) exportMarkdownAttachmentLocked(id, directory string, used map[string]struct{}) ([]byte, string, error) {
	data, err := s.readEnvelopeLocked(s.sharedAttachmentPathLocked(id), "attachment", sharedAttachmentAAD(id))
	name := id + ".webp"
	if err != nil {
		payload, fileErr := s.readEnvelopeLocked(s.sharedAttachmentPathLocked(id), "file-attachment", sharedAttachmentAAD(id))
		if fileErr != nil {
			return nil, "", err
		}
		info, fileData, fileErr := decodeFileAttachment(payload)
		if fileErr != nil {
			return nil, "", fileErr
		}
		data, name = fileData, portableName(info.Filename, id)
		if portableImageFilename.MatchString(name) {
			name = "attachment_" + name
		}
		extension := filepath.Ext(name)
		name = filepath.Base(uniquePortablePath(directory, strings.TrimSuffix(name, extension), extension, used))
	} else {
		used[strings.ToLower(filepath.Join(directory, name))] = struct{}{}
	}
	return data, name, nil
}

type markdownImportFile struct {
	path       string
	relative   string
	content    string
	folderPath string
}

type markdownImportAttachment struct {
	id, objectType string
	payload        []byte
}

type markdownImportNote struct {
	note        Note
	attachments []markdownImportAttachment
}

func (s *Store) ImportMarkdown(source string) (PortabilityResult, error) {
	s.mu.RLock()
	locked := s.requireUnlocked()
	s.mu.RUnlock()
	if locked != nil {
		return PortabilityResult{}, locked
	}
	source, err := filepath.Abs(strings.TrimSpace(source))
	if err != nil {
		return PortabilityResult{}, err
	}
	files, folders, err := collectMarkdownImportFiles(source)
	if err != nil {
		return PortabilityResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireUnlocked(); err != nil {
		return PortabilityResult{}, err
	}

	result := PortabilityResult{Path: source}
	folderIDs, plannedFolders, err := s.planMarkdownImportFoldersLocked(folders, &result)
	if err != nil {
		return result, err
	}
	plannedNotes, err := planMarkdownImportNotes(files, folderIDs, s.manifest.Notes, &result)
	if err != nil {
		return result, err
	}
	if err := s.writeMarkdownImportLocked(plannedFolders, plannedNotes); err != nil {
		return result, err
	}
	return result, nil
}

func collectMarkdownImportFiles(source string) ([]markdownImportFile, map[string]struct{}, error) {
	files := make([]markdownImportFile, 0)
	folders := make(map[string]struct{})
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("Markdown import cannot contain symbolic links")
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if relative != "." && filepath.Base(path) != "attachments" {
				folders[relative] = struct{}{}
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(path), ".md") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if len(data) > maxNoteBytes {
			return fmt.Errorf("%s exceeds the 10 MiB note limit", relative)
		}
		files = append(files, markdownImportFile{path: path, relative: relative, content: string(data), folderPath: filepath.Dir(relative)})
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	if len(files) == 0 {
		return nil, nil, errors.New("selected folder contains no Markdown files")
	}
	return files, folders, nil
}

func (s *Store) planMarkdownImportFoldersLocked(folders map[string]struct{}, result *PortabilityResult) (map[string]string, []Folder, error) {
	folderNames := make([]string, 0, len(folders))
	for folder := range folders {
		folderNames = append(folderNames, folder)
	}
	slices.SortFunc(folderNames, func(left, right string) int {
		leftDepth, rightDepth := strings.Count(left, string(filepath.Separator)), strings.Count(right, string(filepath.Separator))
		if leftDepth != rightDepth {
			return leftDepth - rightDepth
		}
		return strings.Compare(left, right)
	})
	folderIDs := map[string]string{".": ""}
	plannedFolders := make([]Folder, 0, len(folderNames))
	folderKeys := make(map[string]struct{}, len(s.manifest.Folders)+len(folderNames))
	nextFolderOrder := make(map[string]int)
	for _, folder := range s.manifest.Folders {
		folderKeys[folder.ParentID+"\x00"+strings.ToLower(folder.Name)] = struct{}{}
		nextFolderOrder[folder.ParentID] = max(nextFolderOrder[folder.ParentID], folder.Order+1)
	}
	for _, relative := range folderNames {
		parentID := folderIDs[filepath.Dir(relative)]
		name, err := normalizeFolderName(filepath.Base(relative))
		if err != nil {
			return nil, nil, fmt.Errorf("import folder %s: %w", relative, err)
		}
		key := parentID + "\x00" + strings.ToLower(name)
		if _, exists := folderKeys[key]; exists {
			return nil, nil, fmt.Errorf("import folder %s: a folder with this name already exists", relative)
		}
		id, err := randomID(16)
		if err != nil {
			return nil, nil, err
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		folder := Folder{ID: id, Name: name, ParentID: parentID, Order: nextFolderOrder[parentID], SortMode: "manual", CreatedAt: now, UpdatedAt: now}
		nextFolderOrder[parentID]++
		folderKeys[key] = struct{}{}
		folderIDs[relative] = id
		plannedFolders = append(plannedFolders, folder)
		result.Folders++
	}
	return folderIDs, plannedFolders, nil
}

func planMarkdownImportNotes(files []markdownImportFile, folderIDs map[string]string, existing []NoteSummary, result *PortabilityResult) ([]markdownImportNote, error) {
	nextNoteOrder := make(map[string]int)
	for _, note := range existing {
		nextNoteOrder[note.FolderID] = max(nextNoteOrder[note.FolderID], note.Order+1)
	}
	plannedNotes := make([]markdownImportNote, 0, len(files))
	for _, file := range files {
		planned, err := planMarkdownImportNote(file, folderIDs, nextNoteOrder, result)
		if err != nil {
			return nil, err
		}
		plannedNotes = append(plannedNotes, planned)
	}
	return plannedNotes, nil
}

func planMarkdownImportNote(file markdownImportFile, folderIDs map[string]string, nextNoteOrder map[string]int, result *PortabilityResult) (markdownImportNote, error) {
	title, err := normalizeTitle(strings.TrimSuffix(filepath.Base(file.relative), filepath.Ext(file.relative)))
	if err != nil {
		return markdownImportNote{}, err
	}
	noteID, err := randomID(16)
	if err != nil {
		return markdownImportNote{}, err
	}
	content, attachments, err := importMarkdownContent(file, result)
	if err != nil {
		return markdownImportNote{}, err
	}
	storedContent := canonicalizeNoteContent(content)
	if len(storedContent) > maxNoteBytes {
		return markdownImportNote{}, errors.New("note exceeds the 10 MiB limit")
	}
	folderID := folderIDs[file.folderPath]
	now := time.Now().UTC()
	note := Note{
		ID: noteID, Title: title, FolderID: folderID, Order: nextNoteOrder[folderID], Content: storedContent,
		CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano), ModifiedAt: now.Unix(), Revision: 1,
	}
	nextNoteOrder[folderID]++
	result.Notes++
	return markdownImportNote{note: note, attachments: attachments}, nil
}

func importMarkdownContent(file markdownImportFile, result *PortabilityResult) (string, []markdownImportAttachment, error) {
	content := file.content
	attachments := make([]markdownImportAttachment, 0)
	replaced := make(map[string]string)
	for _, match := range portableAttachmentLink.FindAllStringSubmatch(file.content, -1) {
		if replacement, exists := replaced[match[0]]; exists {
			content = strings.ReplaceAll(content, match[0], replacement)
			continue
		}
		attachment, replacement, err := importMarkdownImageAttachment(file, match[1])
		if err != nil {
			return "", nil, err
		}
		replaced[match[0]] = replacement
		content = strings.ReplaceAll(content, match[0], replacement)
		attachments = append(attachments, attachment)
		result.Attachments++
	}
	for _, match := range portableFileLink.FindAllStringSubmatch(content, -1) {
		if replacement, exists := replaced[match[0]]; exists {
			content = strings.ReplaceAll(content, match[0], replacement)
			continue
		}
		attachment, replacement, err := importMarkdownFileAttachment(file, match[1])
		if err != nil {
			return "", nil, err
		}
		replaced[match[0]] = replacement
		content = strings.ReplaceAll(content, match[0], replacement)
		attachments = append(attachments, attachment)
		result.Attachments++
	}
	return content, attachments, nil
}

func importMarkdownImageAttachment(file markdownImportFile, id string) (markdownImportAttachment, string, error) {
	data, err := os.ReadFile(filepath.Join(filepath.Dir(file.path), "attachments", id+".webp"))
	if err != nil {
		return markdownImportAttachment{}, "", fmt.Errorf("import attachment %s: %w", id, err)
	}
	if len(data) == 0 || len(data) > maxAttachmentBytes || len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return markdownImportAttachment{}, "", fmt.Errorf("import attachment %s: image is not valid WebP data", id)
	}
	attachmentID, err := randomID(16)
	if err != nil {
		return markdownImportAttachment{}, "", err
	}
	return markdownImportAttachment{id: attachmentID, objectType: "attachment", payload: data}, attachmentLinkPrefix + attachmentID, nil
}

func importMarkdownFileAttachment(file markdownImportFile, encodedName string) (markdownImportAttachment, string, error) {
	name, err := url.PathUnescape(encodedName)
	if err != nil {
		return markdownImportAttachment{}, "", errors.New("imported attachment path is invalid")
	}
	if name == "" || name == "." || name == ".." || filepath.IsAbs(name) || filepath.Base(name) != name {
		return markdownImportAttachment{}, "", errors.New("imported attachment path is unsafe")
	}
	path := filepath.Join(filepath.Dir(file.path), "attachments", name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return markdownImportAttachment{}, "", errors.New("attachment source is not a regular file")
	}
	if info.Size() <= 0 || info.Size() > maxFileAttachmentBytes {
		return markdownImportAttachment{}, "", errors.New("attachment must be between 1 byte and 64 MiB")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return markdownImportAttachment{}, "", err
	}
	attachmentID, err := randomID(16)
	if err != nil {
		return markdownImportAttachment{}, "", err
	}
	attachment := AttachmentInfo{ID: attachmentID, Filename: name, MIMEType: mime.TypeByExtension(filepath.Ext(name)), Size: int64(len(data))}
	if attachment.MIMEType == "" {
		attachment.MIMEType = "application/octet-stream"
	}
	payload, err := encodeFileAttachment(attachment, data)
	if err != nil {
		return markdownImportAttachment{}, "", err
	}
	return markdownImportAttachment{id: attachmentID, objectType: "file-attachment", payload: payload}, attachmentLinkPrefix + attachmentID, nil
}

func (s *Store) writeMarkdownImportLocked(plannedFolders []Folder, plannedNotes []markdownImportNote) error {
	written := make([]string, 0)
	cleanup := func() {
		for _, path := range written {
			removeFileAndBackup(path)
		}
	}
	if err := os.MkdirAll(filepath.Join(s.root, "attachments", sharedAttachmentFolder), 0o700); err != nil {
		return err
	}
	for _, planned := range plannedNotes {
		for _, attachment := range planned.attachments {
			path := s.sharedAttachmentPathLocked(attachment.id)
			written = append(written, path)
			if err := s.writeEnvelopeLocked(path, attachment.objectType, sharedAttachmentAAD(attachment.id), attachment.payload); err != nil {
				cleanup()
				return err
			}
		}
	}
	summaries := make([]NoteSummary, 0, len(plannedNotes))
	for _, planned := range plannedNotes {
		path := s.notePathLocked(planned.note.ID)
		written = append(written, path)
		hash, err := s.writeNoteLocked(planned.note)
		if err != nil {
			cleanup()
			return err
		}
		summary := summaryFromNote(planned.note)
		summary.CiphertextHash = hash
		summaries = append(summaries, summary)
	}
	originalManifest := cloneManifest(s.manifest)
	s.manifest.Folders = append(s.manifest.Folders, plannedFolders...)
	s.manifest.Notes = append(s.manifest.Notes, summaries...)
	if err := s.saveManifestLocked(); err != nil {
		s.manifest = originalManifest
		s.hasSavedManifestHash = false
		restoreErr := s.saveManifestLocked()
		cleanup()
		return errors.Join(err, restoreErr)
	}
	s.noteIndexes = nil
	s.folderIndexes = nil
	s.sharedAttachmentRefs = nil
	s.pendingSharedAttachments = nil
	for _, planned := range plannedNotes {
		s.updateSearchIndexLocked(planned.note.ID, derivedMarkdownContent(planned.note.Content))
	}
	return nil
}
