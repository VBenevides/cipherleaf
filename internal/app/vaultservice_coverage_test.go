package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"cipherleaf/internal/githubsync"
	appsession "cipherleaf/internal/session"
	"cipherleaf/internal/vault"
	"github.com/zalando/go-keyring"
)

func TestVaultServiceLockedPaths(t *testing.T) {
	service := NewVaultService()
	service.SetApp(nil)

	if !service.GetSession().Locked {
		t.Fatal("new service should start locked")
	}
	service.QuitApplication()
	_, _ = service.GetApplicationStatistics()
	_, _ = service.ListInstalledFonts()
	_, _ = service.SelectVaultFolder()
	_, _ = service.SelectVaultDestinationFolder()
	_, _ = service.SelectMarkdownFolder("select")
	_, _ = service.SelectGitHubSSHKey()
	_, _ = service.SelectAttachmentFile()
	_, _ = service.GenerateVaultSecret()
	_ = service.CopyVaultSecret("invalid")
	_, _ = service.OpenVault("/missing", "invalid")
	_, _ = service.GetLastVaultPath()
	_, _ = service.ListRecentVaultPaths()
	_ = service.RemoveRecentVaultPath("")
	_, _ = service.GetLastSession()
	_ = service.RememberTheme("dark")
	_ = service.RememberVaultSecret("secret")
	_ = service.ForgetVaultSecret()
	_, _ = service.TryUnlockRemembered()
	_, _ = service.CloseVault()
	_, _ = service.GetVaultStatistics()
	_, _ = service.GetTimeTrackingCatalog()
	_, _ = service.CreateClient("client")
	_, _ = service.RenameClient("client", "renamed")
	_, _ = service.ArchiveClient("client")
	_, _ = service.RestoreClient("client")
	_ = service.DeleteClient("client")
	_, _ = service.CreateProject("project")
	_, _ = service.CreateProjectForClient("project", "client")
	_, _ = service.RenameProject("project", "renamed")
	_, _ = service.UpdateProject("project", "renamed", "client")
	_, _ = service.ArchiveProject("project")
	_, _ = service.RestoreProject("project")
	_ = service.DeleteProject("project")
	_, _ = service.CreateTag("tag")
	_, _ = service.RenameTag("tag", "renamed")
	_, _ = service.ArchiveTag("tag")
	_, _ = service.RestoreTag("tag")
	_ = service.DeleteTag("tag")
	_, _ = service.StartTimeEntry("task", "project", nil)
	_, _ = service.StartTimeEntryForClient("task", "client", "project", nil)
	_, _ = service.GetActiveTimeEntry()
	_, _ = service.FinishActiveTimeEntry()
	_, _ = service.UpdateTimeEntry("entry", "task", "project", nil, "", "")
	_, _ = service.UpdateTimeEntryForClient("entry", "task", "client", "project", nil, "", "")
	_ = service.DeleteTimeEntry("entry")
	_, _ = service.ListTimeEntries("", "", vault.TimeEntryFilters{})
	_, _ = service.GetTimeDashboard("", "", vault.TimeEntryFilters{})
	_, _ = service.ListTimeDashboardGroupEntries("", "", "", vault.TimeEntryFilters{})
	_, _ = service.ListTimeTrackingConflicts()
	_ = service.ResolveTimeTrackingConflict("conflict")
	_, _ = service.ListNotes()
	_, _ = service.ListFolders()
	_, _ = service.CreateFolder("folder", "")
	_, _ = service.RenameFolder("folder", "renamed")
	_ = service.DeleteFolder("folder")
	_ = service.ReorderFolders(nil)
	_, _ = service.MoveFolder("folder", "")
	_, _ = service.SetFolderHidden("folder", true)
	_, _ = service.LockFolder("folder", "password")
	_, _ = service.UnlockFolder("folder", "password")
	_ = service.CheckFolderPassword("folder", "password")
	_ = service.LockFolderSession("folder")
	_, _ = service.SetFolderSortMode("folder", "title")
	_, _ = service.CreateNote("note")
	_, _ = service.CreateNoteInFolder("note", "folder")
	_, _ = service.MoveNote("note", "folder")
	_ = service.ReorderNotes("folder", nil)
	_, _ = service.GetNote("note")
	_, _ = service.SaveNote("note", "title", "content")
	_, _ = service.SaveImageAttachment("note", "invalid")
	_, _ = service.GetAttachment("note", "attachment")
	_, _ = service.ImportFileAttachment("note", "/missing")
	_, _ = service.ExportFileAttachment("note", "attachment", t.TempDir())
	_, _ = service.ListFileAttachments("note")
	_, _ = service.ReadClipboardImage()
	_ = service.DeleteNote("note")
	_, _ = service.ListTrash()
	_ = service.RestoreTrashItem("note", "note")
	_ = service.PermanentlyDeleteTrashItem("note", "note")
	_, _ = service.ListNoteVersions("note")
	_ = service.CleanHistory()
	_, _ = service.RestoreNoteVersion("note", 1)
	_, _ = service.ImportMarkdown("/missing")
	_, _ = service.ExportMarkdown("/missing")
	_, _ = service.ResolveNoteReference("note")
	_, _ = service.ListBacklinks("note")
	_, _ = service.FindInNotes("query", false, false)
	_, _ = service.ReplaceAcrossNotes("find", "replace", nil, false, false)
	_, _ = service.GetVaultSettings()
	_, _ = service.SaveVaultSettings(vault.VaultSettings{})
	_, _ = service.GetSyncSettings()
	_, _ = service.TestGitHubConnection(githubsync.SyncSettings{})
	_, _ = service.LinkGitHubVault(githubsync.SyncSettings{})
	_, _ = service.PullAndLinkGitHubVault(githubsync.SyncSettings{})
	_ = service.UnlinkGitHubSync()
	_ = service.OpenGitTerminal()
	_, _ = service.SyncNow()
	_, _ = service.ForcePushNow()
}

