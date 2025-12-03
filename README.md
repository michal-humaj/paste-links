# Jira Link Beautifier for Google Chat

A Chrome extension that replaces ugly Jira links with readable page titles when pasted into Google Chat.
🔵 Task
🟣 Epic
🔴 Bug
🟢 Story
✔️ Asana



## Features

- Automatically detects when Jira links are pasted into Google Chat
- Replaces the raw URL with the actual Jira issue title
- Maintains the link functionality (links remain clickable)
- Works with SSO-protected Jira instances
- Handles CORS restrictions by using a background script
- Keeps a local cache to improve performance for repeat links

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in the top-right corner)
4. Click "Load unpacked" and select the folder containing this extension
5. The extension should now be installed and active

## Usage

1. Simply copy a Jira link (e.g., `https://yourdomain.atlassian.net/browse/PROJECT-123`)
2. Paste it into Google Chat
3. The link will automatically be transformed into the format `PROJECT-123: Issue Title`
4. The link remains clickable and will open the Jira issue in a new tab

## Customization

You can modify the regular expression in `content.js` to match your specific Jira domain pattern if needed.

## Notes

- The extension requires permission to access Jira and Google Chat to function properly
- It needs to read and write to the clipboard to detect and transform Jira links
- Your Jira credentials are used directly by your browser (the extension does not store your credentials)

## Troubleshooting

If the extension isn't working:

1. Make sure you're pasting into Google Chat (either standalone or in Gmail)
2. Check that the URL matches the pattern in the extension (atlassian.net domain)
3. Ensure you're logged into your Jira instance in another tab
4. Try refreshing the Google Chat page

## Privacy

This extension:
- Does not collect or transmit any data outside of your browser
- Only sends requests to your Jira instance to fetch page titles
- Does not modify any content except the specifically matched Jira links in Google Chat 