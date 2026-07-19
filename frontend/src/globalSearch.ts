const advancedSearchToken = /^(?:title|tag|folder|property|case|re):/i;

export function isAdvancedSearchQuery(query: string): boolean {
  return query.trim().split(/\s+/).some((token) => advancedSearchToken.test(token));
}

export function searchResultsKey(query: string, caseSensitive: boolean, wholeWord: boolean): string {
  return JSON.stringify([query.trim(), caseSensitive, wholeWord]);
}

export function canReplaceSearch(
  query: string,
  resultsKey: string,
  busy: boolean,
  caseSensitive: boolean,
  wholeWord: boolean,
): boolean {
  const trimmed = query.trim();
  return Boolean(trimmed) && !busy &&
    searchResultsKey(trimmed, caseSensitive, wholeWord) === resultsKey &&
    !isAdvancedSearchQuery(trimmed);
}
