export function syncFinishedMessage(elapsedMilliseconds: number): string {
  return `Cloud sync finished after: ${(elapsedMilliseconds / 1000).toFixed(2)} seconds`;
}