func TestVaultServiceUnlockedDelegates(t *testing.T) {
	service := NewVaultService()
	keyring.MockInit()
	service.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	if _, err := service.CreateVault(t.TempDir(), "unlocked", "coverage-secret"); err != nil {
		t.Fatal(err)
	}
	if err := service.RememberVaultSecret("coverage-secret"); err != nil {
		t.Fatal(err)
	}
	service.LockVault()
	if _, err := service.TryUnlockRemembered(); err != nil {
		t.Fatal(err)
	}
	if err := service.ForgetVaultSecret(); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	client, err := service.CreateClient("Client")
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.RenameClient(client.ID, "Renamed client")
	must(err)
	_, err = service.ArchiveClient(client.ID)
	must(err)
	_, err = service.RestoreClient(client.ID)
	must(err)
	project, err := service.CreateProjectForClient("Project", client.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.RenameProject(project.ID, "Renamed project")
	must(err)
	_, err = service.UpdateProject(project.ID, "Updated project", client.ID)
	must(err)
	_, err = service.ArchiveProject(project.ID)
	must(err)
	_, err = service.RestoreProject(project.ID)
	must(err)
	tag, err := service.CreateTag("Tag")
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.RenameTag(tag.ID, "Renamed tag")
	must(err)
	_, err = service.ArchiveTag(tag.ID)
	must(err)
	_, err = service.RestoreTag(tag.ID)
	must(err)
	entry, err := service.StartTimeEntryForClient("Entry", client.ID, project.ID, []string{tag.ID})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.FinishActiveTimeEntry()
	must(err)
	startedAt, err := time.Parse(time.RFC3339Nano, entry.StartedAtUTC)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.UpdateTimeEntryForClient(entry.ID, "Updated entry", client.ID, project.ID, []string{tag.ID}, entry.StartedAtUTC, startedAt.Add(time.Hour).Format(time.RFC3339Nano))
	must(err)
	_, err = service.ListTimeDashboardGroupEntries("Renamed project", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", vault.TimeEntryFilters{})
	must(err)
	_, err = service.ListTimeTrackingConflicts()
	must(err)
	_ = service.ResolveTimeTrackingConflict("missing")
	must(service.DeleteTimeEntry(entry.ID))

	folder, err := service.CreateFolder("Folder", "")
	if err != nil {
		t.Fatal(err)
	}
	child, err := service.CreateFolder("Child", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.RenameFolder(child.ID, "Renamed child")
	must(err)
	_, err = service.MoveFolder(child.ID, "")
	must(err)
	_, err = service.SetFolderHidden(folder.ID, true)
	must(err)
	_, err = service.SetFolderSortMode(folder.ID, "updated")
	must(err)
	_, err = service.LockFolder(folder.ID, "folder-secret")
	must(err)
	must(service.CheckFolderPassword(folder.ID, "folder-secret"))
	_, err = service.UnlockFolder(folder.ID, "folder-secret")
	must(err)
	note, err := service.CreateNoteInFolder("Nested note", folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.SaveNote(note.ID, "Saved note", "[[Other note]] #tag")
	must(err)
	other, err := service.CreateNote("Other note")
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.GetNote(other.ID)
	must(err)
	_, err = service.MoveNote(other.ID, folder.ID)
	must(err)
	must(service.ReorderNotes(folder.ID, []string{other.ID, note.ID}))
	_, err = service.ResolveNoteReference("Other note")
	must(err)
	_, err = service.ListBacklinks(other.ID)
	must(err)
	_, err = service.FindInNotes("tag", false, false)
	must(err)
	_, err = service.ReplaceAcrossNotes("tag", "done", []string{note.ID}, false, false)
	must(err)
	_, err = service.ListNotes()
	must(err)
	_, err = service.ListFolders()
	must(err)

	attachmentSource := filepath.Join(t.TempDir(), "attachment.txt")
	must(os.WriteFile(attachmentSource, []byte("attachment"), 0o600))
	attachment, err := service.ImportFileAttachment(note.ID, attachmentSource)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.SaveNote(note.ID, "Saved note", "![file](attachment:"+attachment.ID+")")
	must(err)
	_, err = service.ListFileAttachments(note.ID)
	must(err)
	_, err = service.ExportFileAttachment(note.ID, attachment.ID, t.TempDir())
	must(err)
	inlineID, err := service.store.SaveAttachment(note.ID, []byte("RIFF\x04\x00\x00\x00WEBPinline attachment"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.SaveNote(note.ID, "Saved note", "![file](attachment:"+attachment.ID+")\n![inline](attachment:"+inlineID+")")
	must(err)
	_, err = service.GetAttachment(note.ID, inlineID)
	must(err)
	_, err = service.ExportMarkdown(t.TempDir())
	must(err)
	_, err = service.GetVaultSettings()
	must(err)
	settings, err := service.SaveVaultSettings(vault.VaultSettings{DailyNoteFormat: "2006-01-02"})
	if err != nil || settings.DailyNoteFormat != "2006-01-02" {
		t.Fatalf("settings = %#v, %v", settings, err)
	}
	_, err = service.GetVaultStatistics()
	must(err)
	must(service.DeleteNote(other.ID))
	_, err = service.ListTrash()
	must(err)
	must(service.RestoreTrashItem("note", other.ID))
	must(service.DeleteNote(other.ID))
	must(service.PermanentlyDeleteTrashItem("note", other.ID))
	must(service.DeleteNote(note.ID))
	must(service.DeleteFolder(child.ID))
	must(service.DeleteFolder(folder.ID))
	_, err = service.ArchiveTag(tag.ID)
	must(err)
	must(service.DeleteTag(tag.ID))
	_, err = service.ArchiveProject(project.ID)
	must(err)
	must(service.DeleteProject(project.ID))
	_, err = service.ArchiveClient(client.ID)
	must(err)
	must(service.DeleteClient(client.ID))
	must(service.CleanHistory())
	if backup, err := service.CreateScheduledBackup(t.TempDir(), 2); err != nil || backup == "" {
		t.Fatalf("backup = %q, %v", backup, err)
	}
	service.LockVault()
}

func TestVaultServiceUtilityBranches(t *testing.T) {
	service := NewVaultService()
	service.process = nil
	if _, err := service.GetApplicationStatistics(); err == nil {
		t.Fatal("nil process statistics unexpectedly succeeded")
	}
	if _, err := service.CreateScheduledBackup(t.TempDir(), 0); err == nil {
		t.Fatal("invalid backup retention unexpectedly succeeded")
	}
	if _, _, _, _, err := service.pullAndMerge("missing", 0, 3); err == nil {
		t.Fatal("pull without a link unexpectedly succeeded")
	}
	if _, _, err := service.syncAttempt("missing", 0, 3, time.Now()); err == nil {
		t.Fatal("sync attempt without a link unexpectedly succeeded")
	}
	if _, _, retry := service.pushVault("missing", 0, 3); retry {
		t.Fatal("push without a link unexpectedly retried")
	}
	if output, err := runLimitedClipboardCommand(context.Background(), "printf", "ok"); err != nil || string(output) != "ok" {
		t.Fatalf("clipboard command = %q, %v", output, err)
	}
	if _, err := runLimitedClipboardCommand(context.Background(), "sh", "-c", "exit 1"); err == nil {
		t.Fatal("failed clipboard command unexpectedly succeeded")
	}
	if err := startTerminal(exec.Command("true")); err != nil {
		t.Fatal(err)
	}
	if err := startTerminal(exec.Command("cipherleaf-command-does-not-exist")); err == nil {
		t.Fatal("missing terminal command unexpectedly started")
	}
	if runtime.GOOS == "linux" {
		t.Setenv("PATH", t.TempDir())
		if err := openTerminal(t.TempDir()); err == nil {
			t.Fatal("missing Linux terminal unexpectedly opened")
		}
	}
}

func TestVaultServiceRememberAndSyncErrors(t *testing.T) {
	service := NewVaultService()
	if err := service.CopyVaultSecret(strings.Repeat("a", 64)); err == nil {
		t.Fatal("copy without an application unexpectedly succeeded")
	}
	service.sync = githubsync.NewManager(nil, nil)
	if _, err := service.CloneGitHubVault(t.TempDir(), "clone", "git@github.com:owner/repo.git", "/key", "main", "long enough secret", false); err == nil {
		t.Fatal("clone without a provider unexpectedly succeeded")
	}

	root := t.TempDir()
	creator := vault.NewStore()
	if _, err := creator.Create(root, "long enough secret"); err != nil {
		t.Fatal(err)
	}
	service = NewVaultService()
	recentPath := filepath.Join(t.TempDir(), "recent.json")
	if err := os.Mkdir(recentPath, 0o700); err != nil {
		t.Fatal(err)
	}
	service.recent = appsession.NewRecentVaultStore(recentPath)
	service.sync = githubsync.NewManager(nil, nil)
	if _, err := service.OpenVault(root, "long enough secret"); err == nil {
		t.Fatal("open without settings storage unexpectedly succeeded")
	}
	service = NewVaultService()
	createRecentPath := filepath.Join(t.TempDir(), "recent.json")
	if err := os.Mkdir(createRecentPath, 0o700); err != nil {
		t.Fatal(err)
	}
	service.recent = appsession.NewRecentVaultStore(createRecentPath)
	if _, err := service.CreateVault(t.TempDir(), "created", "long enough secret"); err == nil {
		t.Fatal("create without settings storage unexpectedly succeeded")
	}
	service = NewVaultService()
	service.recent = appsession.NewRecentVaultStore(filepath.Join(t.TempDir(), "recent.json"))
	if _, err := service.CreateVault(t.TempDir(), "pull", "long enough secret"); err != nil {
		t.Fatal(err)
	}
	service.sync = githubsync.NewManager(nil, nil)
	keyPath := filepath.Join(t.TempDir(), "id")
	if err := os.WriteFile(keyPath, []byte("key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.PullAndLinkGitHubVault(githubsync.SyncSettings{RepositorySSH: "git@github.com:owner/repo.git", PrivateKeyPath: keyPath, Branch: "main"}); err == nil {
		t.Fatal("pull and link without a provider unexpectedly succeeded")
	}
	renameRecentPath := filepath.Join(t.TempDir(), "recent.json")
	if err := os.Mkdir(renameRecentPath, 0o700); err != nil {
		t.Fatal(err)
	}
	service.recent = appsession.NewRecentVaultStore(renameRecentPath)
	if _, err := service.RenameVault("renamed"); err == nil {
		t.Fatal("rename without settings storage unexpectedly succeeded")
	}
}
