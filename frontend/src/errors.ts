export function errorText(error: unknown): string {
  let message = "";
  if (typeof error === "string") message = error;
  else if (error instanceof Error) message = error.message;
  try {
    const parsed = JSON.parse(message) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Wails errors are not always JSON.
  }
  const normalized = message.toLocaleLowerCase();

  if (normalized.includes("no encrypted vault exists")) {
    return "We couldn’t find an encrypted vault in that folder. Choose the folder that contains vault.json, or create a new vault there.";
  }
  if (normalized.includes("a vault already exists")) {
    return "That location already contains an encrypted vault. Open it instead, or choose a different folder.";
  }
  if (normalized.includes("folder with that vault name already exists")) {
    return "A folder with that vault name already exists in the selected location. Choose another name or location.";
  }
  if (
    normalized.includes("encrypted note file is missing") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("file not found")
  ) {
    return "A required encrypted file could not be found. It may have been moved or deleted outside Cipherleaf.";
  }
  if (normalized.includes("vault is locked")) {
    return "This vault is locked. Unlock it before working with notes.";
  }
  return message || "Something went wrong. Please try again.";
}
