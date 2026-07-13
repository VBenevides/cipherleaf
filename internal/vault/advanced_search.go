package vault

import (
	"fmt"
	"regexp"
	"strings"
)

type advancedQuery struct {
	text, title, tag, folder, property, propertyValue string
	caseSensitive                                     bool
	pattern                                           *regexp.Regexp
}

func parseAdvancedQuery(value string) (advancedQuery, bool, error) {
	var query advancedQuery
	advanced := false
	terms := make([]string, 0)
	for _, token := range strings.Fields(value) {
		key, item, found := strings.Cut(token, ":")
		if !found {
			terms = append(terms, token)
			continue
		}
		switch strings.ToLower(key) {
		case "title":
			query.title, advanced = item, true
		case "tag":
			query.tag, advanced = strings.TrimPrefix(item, "#"), true
		case "folder":
			query.folder, advanced = item, true
		case "property":
			query.property, query.propertyValue, _ = strings.Cut(item, "=")
			advanced = true
		case "case":
			query.caseSensitive, advanced = strings.EqualFold(item, "true"), true
		case "re":
			pattern := item
			if !query.caseSensitive {
				pattern = "(?i)" + pattern
			}
			compiled, err := regexp.Compile(pattern)
			if err != nil {
				return query, true, fmt.Errorf("invalid search expression: %w", err)
			}
			query.pattern, advanced = compiled, true
		default:
			terms = append(terms, token)
		}
	}
	query.text = strings.Join(terms, " ")
	return query, advanced, nil
}

func containsSearch(value, query string, caseSensitive bool) bool {
	if !caseSensitive {
		value, query = strings.ToLower(value), strings.ToLower(query)
	}
	return strings.Contains(value, query)
}

func propertyText(value any) string { return strings.TrimSpace(fmt.Sprint(value)) }

func (s *Store) findAdvancedLocked(raw string, maxPerNote int) ([]FindMatch, error) {
	query, _, err := parseAdvancedQuery(raw)
	if err != nil {
		return nil, err
	}
	result := make([]FindMatch, 0)
	for _, item := range s.manifest.Notes {
		if s.requireNoteAccessibleLocked(item) != nil {
			continue
		}
		if query.title != "" && !containsSearch(item.Title, query.title, query.caseSensitive) {
			continue
		}
		if query.tag != "" {
			found := false
			for _, tag := range item.Tags {
				if strings.EqualFold(tag, query.tag) {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		if query.folder != "" {
			folder, found := s.folderByIDLocked(item.FolderID)
			if !found || !containsSearch(folder.Name, query.folder, query.caseSensitive) {
				continue
			}
		}
		if query.property != "" {
			value, found := item.Properties[query.property]
			if !found || (query.propertyValue != "" && !containsSearch(propertyText(value), query.propertyValue, query.caseSensitive)) {
				continue
			}
		}
		content := s.searchIndex[item.ID]
		if content == "" {
			note, err := s.readNoteLocked(item.ID)
			if err != nil {
				return nil, err
			}
			content = derivedMarkdownContent(note.Content)
		}
		offset, length := 0, 0
		switch {
		case query.pattern != nil:
			match := query.pattern.FindStringIndex(content)
			if match == nil {
				continue
			}
			offset, length = match[0], match[1]-match[0]
		case query.text != "":
			haystack, needle := content, query.text
			if !query.caseSensitive {
				haystack, needle = strings.ToLower(haystack), strings.ToLower(needle)
			}
			offset = strings.Index(haystack, needle)
			if offset < 0 {
				continue
			}
			length = len(needle)
		default:
			length = len(item.Title)
		}
		result = append(result, FindMatch{NoteID: item.ID, Title: item.Title, FolderID: item.FolderID, Field: "content", Snippet: makeSnippet(content, offset, length), Offset: offset, MatchLength: length})
		if len(result) >= maxPerNote*len(s.manifest.Notes) {
			break
		}
	}
	return result, nil
}
