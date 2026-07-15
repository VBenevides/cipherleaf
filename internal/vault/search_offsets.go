package vault

func utf16CodeUnits(value string) int {
	units := 0
	for _, character := range value {
		units++
		if character > 0xffff {
			units++
		}
	}
	return units
}

func withUTF16Range(match FindMatch, content string) FindMatch {
	end := match.Offset + match.MatchLength
	if match.Offset < 0 || match.MatchLength < 0 || end < match.Offset || end > len(content) {
		return match
	}
	match.UTF16Offset = utf16CodeUnits(content[:match.Offset])
	match.UTF16MatchLength = utf16CodeUnits(content[match.Offset:end])
	return match
}
