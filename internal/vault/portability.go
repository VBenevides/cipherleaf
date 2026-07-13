package vault

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

var unsafeExportCharacter = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)
var portableAttachmentLink = regexp.MustCompile(`attachments/([a-f0-9]{32})\.webp`)
var portableFileLink = regexp.MustCompile(`attachments/([^\s)]+)`)

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
	if err := s.requireUnlocked(); err != nil {
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
				return PortabilityResult{}, err
			}
			folderPaths[folder.ID] = path
			result.Folders++
			remaining = append(remaining[:index], remaining[index+1:]...)
			progress = true
		}
		if !progress {
			return PortabilityResult{}, errors.New("folder hierarchy cannot be exported")
		}
	}
	usedFiles := make(map[string]struct{})
	for _, summary := range s.manifest.Notes {
		note, err := s.readNoteLocked(summary.ID)
		if err != nil {
			return PortabilityResult{}, err
		}
		directory := folderPaths[summary.FolderID]
		content := derivedMarkdownContent(note.Content)
		attachmentDirectory := filepath.Join(directory, "attachments")
		for _, id := range summary.AttachmentIDs {
			data, err := s.readEnvelopeLocked(s.sharedAttachmentPathLocked(id), "attachment", sharedAttachmentAAD(id))
			name := id + ".webp"
			if err != nil {
				payload, fileErr := s.readEnvelopeLocked(s.sharedAttachmentPathLocked(id), "file-attachment", sharedAttachmentAAD(id))
				if fileErr != nil {
					return PortabilityResult{}, err
				}
				info, fileData, fileErr := decodeFileAttachment(payload)
				if fileErr != nil {
					return PortabilityResult{}, fileErr
				}
				data, name = fileData, portableName(info.Filename, id)
			}
			if err := os.MkdirAll(attachmentDirectory, 0o700); err != nil {
				return PortabilityResult{}, err
			}
			if err := os.WriteFile(filepath.Join(attachmentDirectory, name), data, 0o600); err != nil {
				return PortabilityResult{}, err
			}
			content = strings.ReplaceAll(content, "attachment:"+id, "attachments/"+name)
			result.Attachments++
		}
		path := uniquePortablePath(directory, note.Title, ".md", usedFiles)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			return PortabilityResult{}, err
		}
		result.Notes++
	}
	failed = false
	return result, nil
}

type markdownImportFile struct {
	path       string
	relative   string
	content    string
	folderPath string
}

func (s *Store) ImportMarkdown(source string) (PortabilityResult, error) {
	if err := s.requireUnlocked(); err != nil {
		return PortabilityResult{}, err
	}
	source, err := filepath.Abs(strings.TrimSpace(source))
	if err != nil {
		return PortabilityResult{}, err
	}
	files := make([]markdownImportFile, 0)
	folders := make(map[string]struct{})
	err = filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
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
		return PortabilityResult{}, err
	}
	if len(files) == 0 {
		return PortabilityResult{}, errors.New("selected folder contains no Markdown files")
	}
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
	result := PortabilityResult{Path: source}
	for _, relative := range folderNames {
		parentID := folderIDs[filepath.Dir(relative)]
		folder, err := s.CreateFolder(filepath.Base(relative), parentID)
		if err != nil {
			return result, fmt.Errorf("import folder %s: %w", relative, err)
		}
		folderIDs[relative] = folder.ID
		result.Folders++
	}
	for _, file := range files {
		title := strings.TrimSuffix(filepath.Base(file.relative), filepath.Ext(file.relative))
		note, err := s.CreateNoteInFolder(title, folderIDs[file.folderPath])
		if err != nil {
			return result, err
		}
		content := file.content
		for _, match := range portableAttachmentLink.FindAllStringSubmatch(file.content, -1) {
			data, err := os.ReadFile(filepath.Join(filepath.Dir(file.path), "attachments", match[1]+".webp"))
			if err != nil {
				return result, fmt.Errorf("import attachment %s: %w", match[1], err)
			}
			attachmentID, err := s.SaveAttachment(note.ID, data)
			if err != nil {
				return result, err
			}
			content = strings.ReplaceAll(content, match[0], "attachment:"+attachmentID)
			result.Attachments++
		}
		for _, match := range portableFileLink.FindAllStringSubmatch(content, -1) {
			name := match[1]
			if filepath.Base(name) != name {
				return result, errors.New("imported attachment path is unsafe")
			}
			attachment, err := s.ImportFileAttachment(note.ID, filepath.Join(filepath.Dir(file.path), "attachments", name))
			if err != nil {
				return result, err
			}
			content = strings.ReplaceAll(content, match[0], "attachment:"+attachment.ID)
			result.Attachments++
		}
		if _, err := s.SaveNote(note.ID, note.Title, content); err != nil {
			return result, err
		}
		result.Notes++
	}
	return result, nil
}
