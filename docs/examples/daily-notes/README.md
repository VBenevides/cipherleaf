# Daily notes and templates

Create a dated note from the calendar and fill it with a reusable template.
Use the disposable documentation vault from the
[vault-creation flow](../vault-creation/README.md). Never open or change an
existing vault for a documentation capture.

## Screenshots

### 1. Configure daily-note settings

<img src="screenshots/01-daily-settings.png" alt="Daily-note settings" width="640">

Configure the title format, folder, and template note.

### 2. Select the template

<img src="screenshots/02-template-configured.png" alt="Configured template" width="640">

Select the fake `Field Notes` template.

### 3. Choose a date in the calendar

<img src="screenshots/03-calendar.png" alt="Calendar" width="640">

Choose a date and open its daily note.

### 4. Open the generated daily note

<img src="screenshots/04-daily-note.png" alt="Generated daily note" width="640">

The selected date and rendered template content are visible.

## Steps

1. Open **Settings…** from the **Settings** menu.
2. In **General → Daily notes**, keep the title format as `YYYY-MM-DD`.
   Optionally choose a folder, then select a template note.
3. Use these fake template contents in a note named `Field Notes`:

   ```markdown
   # {{title}}

   Date: {{date}}
   Focus: {{title}} planning.
   ```

   Cipherleaf replaces `{{title}}`, `{{date}}`, and `{{time}}` when it creates
   the daily note.
4. Close settings and open the calendar from the date button in the sidebar.
5. Select a date and choose **Open daily note**.
6. Expand the generated section if needed. Confirm the note title follows the
   configured format and the template values are rendered.

The expected result is a note such as `2026-08-24` containing the generated
date and fake planning prompt. The example date is the date used for the
capture; it is not a required date for a real vault.
