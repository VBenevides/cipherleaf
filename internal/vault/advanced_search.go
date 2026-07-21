package vault

import (
	"fmt"
	"regexp"
	"strings"
)

type advancedQuery struct {
	text, title, tag, folder, property, propertyValue string
	caseSensitive                                     bool
	patternSource                                     string
	pattern                                           *regexp.Regexp
}

func compileAdvancedPattern(source string, caseSensitive bool) (*regexp.Regexp, error) {
	if !caseSensitive {
		source = "(?i)" + source
	}
	compiled, err := regexp.Compile(source)
	if err != nil {
		return nil, fmt.Errorf("invalid search expression: %w", err)
	}
	return compiled, nil
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
			query.patternSource, advanced = item, true
		default:
			terms = append(terms, token)
		}
	}
	query.text = strings.Join(terms, " ")
	if query.patternSource != "" {
		var err error
		query.pattern, err = compileAdvancedPattern(query.patternSource, query.caseSensitive)
		if err != nil {
			return query, true, err
		}
	}
	return query, advanced, nil
}

func containsSearch(value string, pattern *regexp.Regexp, wholeWord bool) bool {
	return len(literalMatches(value, pattern, wholeWord, 1)) > 0
}

func propertyText(value any) string { return strings.TrimSpace(fmt.Sprint(value)) }

func (s *Store) findAdvancedLocked(raw string, maxPerNote int, options SearchOptions) ([]FindMatch, error) {
	query, _, err := parseAdvancedQuery(raw)
	if err != nil {
		return nil, err
	}
	options.CaseSensitive = options.CaseSensitive || query.caseSensitive
	if query.patternSource != "" && options.CaseSensitive != query.caseSensitive {
		query.pattern, err = compileAdvancedPattern(query.patternSource, options.CaseSensitive)
		if err != nil {
			return nil, err
		}
	}
	patterns := make(map[string]*regexp.Regexp)
	for _, value := range []string{query.title, query.folder, query.propertyValue, query.text} {
		if value == "" {
			continue
		}
		patterns[value], err = compileLiteralPattern(value, options)
		if err != nil {
			return nil, err
		}
	}
	result := make([]FindMatch, 0)
	for _, item := range s.manifest.Notes {
		if s.requireNoteAccessibleLocked(item) != nil {
			continue
		}
		if query.title != "" && !containsSearch(item.Title, patterns[query.title], options.WholeWord) {
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
			if !found || !containsSearch(folder.Name, patterns[query.folder], options.WholeWord) {
				continue
			}
		}
		if query.property != "" {
			value, found := item.Properties[query.property]
			if !found || (query.propertyValue != "" && !containsSearch(propertyText(value), patterns[query.propertyValue], options.WholeWord)) {
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
			matches := literalMatches(content, patterns[query.text], options.WholeWord, 1)
			if len(matches) == 0 {
				continue
			}
			match := matches[0]
			offset, length = match[0], match[1]-match[0]
		default:
			length = len(item.Title)
		}
		result = append(result, withUTF16Range(FindMatch{NoteID: item.ID, Title: item.Title, FolderID: item.FolderID, Field: "content", Snippet: makeSnippet(content, offset, length), Offset: offset, MatchLength: length}, content))
		if len(result) >= maxPerNote*len(s.manifest.Notes) {
			break
		}
	}
	return result, nil
}
