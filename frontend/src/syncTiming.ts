import type { GitDiagnostics, SyncTimings } from "../bindings/cipherleaf/internal/app/models";

function formatDuration(milliseconds: number): string {
  return `${milliseconds.toFixed(2)} ms (${(milliseconds / 1000).toFixed(3)} s)`;
}

export function syncFinishedMessage(elapsedMilliseconds: number): string {
  return `Cloud sync finished after: ${(elapsedMilliseconds / 1000).toFixed(2)} seconds`;
}

export function syncTimingMessages(
  timings: SyncTimings,
  wallMilliseconds: number,
  git?: GitDiagnostics,
): string[] {
  const messages = [
    `Sync pull: ${formatDuration(timings.pullMilliseconds)}`,
    `Sync merge: ${formatDuration(timings.mergeMilliseconds)}`,
    `Sync push: ${formatDuration(timings.pushMilliseconds)}`,
    `Sync transport total: ${formatDuration(timings.transportMilliseconds)}`,
    `Sync local total: ${formatDuration(timings.localMilliseconds)}`,
    `Sync backend total: ${formatDuration(timings.totalMilliseconds)}`,
  ];
  if (git) {
    const reuse = git.sshConnectionReuse
      ? `enabled (connections persist ${git.sshConnectionPersistSeconds} s)`
      : "disabled";
    messages.push(
      `Platform: ${git.platform}/${git.architecture}`,
      `Git version: ${git.gitVersion}`,
      `OpenSSH version: ${git.openSshVersion}`,
      `Git SSH connection reuse: ${reuse}`,
      `Git prefetch used: ${git.usedPrefetch ? "yes" : "no"}`,
      `Git transport operations: ${git.transportOperations} (physical connection count is not exposed by OpenSSH)`,
      `Git repository location: ${git.repositoryPath}`,
      `Git metadata (.git): ${formatBytes(git.gitBytes)}`,
      `Git repository files: ${formatBytes(git.repositoryFilesBytes)}`,
    );
  }
  messages.push(`Sync elapsed (wall): ${formatDuration(wallMilliseconds)}`);
  return messages;
}

function formatBytes(bytes: number): string {
  return `${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MiB)`;
}
