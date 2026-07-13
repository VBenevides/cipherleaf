package vault

import (
	"strconv"
	"strings"
)

func extractProperties(content string) map[string]any {
	content = strings.TrimPrefix(content, "\ufeff")
	lines := strings.Split(content, "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
		return nil
	}
	properties := make(map[string]any)
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			break
		}
		key, value, found := strings.Cut(line, ":")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !found || key == "" {
			continue
		}
		properties[key] = typedPropertyValue(value)
	}
	if len(properties) == 0 {
		return nil
	}
	return properties
}

func typedPropertyValue(value string) any {
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		items := strings.Split(strings.TrimSpace(value[1:len(value)-1]), ",")
		result := make([]string, 0, len(items))
		for _, item := range items {
			if item = strings.Trim(strings.TrimSpace(item), "\"'"); item != "" {
				result = append(result, item)
			}
		}
		return result
	}
	if boolean, err := strconv.ParseBool(value); err == nil {
		return boolean
	}
	if number, err := strconv.ParseFloat(value, 64); err == nil {
		return number
	}
	return strings.Trim(value, "\"'")
}

func cloneProperties(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	clone := make(map[string]any, len(value))
	for key, item := range value {
		clone[key] = item
	}
	return clone
}
