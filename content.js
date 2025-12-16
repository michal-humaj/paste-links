// Constants for Jira link handling
const JIRA_URL_REGEX = /https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+(?:\/(?:browse|issues)\/([A-Z]+-[0-9]+)|.*[?&]selectedIssue=([A-Z]+-[0-9]+))(?:[?#&].*|\s|$)/i;
const ISSUE_KEY_REGEX = /([A-Z]+-[0-9]+)/i;

// Constants for Asana link handling
const ASANA_URL_REGEX = /https?:\/\/app\.asana\.com\/(?:\d+\/[\d\/]+|[\d\/]+\/(?:project|task)\/[\d\/]+)(?:\/f)?(?:[?#&].*|\s|$)/i;
const ASANA_TASK_ID_REGEX = /(?:\/|task\/)(\d+)(?:\/f|[?#&].*|\s|$)/i;

const DEBUG = false;
const FORCE_REFRESH = false;

// Track whether the script has been initialized
if (window._jiraLinkExtensionInitializedAt) {
  // Duplicate initialization detected - skip silently
}

// Function for logging debug messages - no-op when debug is disabled
function debugLog(message) {
  if (DEBUG) {
    console.log(`[Jira Link Beautifier] ${message}`);
  }
}

// Script initialization timestamp
// console.log(`CONTENT SCRIPT STARTED - Jira Link Beautifier ${Date.now()} - URL: ${window.location.href}`);

// Add a visible indicator that the extension is working
function addVisibleIndicator() {
  // First remove any existing indicators to prevent duplicates
  const existingIndicator = document.getElementById('jira-link-beautifier-indicator');
  if (existingIndicator && existingIndicator.parentNode) {
    existingIndicator.parentNode.removeChild(existingIndicator);
  }
  
  // Determine what platform we're on
  const platform = getCurrentPlatform();
  
  const indicator = document.createElement('div');
  indicator.style.position = 'fixed';
  indicator.style.bottom = '10px';
  indicator.style.right = '10px';
  indicator.style.backgroundColor = 'rgba(0, 128, 0, 0.7)';
  indicator.style.color = 'white';
  indicator.style.padding = '5px 10px';
  indicator.style.borderRadius = '5px';
  indicator.style.zIndex = '9999';
  indicator.style.fontSize = '12px';
  indicator.textContent = `Jira Link Beautifier Active (${platform})`;
  indicator.id = 'jira-link-beautifier-indicator';
  
  // Only add if body exists
  if (document.body) {
    document.body.appendChild(indicator);
    
    // Remove after 5 seconds
    setTimeout(() => {
      if (indicator.parentNode) {
        indicator.parentNode.removeChild(indicator);
      }
    }, 5000);
  }
}

// Try to add the indicator when the page is ready
if (document.body) {
  addVisibleIndicator();
} else {
  document.addEventListener('DOMContentLoaded', addVisibleIndicator);
}

// Global variables
const titleCache = {}; // Cache of URL -> { title, issueType }
const pendingElements = new Map(); // Map of elements waiting for title updates
let mutationObserver = null;

// Global tracker for paste events to absolutely prevent duplicates
window._jiraLinkLastPasteEventTime = 0;
window._jiraLinkEventDedupeWindow = 100; // ms
window._allowNextPaste = false; // Flag to allow paste events triggered by our execCommand

// Helper function to check if we're on Google Chat
function isGoogleChat() {
  const url = window.location.href;
  return url.includes('chat.google.com') || url.includes('mail.google.com/chat');
}

// Helper function to check if we're on Asana
function isAsana() {
  const url = window.location.href;
  return url.includes('app.asana.com');
}

// Helper function to check if we're on Google Sheets
function isGoogleSheets() {
  const url = window.location.href;
  return url.includes('docs.google.com/spreadsheets');
}

// Helper function to determine the current platform
function getCurrentPlatform() {
  if (isGoogleChat()) return 'google-chat';
  if (isAsana()) return 'asana';
  if (isGoogleSheets()) return 'google-sheets';
  return 'unknown';
}

// Helper function to generate a unique key for an element
function getElementKey(element) {
  // Create a unique identifier based on tag name and timestamp
  return `${element.tagName}-${Date.now()}`;
}

// Helper function to extract issue key from URL
function extractIssueKey(url) {
  // First try to find selectedIssue query parameter
  const selectedIssueMatch = url.match(/[?&]selectedIssue=([A-Z]+-\d+)/i);
  if (selectedIssueMatch) {
    return selectedIssueMatch[1];
  }
  
  const match = url.match(ISSUE_KEY_REGEX);
  return match ? match[1] : null;
}

// Function to transform text with Jira URLs
function transformJiraUrls(text) {
  if (!text || typeof text !== 'string') return text;
  
  // Check if the text contains a Jira URL
  const match = text.match(JIRA_URL_REGEX);
  if (!match) return text;
  
  const jiraUrl = match[0];
  const issueKey = match[1] || match[2];
  
  // If we have the title cached, replace immediately
  if (titleCache[jiraUrl]) {
    return titleCache[jiraUrl].title;
  }
  
  // Otherwise, fetch the title from background script
  chrome.runtime.sendMessage(
    { action: 'fetchJiraTitle', url: jiraUrl },
    response => {
      if (response && response.title) {
        titleCache[jiraUrl] = {
          title: response.title,
          issueType: response.issueType
        };
        debugLog(`Cached issue type for ${jiraUrl}: ${response.issueType}`);
        // We can't modify the clipboard here directly since the paste has already happened
        // But we'll update for future pastes
      }
    }
  );
  
  // Return a temporary format until we get the actual title
  return `${issueKey}: Loading...`;
}

// Main function to initialize paste event listeners
function initPasteListeners(doc = document) {
  // Check if already initialized for this document
  if (doc._jiraLinkListenersInitialized) {
    return;
  }
  
  // Mark this document as initialized
  doc._jiraLinkListenersInitialized = true;
  
  // Remove existing listener if present - use a try-catch as this might throw errors
  try {
    // Remove in both capture and bubbling phases to be thorough
    doc.removeEventListener('paste', handlePasteEvent, true);
    doc.removeEventListener('paste', handlePasteEvent, false);
  } catch (e) {
    // Ignore errors
  }
  
  // Add document level paste listener only
  doc.addEventListener('paste', handlePasteEvent);
}

// Function to update any elements with temporary titles
function updatePendingElements() {
  if (pendingElements.size === 0) return;
  
  debugLog(`Checking ${pendingElements.size} pending elements for updates`);
  
  // Make a copy of the entries to avoid issues with modification during iteration
  const entries = Array.from(pendingElements.entries());
  
  entries.forEach(([key, info]) => {
    const {element, url, tempText, attempts, platform = 'google-chat'} = info;
    
    // If we've tried too many times, give up
    if (attempts >= 5) {
      debugLog(`Giving up on updating element after ${attempts} attempts: ${url}`);
      pendingElements.delete(key);
      return;
    }
    
    // Check if we have a new title
    if (titleCache[url] && titleCache[url].title && titleCache[url].title !== tempText) {
      debugLog(`Found updated title for ${url}: ${titleCache[url].title}`);
      debugLog(`Issue type for ${url}: ${titleCache[url].issueType}`);
      
      // Try to update the element
      try {
        let success = false;
        if (platform === 'asana') {
          // For Asana, we're now replacing text directly with a link
          const issueKey = extractIssueKey(url);
          const cleanedTitle = cleanDisplayText(titleCache[url].title, url, platform);
          success = replaceTextWithLink(element, issueKey, url, cleanedTitle, titleCache[url].issueType);
        } else {
          success = replaceLastPastedJiraLink(element, tempText, url, titleCache[url].title, titleCache[url].issueType);
        }
        
        if (success) {
          debugLog(`Successfully updated element with new title: ${titleCache[url].title}`);
          pendingElements.delete(key);
          
          // Check for leftover URLs
          setTimeout(() => {
            cleanupLeftoverUrls(element, url);
          }, 100);
        } else {
          debugLog(`Failed to update element, will retry`);
          // Increment attempts
          pendingElements.set(key, {...info, attempts: attempts + 1});
        }
      } catch (e) {
        debugLog(`Failed to update element: ${e.message}`);
        // Increment attempts
        pendingElements.set(key, {...info, attempts: attempts + 1});
      }
    } else {
      // No new title yet, try to get one
      debugLog(`No updated title for ${url} yet, fetching again (attempt ${attempts + 1})`);
      chrome.runtime.sendMessage({
        action: 'fetchJiraTitle',
        url: url,
        forceRefresh: FORCE_REFRESH
      }, response => {
        if (response && response.title && response.title !== tempText) {
          titleCache[url] = {
            title: response.title,
            issueType: response.issueType
          };
        }
      });
      
      // Increment attempts
      pendingElements.set(key, {...info, attempts: attempts + 1});
    }
  });
}

// Function to update link text with the real title once fetched
function updateLinkText(element, url, oldText, newText) {
  debugLog(`Updating link text from "${oldText}" to "${newText}"`);
  let updated = false;
  
  if (!element) {
    debugLog("No element to update");
    return false;
  }
  
  // Method 1: Find by URL in href attribute
  if (element.isContentEditable) {
    // First, try direct link selection
    let links = element.querySelectorAll(`a[href="${url}"]`);
    debugLog(`Found ${links.length} links with matching href`);
    
    if (links.length > 0) {
      for (const link of links) {
        if (link.textContent === oldText || link.textContent.includes(url)) {
          link.textContent = newText;
          updated = true;
          debugLog("Updated link via direct href match");
        }
      }
    }
    
    // Method 2: Look for links with the loading text
    if (!updated) {
      links = element.querySelectorAll('a');
      for (const link of links) {
        if (link.textContent === oldText || link.textContent.includes(oldText)) {
          link.textContent = newText;
          link.href = url;
          link.setAttribute('data-is-hub-custom-hyperlink', 'true');
          link.setAttribute('data-is-editable', 'true');
          // Remove any other attributes that might interfere
          link.removeAttribute('data-link');
          link.removeAttribute('target');
          link.removeAttribute('rel');
          updated = true;
          debugLog("Updated link via content match");
        }
      }
    }
    
    // Method 3: Extract issue key and look for it in text
    const issueKey = extractIssueKey(url);
    if (!updated && issueKey) {
      const loadingPattern = new RegExp(`${issueKey}:\\s*Loading\\.\\.\\.$`, 'i');
      const tempLinks = Array.from(element.querySelectorAll('a')).filter(
        link => loadingPattern.test(link.textContent)
      );
      
      if (tempLinks.length > 0) {
        for (const link of tempLinks) {
          link.textContent = newText;
          link.href = url;
          link.setAttribute('data-is-hub-custom-hyperlink', 'true');
          link.setAttribute('data-is-editable', 'true');
          // Remove any other attributes that might interfere
          link.removeAttribute('data-link');
          link.removeAttribute('target');
          link.removeAttribute('rel');
          updated = true;
          debugLog("Updated link via issue key pattern match");
        }
      }
    }
    
    // Method 4: Look for the full URL in the text content
    if (!updated) {
      // If we still haven't found it, try to find the URL in the text directly
      const textNodes = getTextNodesIn(element);
      for (const node of textNodes) {
        if (node.nodeValue.includes(url)) {
          // Create a range around the URL
          const range = document.createRange();
          const urlIndex = node.nodeValue.indexOf(url);
          range.setStart(node, urlIndex);
          range.setEnd(node, urlIndex + url.length);
          
          // Replace with our link
          const linkNode = document.createElement('a');
          linkNode.href = url;
          linkNode.textContent = newText;
          linkNode.setAttribute('data-is-hub-custom-hyperlink', 'true');
          linkNode.setAttribute('data-is-editable', 'true');
          
          range.deleteContents();
          range.insertNode(linkNode);
          updated = true;
          debugLog("Updated via text node replacement");
        }
      }
    }
    
    // Method 5: Use regex to match Jira URL pattern in text nodes
    if (!updated) {
      // Match URL that contains the issue key either in path or query string
      // We use the issueKey we found earlier to identify the URL
      const urlRegex = new RegExp(`https?://[^\\s]+(?:/${issueKey}|selectedIssue=${issueKey})(?:[?#&]|\\s|$)`, 'i');
      const textNodes = getTextNodesIn(element);
      
      for (const node of textNodes) {
        const match = node.nodeValue.match(urlRegex);
        if (match) {
          // Create a range around the URL
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          
          // Replace with our link
          const linkNode = document.createElement('a');
          linkNode.href = url;
          linkNode.textContent = newText;
          linkNode.setAttribute('data-is-hub-custom-hyperlink', 'true');
          linkNode.setAttribute('data-is-editable', 'true');
          
          range.deleteContents();
          range.insertNode(linkNode);
          updated = true;
          debugLog("Updated via regex URL match in text node");
        }
      }
    }
    
    // Method 6: Last resort - try to update the HTML directly
    if (!updated) {
      // If we can't find the link, try to update the element HTML directly
      let htmlContent = element.innerHTML;
      
      // Replace the URL or the temp text
      const urlPattern = new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const tempPattern = new RegExp(oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      
      // Create a new link with the title
      const newLink = `<a href="${url}" data-is-hub-custom-hyperlink="true" data-is-editable="true">${newText}</a>`;
      
      // Try to replace full URL with our link
      if (htmlContent.includes(url)) {
        htmlContent = htmlContent.replace(urlPattern, newLink);
        element.innerHTML = htmlContent;
        updated = true;
        debugLog("Updated via direct HTML replacement of URL");
      } 
      // Try to replace the temporary text
      else if (htmlContent.includes(oldText)) {
        htmlContent = htmlContent.replace(tempPattern, newLink);
        element.innerHTML = htmlContent;
        updated = true;
        debugLog("Updated via direct HTML replacement of temp text");
      }
    }
    
    if (updated) {
      // Trigger input event to ensure changes are recognized
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  
  return updated;
}

// Helper function to get all text nodes within an element
function getTextNodesIn(node) {
  const textNodes = [];
  
  function getTextNodes(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      textNodes.push(node);
    } else {
      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) {
        getTextNodes(children[i]);
      }
    }
  }
  
  getTextNodes(node);
  return textNodes;
}

// Function to handle paste events
function handlePasteEvent(event) {
  // Skip if this is our own synthetic paste event (to prevent infinite loops)
  if (event._isOurEvent) {
    return;
  }
  
  // Check if we're on a supported platform before doing anything
  const platform = getCurrentPlatform();
  if (platform === 'unknown') {
    return;
  }
  
  // Special case: Skip handling if we're in the Jira Cloud field in Asana
  if (platform === 'asana') {
    // Check if the paste is happening in a ProseMirror editor (task description) - ALWAYS priority
    const activeElement = document.activeElement;
    if (activeElement) {
      // FIRST check: If we're in a ProseMirror editor, we definitely want to handle the paste
      const isProseMirrorEditor = 
          activeElement.closest('.ProsemirrorEditor-editor') || 
          activeElement.closest('.ProsemirrorEditor-content') ||
          activeElement.closest('.ProsemirrorEditor-paragraph') ||
          activeElement.classList && (
            activeElement.classList.contains('ProsemirrorEditor-editor') ||
            activeElement.classList.contains('ProsemirrorEditor-content') ||
            activeElement.classList.contains('ProsemirrorEditor-paragraph')
          );
      
      if (isProseMirrorEditor) {
        debugLog('Paste detected in ProseMirror editor (task description), proceeding with normal handling');
        // Continue processing - we want to handle paste events in the task description
      } else {
        // Not in ProseMirror editor, check if we're in Jira Cloud field
        
        // Direct check for Resource URL input field - the actual Jira integration field
        if (activeElement.tagName === 'INPUT' && 
            activeElement.getAttribute('name') === 'ResourceUrl' &&
            activeElement.getAttribute('placeholder') && 
            activeElement.getAttribute('placeholder').includes('Paste a Jira issue')) {
          debugLog('Paste detected in Jira Cloud ResourceUrl input field, not intercepting');
          return; // Skip handling
        }
        
        // Only if we're not in a ProseMirror editor AND we're in a Jira field container, skip handling
        const isJiraField = activeElement.closest('.AppActionMenu') && 
                            activeElement.closest('.TextInput') &&
                            activeElement.closest('.TextInputIconContainer-input') &&
                            !activeElement.closest('.ProsemirrorEditor-editor');
        
        if (isJiraField) {
          debugLog('Paste detected in Jira Cloud field container, not intercepting');
          return; // Skip handling
        }
      }
    }
  }
  
  // Add a unique ID to each paste event to track duplicates in logs
  const eventId = Date.now() + Math.random().toString(36).substring(2, 8);
  
  // SUPER AGGRESSIVE DEDUPE: Check if we've processed any paste event in the last 100ms
  // BUT allow through if we set the flag (for execCommand-triggered pastes)
  const now = Date.now();
  if (now - window._jiraLinkLastPasteEventTime < window._jiraLinkEventDedupeWindow) {
    if (window._allowNextPaste) {
      debugLog(`[${eventId}] Allowing paste event through (triggered by our execCommand)`);
      window._allowNextPaste = false;
      return; // Let it through without processing (native paste will happen)
    }
    debugLog(`[${eventId}] BLOCKING: Another paste event was processed in the last ${window._jiraLinkEventDedupeWindow}ms`);
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  
  // Add a tracker to the event object to prevent handling the same event multiple times
  // This happens because we register listeners at different levels, and events bubble up
  if (event._jiraLinkHandled) {
    debugLog(`[${eventId}] Event already handled, preventing duplicate processing`);
    event.preventDefault(); // Still prevent default to avoid double pastes
    event.stopPropagation();
    return;
  }
  
  // Mark this event as handled
  event._jiraLinkHandled = true;
  window._jiraLinkLastPasteEventTime = now;
  debugLog(`[${eventId}] Processing new paste event on ${platform}`);
  
  try {
    // Get clipboard data
    const clipboardData = event.clipboardData || window.clipboardData;
    if (!clipboardData) return;
    
    // Get the pasted text
    const pastedText = clipboardData.getData('text');
    if (!pastedText) return;
    
    // Sanitize the pasted text by removing extra newlines
    const sanitizedPastedText = pastedText.replace(/\r?\n/g, '');

    // NEW: Only intercept if it's a single link without additional text
    // Check if this is a single JIRA or Asana link without additional text
    const isJiraUrl = JIRA_URL_REGEX.test(sanitizedPastedText);
    const probablyJiraUrl = /https?:\/\/.*jira.*\/|https?:\/\/.*atlassian\.net\//.test(sanitizedPastedText) || 
                           sanitizedPastedText.includes('/issues/') ||
                           sanitizedPastedText.includes('/browse/');
    
    let isAsanaUrl = false;
    try {
      isAsanaUrl = ASANA_URL_REGEX.test(sanitizedPastedText);
      
      // Alternative check if the regex fails
      if (!isAsanaUrl && sanitizedPastedText.includes('app.asana.com')) {
        isAsanaUrl = sanitizedPastedText.indexOf('app.asana.com') !== -1;
      }
    } catch (error) {
      debugLog(`Error testing Asana URL regex: ${error.message}`);
    }

    // Check if the pasted text contains only a single link
    const isSingleJiraLink = (isJiraUrl || probablyJiraUrl) && 
                            /^https?:\/\/[^\s]+$/.test(sanitizedPastedText.trim());
    const isSingleAsanaLink = isAsanaUrl && 
                             /^https?:\/\/[^\s]+$/.test(sanitizedPastedText.trim());
    
    // If it's not a single link, don't intercept
    if (!isSingleJiraLink && !isSingleAsanaLink) {
      debugLog(`[${eventId}] Not intercepting paste as it's not a single JIRA or Asana link: "${sanitizedPastedText.substring(0, 50)}..."`);
      return;
    }
    
    // Check if this text was already pasted in the last 300ms (duplicate paste event)
    if (window._lastPastedText === sanitizedPastedText && 
        Date.now() - window._lastPasteTime < 300) {
      debugLog(`[${eventId}] Ignoring duplicate paste event for the same text`);
      return;
    }
    
    // Handle Asana links when pasting into Google Chat
    if (isAsanaUrl && platform === 'google-chat') {
      debugLog(`[${eventId}] Intercepted paste of potential Asana URL: ${sanitizedPastedText}`);
      
      // Extract the task ID from the URL
      let taskId = null;
      try {
        // Priority 1: Check for /item/ format (specific to inbox/search views)
        // This handles https://app.asana.com/.../item/TASK_ID/...
        const itemMatch = sanitizedPastedText.match(/\/item\/(\d+)/);
        if (itemMatch) {
           taskId = itemMatch[1];
           debugLog(`Extracted Asana task ID from /item/ segment: ${taskId}`);
        }

        // Priority 2: Check for /task/ format
        if (!taskId) {
           const taskMatch = sanitizedPastedText.match(/\/task\/(\d+)/);
           if (taskMatch) {
              taskId = taskMatch[1];
              debugLog(`Extracted Asana task ID from /task/ segment: ${taskId}`);
           }
        }

        // Priority 3: First try with standard regex
        if (!taskId) {
          const taskIdMatch = sanitizedPastedText.match(ASANA_TASK_ID_REGEX);
          taskId = taskIdMatch ? taskIdMatch[1] : null;
          if (taskId) debugLog(`Extracted Asana task ID via regex: ${taskId}`);
        }
        
        // If that fails too, try various URL segment extraction techniques
        if (!taskId) {
          // Try to get the second-to-last segment of the URL (to handle /f at the end)
          const urlParts = sanitizedPastedText.split('/');
          if (urlParts.length > 1) {
            // Check if the last part is 'f'
            if (urlParts[urlParts.length - 1] === 'f' && urlParts.length > 2) {
              const secondToLast = urlParts[urlParts.length - 2];
              if (/^\d+$/.test(secondToLast)) {
                taskId = secondToLast;
                debugLog(`Extracted Asana task ID from second-to-last segment: ${taskId}`);
              }
            } else if (urlParts[urlParts.length - 1].startsWith('?') && urlParts.length > 2) {
              // Check if the last part starts with a query parameter
              const secondToLast = urlParts[urlParts.length - 2];
              if (/^\d+$/.test(secondToLast)) {
                taskId = secondToLast;
                debugLog(`Extracted Asana task ID from segment before query: ${taskId}`);
              }
            } else {
              // Look for the largest numeric segment which is likely the task ID
              let maxDigits = 0;
              for (const part of urlParts) {
                if (/^\d+$/.test(part) && part.length > maxDigits) {
                  taskId = part;
                  maxDigits = part.length;
                }
              }
              if (taskId) {
                debugLog(`Extracted Asana task ID from largest numeric segment: ${taskId}`);
              }
            }
          }
        }
      } catch (error) {
        debugLog(`Error extracting Asana task ID: ${error.message}`);
      }
      
      if (!taskId) {
        debugLog(`[${eventId}] Failed to extract task ID from Asana URL, falling back to default paste`);
        return;
      }
      
      // Prevent the default paste which would insert the URL as text
      event.preventDefault();
      event.stopPropagation();
      
      // Find the active element where the paste was intended
      const activeElement = document.activeElement;
      if (!activeElement) {
        debugLog(`[${eventId}] No active element found for paste`);
        return;
      }
      
      // Check if the active element is editable
      const isEditable = activeElement.isContentEditable || 
                         activeElement.tagName === 'TEXTAREA' || 
                         activeElement.tagName === 'INPUT';
      
      if (!isEditable) {
        debugLog(`[${eventId}] Active element is not editable`);
        return;
      }
      
      // Record this paste to prevent duplicates
      window._lastPastedText = sanitizedPastedText;
      window._lastPasteTime = Date.now();
      
      // Generate a temporary text to use while we fetch the title
      const tempText = `✔️ Asana Task ${taskId} (loading...)`;
      
      // Check if we already have the title cached
      if (titleCache[sanitizedPastedText] && titleCache[sanitizedPastedText].title && 
          !titleCache[sanitizedPastedText].title.toLowerCase().includes('redirect')) {
        // Use cached title
        const displayText = `✔️ ${titleCache[sanitizedPastedText].title}`;
        debugLog(`[${eventId}] Using cached Asana title: ${displayText}`);
        
        // Insert with proper formatting
        pasteFormattedLink(activeElement, sanitizedPastedText, displayText, "AsanaTask");
        
        // Set up a follow-up check to ensure no URL was left behind
        setTimeout(() => {
          cleanupLeftoverUrls(activeElement, sanitizedPastedText);
        }, 50);
      } else {
        // Use temporary text while fetching the title
        pasteFormattedLink(activeElement, sanitizedPastedText, tempText, "AsanaTask");
        
        // Request title from background script
        chrome.runtime.sendMessage({
          action: 'fetchAsanaTitle',
          url: sanitizedPastedText,
          taskId: taskId,
          forceRefresh: FORCE_REFRESH
        }, response => {
          if (response && response.title && 
              !response.title.toLowerCase().includes('redirect')) {
            debugLog(`[${eventId}] Received Asana title from background: ${response.title}`);
            
            // Cache the title
            titleCache[sanitizedPastedText] = {
              title: response.title,
              issueType: "AsanaTask"
            };
            
            // Format the display text with the Asana emoji
            const displayText = `✔️ ${response.title}`;
            
            // Update the instance we just inserted
            const success = replaceLastPastedJiraLink(activeElement, tempText, sanitizedPastedText, displayText, "AsanaTask");
            
            if (success) {
              debugLog(`[${eventId}] Successfully updated the link with the fetched Asana title`);
              
              // Add a small delay before checking for any leftover URLs
              setTimeout(() => {
                cleanupLeftoverUrls(activeElement, sanitizedPastedText);
              }, 100);
            } else {
              debugLog(`[${eventId}] Failed to update the link, tracking element for later update`);
              trackElementForTitleUpdate(activeElement, sanitizedPastedText, tempText, platform);
            }
          } else {
            debugLog(`[${eventId}] Failed to get proper Asana title from background script, got: ${response?.title || 'no response'}`);
            
            // Even if we get "Redirecting", we should still cache it to avoid multiple fetch attempts
            if (response && response.title) {
              // Cache the title but mark it as incomplete
              titleCache[sanitizedPastedText] = {
                title: `Asana Task ${taskId}`,
                issueType: "AsanaTask",
                needsAuth: true
              };
              
              // Update link to a friendly format instead of showing "Redirecting"
              const displayText = `✔️ Asana Task ${taskId}`;
              replaceLastPastedJiraLink(activeElement, tempText, sanitizedPastedText, displayText, "AsanaTask");
            }
          }
        });
      }
      
      // Monitor the active element for link changes
      setupMutationObserver(activeElement);
      
      // Also watch the send button in case the message is sent before the title is fetched
      monitorSendButton();
      
      return; // We've handled the Asana URL, no need to check for Jira URLs
    }
    
    // Handle Asana links when pasting into Google Sheets
    if (isSingleAsanaLink && platform === 'google-sheets') {
      debugLog(`[${eventId}] Intercepted paste of Asana URL in Google Sheets: ${sanitizedPastedText}`);
      
      // Extract the task ID from the URL (same logic as Google Chat)
      let taskId = null;
      try {
        // Priority 1: Check for /item/ format (specific to inbox/search views)
        const itemMatch = sanitizedPastedText.match(/\/item\/(\d+)/);
        if (itemMatch) {
          taskId = itemMatch[1];
          debugLog(`Extracted Asana task ID from /item/ segment: ${taskId}`);
        }

        // Priority 2: Check for /task/ format
        if (!taskId) {
          const taskMatch = sanitizedPastedText.match(/\/task\/(\d+)/);
          if (taskMatch) {
            taskId = taskMatch[1];
            debugLog(`Extracted Asana task ID from /task/ segment: ${taskId}`);
          }
        }

        // Priority 3: Standard regex
        if (!taskId) {
          const taskIdMatch = sanitizedPastedText.match(ASANA_TASK_ID_REGEX);
          taskId = taskIdMatch ? taskIdMatch[1] : null;
          if (taskId) debugLog(`Extracted Asana task ID via regex: ${taskId}`);
        }
        
        // Priority 4: Fallback - largest numeric segment
        if (!taskId) {
          const urlParts = sanitizedPastedText.split('/');
          let maxDigits = 0;
          for (const part of urlParts) {
            if (/^\d+$/.test(part) && part.length > maxDigits) {
              taskId = part;
              maxDigits = part.length;
            }
          }
          if (taskId) {
            debugLog(`Extracted Asana task ID from largest numeric segment: ${taskId}`);
          }
        }
      } catch (error) {
        debugLog(`Error extracting Asana task ID: ${error.message}`);
      }
      
      if (!taskId) {
        debugLog(`[${eventId}] Failed to extract task ID from Asana URL, falling back to default paste`);
        return;
      }
      
      // Prevent default paste immediately
      event.preventDefault();
      event.stopPropagation();
      
      // Record this paste to prevent duplicates
      window._lastPastedText = sanitizedPastedText;
      window._lastPasteTime = Date.now();
      
      // Store the original URL to restore clipboard later
      const originalUrl = sanitizedPastedText;
      
      // Function to paste text into Google Sheets
      const pasteIntoSheets = (text) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            debugLog(`[${eventId}] Wrote to clipboard: "${text.substring(0, 50)}..."`);
            
            // Focus the active element and trigger paste command
            const activeEl = document.activeElement;
            activeEl.focus();
            
            // Set flag to allow the next paste event through (triggered by execCommand)
            window._allowNextPaste = true;
            
            // Use execCommand paste which will read from system clipboard
            const success = document.execCommand('paste');
            debugLog(`[${eventId}] execCommand paste result: ${success}`);
            
            if (!success) {
              window._allowNextPaste = false;
              // Try direct insertion as fallback
              insertTextIntoGoogleSheets(activeEl, text);
            }
            
            // Restore original URL to clipboard so user can paste it elsewhere if needed
            setTimeout(() => {
              navigator.clipboard.writeText(originalUrl).catch(() => {});
            }, 200);
          }).catch(err => {
            debugLog(`[${eventId}] Clipboard write failed: ${err.message}`);
            insertTextIntoGoogleSheets(document.activeElement, text);
          });
        } else {
          insertTextIntoGoogleSheets(document.activeElement, text);
        }
      };
      
      // Check if we already have the title cached
      if (titleCache[sanitizedPastedText] && titleCache[sanitizedPastedText].title && 
          !titleCache[sanitizedPastedText].title.toLowerCase().includes('redirect')) {
        // Use cached title - create HYPERLINK formula (no emoji for Sheets)
        // Escape double quotes in title for Google Sheets formula
        const title = titleCache[sanitizedPastedText].title.replace(/"/g, '""');
        const textToPaste = `=HYPERLINK("${sanitizedPastedText}", "${title}")`;
        debugLog(`[${eventId}] Using cached Asana title for Sheets: ${title}`);
        pasteIntoSheets(textToPaste);
      } else {
        // No cached title - fetch it first, THEN paste
        debugLog(`[${eventId}] Fetching Asana title before pasting...`);
        
        chrome.runtime.sendMessage({
          action: 'fetchAsanaTitle',
          url: sanitizedPastedText,
          taskId: taskId,
          forceRefresh: FORCE_REFRESH
        }, response => {
          let textToPaste;
          
          if (response && response.title && 
              !response.title.toLowerCase().includes('redirect')) {
            debugLog(`[${eventId}] Received Asana title from background: ${response.title}`);
            
            // Cache the title
            titleCache[sanitizedPastedText] = {
              title: response.title,
              issueType: "AsanaTask"
            };
            
            // Escape double quotes in title for Google Sheets formula
            const escapedTitle = response.title.replace(/"/g, '""');
            // Create HYPERLINK formula with actual title (no emoji for Sheets)
            textToPaste = `=HYPERLINK("${sanitizedPastedText}", "${escapedTitle}")`;
          } else {
            debugLog(`[${eventId}] Failed to get Asana title, using fallback`);
            // Fallback to just the task ID (no emoji for Sheets)
            textToPaste = `=HYPERLINK("${sanitizedPastedText}", "Asana Task ${taskId}")`;
          }
          
          // Now paste the text
          pasteIntoSheets(textToPaste);
        });
      }
      
      return; // We've handled the Asana URL in Google Sheets
    }
    
    // Handle Jira links when pasting into Google Sheets
    if (isSingleJiraLink && platform === 'google-sheets') {
      debugLog(`[${eventId}] Intercepted paste of Jira URL in Google Sheets: ${sanitizedPastedText}`);
      
      // Extract the issue key from the URL
      const issueKey = extractIssueKey(sanitizedPastedText);
      if (!issueKey) {
        debugLog(`[${eventId}] Failed to extract issue key from Jira URL, falling back to default paste`);
        return;
      }
      
      // Prevent default paste immediately
      event.preventDefault();
      event.stopPropagation();
      
      // Record this paste to prevent duplicates
      window._lastPastedText = sanitizedPastedText;
      window._lastPasteTime = Date.now();
      
      // Store the original URL to restore clipboard later
      const originalUrl = sanitizedPastedText;
      
      // Function to paste text into Google Sheets
      const pasteJiraIntoSheets = (text) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            debugLog(`[${eventId}] Wrote Jira to clipboard: "${text.substring(0, 50)}..."`);
            
            // Focus the active element and trigger paste command
            const activeEl = document.activeElement;
            activeEl.focus();
            
            // Set flag to allow the next paste event through (triggered by execCommand)
            window._allowNextPaste = true;
            
            // Use execCommand paste which will read from system clipboard
            const success = document.execCommand('paste');
            debugLog(`[${eventId}] execCommand paste result: ${success}`);
            
            if (!success) {
              window._allowNextPaste = false;
              // Try direct insertion as fallback
              insertTextIntoGoogleSheets(activeEl, text);
            }
            
            // Restore original URL to clipboard so user can paste it elsewhere if needed
            setTimeout(() => {
              navigator.clipboard.writeText(originalUrl).catch(() => {});
            }, 200);
          }).catch(err => {
            debugLog(`[${eventId}] Clipboard write failed: ${err.message}`);
            insertTextIntoGoogleSheets(document.activeElement, text);
          });
        } else {
          insertTextIntoGoogleSheets(document.activeElement, text);
        }
      };
      
      // Check if we already have the title cached
      if (titleCache[sanitizedPastedText] && titleCache[sanitizedPastedText].title) {
        // Use cached title - create HYPERLINK formula (no emoji, no issue key for Sheets)
        const cachedData = titleCache[sanitizedPastedText];
        // Extract just the title part (remove issue key if present)
        let title = cachedData.title;
        // Remove issue key prefix if present (e.g., "PROJ-123: Title" -> "Title")
        const titleMatch = title.match(/^[A-Z]+-\d+:\s*(.+)$/i);
        if (titleMatch) {
          title = titleMatch[1];
        }
        // Escape double quotes in title for Google Sheets formula
        title = title.replace(/"/g, '""');
        const textToPaste = `=HYPERLINK("${sanitizedPastedText}", "${title}")`;
        debugLog(`[${eventId}] Using cached Jira title for Sheets: ${title}`);
        pasteJiraIntoSheets(textToPaste);
      } else {
        // No cached title - fetch it first, THEN paste
        debugLog(`[${eventId}] Fetching Jira title before pasting...`);
        
        chrome.runtime.sendMessage({
          action: 'fetchJiraTitle',
          url: sanitizedPastedText,
          forceRefresh: FORCE_REFRESH
        }, response => {
          let textToPaste;
          
          if (response && response.title) {
            debugLog(`[${eventId}] Received Jira title from background: ${response.title}`);
            
            // Cache the title
            titleCache[sanitizedPastedText] = {
              title: response.title,
              issueType: response.issueType || "Unknown"
            };
            
            // Extract just the title part (remove issue key if present)
            let title = response.title;
            const titleMatch = title.match(/^[A-Z]+-\d+:\s*(.+)$/i);
            if (titleMatch) {
              title = titleMatch[1];
            }
            // Escape double quotes in title for Google Sheets formula
            title = title.replace(/"/g, '""');
            
            // Create HYPERLINK formula with just the title (no emoji, no issue key for Sheets)
            textToPaste = `=HYPERLINK("${sanitizedPastedText}", "${title}")`;
          } else {
            debugLog(`[${eventId}] Failed to get Jira title, using fallback`);
            // Fallback to issue key only
            textToPaste = `=HYPERLINK("${sanitizedPastedText}", "${issueKey}")`;
          }
          
          // Now paste the text
          pasteJiraIntoSheets(textToPaste);
        });
      }
      
      return; // We've handled the Jira URL in Google Sheets
    }
    
    // Continue with Jira URL handling (for other platforms)
    if (isJiraUrl || probablyJiraUrl) {
      debugLog(`[${eventId}] Intercepted paste of potential Jira URL: ${sanitizedPastedText}`);
      
      // Extract the issue key from the URL
      const issueKey = extractIssueKey(sanitizedPastedText);
      if (!issueKey) {
        debugLog(`[${eventId}] Failed to extract issue key from URL, falling back to default paste`);
        return;
      }
      
      // Prevent the default paste which would insert the URL as text
      event.preventDefault();
      event.stopPropagation();
      
      // Find the active element where the paste was intended
      const activeElement = document.activeElement;
      if (!activeElement) {
        debugLog(`[${eventId}] No active element found for paste`);
        return;
      }
      
      // Check if the active element is editable
      const isEditable = activeElement.isContentEditable || 
                        activeElement.tagName === 'TEXTAREA' || 
                        activeElement.tagName === 'INPUT';
      
      if (!isEditable) {
        debugLog(`[${eventId}] Active element is not editable`);
        return;
      }
      
      // Extra check for Asana to confirm we're in the right element
      if (platform === 'asana') {
        // Check if we're in the ProseMirror editor
        let inProseMirror = false;
        let currentEl = activeElement;
        
        // Look through the parent chain to find ProseMirror elements
        while (currentEl && !inProseMirror) {
          if (currentEl.classList && 
              (currentEl.classList.contains('ProsemirrorEditor-editor') || 
               currentEl.classList.contains('ProsemirrorEditor-paragraph') ||
               currentEl.classList.contains('ProsemirrorEditor-content'))) {
            inProseMirror = true;
          }
          currentEl = currentEl.parentElement;
        }
        
        // If we're in a ProseMirror editor, we should definitely proceed with beautification
        // This explicitly overrides any previous detection that might have marked this as a Jira Cloud field
        if (inProseMirror) {
          debugLog(`[${eventId}] Asana paste - In ProseMirror editor (task description): ${inProseMirror}`);
          
          // Forcibly skip any previous detection that marked this as a Jira Cloud field
          event._jiraCloudFieldDetected = false;
        } else {
          debugLog(`[${eventId}] Asana paste - Not in ProseMirror editor: ${inProseMirror}`);
        }
      }
      
      // Record this paste to prevent duplicates
      window._lastPastedText = sanitizedPastedText;
      window._lastPasteTime = Date.now();
      
      // Generate a temporary text to use while we fetch the title
      const tempText = `${issueKey}: Loading...`;
      
      // Check if we already have the title cached
      if (titleCache[sanitizedPastedText]) {
        // Use cached title - but ensure it's properly formatted 
        const cleanedTitle = cleanDisplayText(titleCache[sanitizedPastedText].title, sanitizedPastedText, platform);
        const issueType = titleCache[sanitizedPastedText].issueType || "Unknown";
        debugLog(`[${eventId}] Using cached title: ${cleanedTitle}`);
        debugLog(`[${eventId}] Using cached issue type: ${issueType}`);
        
        // Insert with proper formatting based on platform
        if (platform === 'asana') {
          const success = pasteFormattedLinkAsana(activeElement, sanitizedPastedText, cleanedTitle, issueType);
          debugLog(`[${eventId}] Asana paste result: ${success ? 'success' : 'failed'}`);
          
          // Add a quick follow-up to check for partial links in Asana
          if (success && platform === 'asana') {
            setTimeout(() => {
              // Look for potential partial links in paragraphs
              const paragraphs = document.querySelectorAll('p.ProsemirrorEditor-paragraph');
              for (const paragraph of paragraphs) {
                const links = paragraph.querySelectorAll('a.ProsemirrorEditor-link');
                for (const link of links) {
                  if ((link.href === sanitizedPastedText || link.href.includes(sanitizedPastedText)) &&
                      paragraph.textContent !== link.textContent && 
                      paragraph.textContent.includes(issueKey)) {
                    // Found partial link - fix it
                    debugLog(`[${eventId}] Found partial link after paste, fixing it`);
                    paragraph.innerHTML = `[${cleanedTitle}](${sanitizedPastedText})`;
                    paragraph.setAttribute('data-issue-type', issueType);
                    paragraph.dispatchEvent(new Event('input', { bubbles: true }));
                    paragraph.dispatchEvent(new Event('change', { bubbles: true }));
                    break;
                  }
                }
              }
            }, 100);
          }
        } else {
          pasteFormattedLink(activeElement, sanitizedPastedText, cleanedTitle, issueType);
        }
        
        // Set up a follow-up check to ensure no URL was left behind
        setTimeout(() => {
          cleanupLeftoverUrls(activeElement, sanitizedPastedText);
        }, 50);
      } else {
        // Prepare a temporary text while we fetch the title
        // For Google Chat use a temporary message
        const tempText = `${issueKey}: Loading...`;
        
        // For Asana, we'll handle this differently
        if (platform === 'asana') {
          // For Asana, just paste the plain URL first and replace it completely when we get the title
          // This avoids the link breaking issue when updating
          debugLog(`[${eventId}] Asana: Using direct URL paste initially, will replace completely when title is fetched`);
          
          // Insert the raw URL first - this will be plain text, not a link
          document.execCommand('insertText', false, issueKey);
          
          // Set up a longer tracking of this element for title replacement
          trackElementForTitleUpdate(activeElement, sanitizedPastedText, issueKey, platform);
        } else {
          // For Google Chat, use the temp text approach which works fine
          pasteFormattedLink(activeElement, sanitizedPastedText, tempText, "Unknown");
        }
        
        // Request title from background script
        chrome.runtime.sendMessage({
          action: 'fetchJiraTitle',
          url: sanitizedPastedText,
          forceRefresh: FORCE_REFRESH
        }, response => {
          if (response && response.title) {
            debugLog(`[${eventId}] Received title from background: ${response.title}`);
            debugLog(`[${eventId}] Issue type: ${response.issueType}`);
            
            // Cache the title and issue type
            titleCache[sanitizedPastedText] = {
              title: response.title,
              issueType: response.issueType
            };
            
            // Ensure the title is clean with no URL or duplicate issue keys
            const cleanedTitle = cleanDisplayText(response.title, sanitizedPastedText, platform);
            
            // Update the instance we just inserted, using platform-specific logic
            let success = false;
            if (platform === 'asana') {
              // For Asana, find where we put the issue key and replace it with the full markdown link
              success = replaceTextWithLink(activeElement, issueKey, sanitizedPastedText, cleanedTitle, response.issueType);
              debugLog(`[${eventId}] Asana update result: ${success ? 'success' : 'failed'}`);
            } else {
              success = replaceLastPastedJiraLink(activeElement, tempText, sanitizedPastedText, cleanedTitle, response.issueType);
            }
            
            if (success) {
              debugLog(`[${eventId}] Successfully updated the link with the fetched title`);
              
              // Add a small delay before checking for any leftover URLs
              setTimeout(() => {
                cleanupLeftoverUrls(activeElement, sanitizedPastedText);
              }, 100);
            } else {
              debugLog(`[${eventId}] Failed to update the link, tracking element for later update`);
              trackElementForTitleUpdate(activeElement, sanitizedPastedText, tempText, platform);
            }
          } else {
            debugLog(`[${eventId}] Failed to get title from background script`);
          }
        });
      }
      
      // Monitor the active element for link changes
      setupMutationObserver(activeElement);
      
      // Also watch the send button in case the message is sent before the title is fetched
      if (platform === 'google-chat') {
        monitorSendButton();
      }
    }
  } catch (error) {
    // Log any errors but don't interrupt the user's experience
    // Error in paste handler - fail silently in production
    if (DEBUG) console.error(`[${eventId}] Jira Link Extension paste handler error:`, error);
  }
}

// Function to insert text into Google Sheets cell editor
function insertTextIntoGoogleSheets(element, text) {
  debugLog(`Inserting text into Google Sheets: "${text.substring(0, 50)}..."`);
  
  try {
    // Log what element we're working with
    const activeEl = document.activeElement;
    debugLog(`Active element: ${activeEl.tagName}, class: ${activeEl.className}, contentEditable: ${activeEl.isContentEditable}`);
    
    // Google Sheets uses an iframe for text input - find it
    const textEventIframe = document.querySelector('.docs-texteventtarget-iframe');
    let targetDoc = document;
    let targetElement = activeEl;
    
    if (textEventIframe && textEventIframe.contentDocument) {
      targetDoc = textEventIframe.contentDocument;
      targetElement = targetDoc.body || targetDoc.activeElement || textEventIframe;
      debugLog(`Found Google Sheets text event iframe, targeting its body`);
    }
    
    // Try to find the actual cell editor input
    const cellInput = document.querySelector('.cell-input') || 
                      document.querySelector('[data-sheets-value]') ||
                      document.querySelector('.waffle-text-input');
    if (cellInput) {
      targetElement = cellInput;
      debugLog(`Found cell input element: ${cellInput.tagName}, class: ${cellInput.className}`);
    }
    
    // Method 1: Try execCommand on the target document
    targetElement.focus();
    const execResult = targetDoc.execCommand('insertText', false, text);
    debugLog(`execCommand insertText result: ${execResult}`);
    
    if (execResult) {
      // Dispatch input event to notify Google Sheets
      targetElement.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
      return true;
    }
    
    // Method 2: If execCommand failed, try character-by-character simulation
    debugLog('execCommand failed, trying character simulation on iframe');
    
    // Focus the iframe content
    if (textEventIframe && textEventIframe.contentDocument) {
      const iframeBody = textEventIframe.contentDocument.body;
      if (iframeBody) {
        iframeBody.focus();
        
        // Type each character
        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          const charCode = char.charCodeAt(0);
          
          // Dispatch to iframe document
          ['keydown', 'keypress', 'keyup'].forEach(eventType => {
            const event = new KeyboardEvent(eventType, {
              key: char,
              code: charCode >= 65 && charCode <= 90 ? `Key${char.toUpperCase()}` : undefined,
              charCode: charCode,
              keyCode: charCode,
              which: charCode,
              bubbles: true,
              cancelable: true,
              view: textEventIframe.contentWindow
            });
            iframeBody.dispatchEvent(event);
          });
          
          // Also dispatch input event
          const inputEvent = new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: char,
            view: textEventIframe.contentWindow
          });
          iframeBody.dispatchEvent(inputEvent);
        }
        
        debugLog(`Simulated typing ${text.length} characters in iframe`);
        return true;
      }
    }
    
    debugLog('All insertion methods failed');
    return false;
  } catch (error) {
    debugLog(`Error inserting text into Google Sheets: ${error.message}`);
    return false;
  }
}

// Function to paste a formatted link directly into the element
function pasteFormattedLink(element, url, displayText, issueType = "Unknown") {
  const pasteId = Date.now() + Math.random().toString(36).substring(2, 8);
  debugLog(`[${pasteId}] Pasting formatted link with original text: ${displayText}, type: ${issueType}`);
  
  // Thoroughly clean the display text to remove URLs and fix duplicate issue keys
  displayText = cleanDisplayText(displayText, url, getCurrentPlatform());
  
  debugLog(`[${pasteId}] Using cleaned display text: ${displayText}`);
  
  if (element.isContentEditable) {
    // Get the current selection
    const selection = window.getSelection();
    
    if (selection.rangeCount > 0) {
      // Get the range at the current selection
      const range = selection.getRangeAt(0);
      
      // Clear any selected text first to avoid it being part of our link
      range.deleteContents();
      
      // Create the link element
      const linkElement = document.createElement('a');
      linkElement.href = url;
      linkElement.textContent = displayText; // This should be ONLY the title, no URL
      linkElement.setAttribute('data-is-hub-custom-hyperlink', 'true');
      linkElement.setAttribute('data-is-editable', 'true');
      
      // Mark this as created by our extension and add issue type
      linkElement.setAttribute('data-jira-link-beautifier', pasteId);
      linkElement.setAttribute('data-issue-type', issueType);
      
      // Insert the link element
      range.insertNode(linkElement);
      
      // Move the cursor to after the inserted link
      range.setStartAfter(linkElement);
      range.setEndAfter(linkElement);
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Dispatch input event to ensure Google Chat recognizes the change
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // No selection, try using document.execCommand as a fallback
      // Focus the element
      element.focus();
      
      // Create a temporary element to hold our link HTML
      const temp = document.createElement('div');
      // Make sure we're ONLY inserting the title as link text, not the URL
      temp.innerHTML = `<a href="${url}" data-is-hub-custom-hyperlink="true" data-is-editable="true" data-jira-link-beautifier="${pasteId}" data-issue-type="${issueType}">${displayText}</a>`;
      
      // Insert the HTML content
      document.execCommand('insertHTML', false, temp.innerHTML);
      
      // Dispatch events
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } else if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    // For plain text inputs, we can't insert HTML
    // Just insert the display text without the URL
    const selStart = element.selectionStart;
    const selEnd = element.selectionEnd;
    const value = element.value;
    
    element.value = value.substring(0, selStart) + displayText + value.substring(selEnd);
    
    // Update selection position
    element.selectionStart = element.selectionEnd = selStart + displayText.length;
    
    // Trigger input event
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Helper function to save the current selection state
function saveSelection(containerEl) {
  if (window.getSelection && document.createRange) {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const preSelectionRange = range.cloneRange();
      preSelectionRange.selectNodeContents(containerEl);
      preSelectionRange.setEnd(range.startContainer, range.startOffset);
      const start = preSelectionRange.toString().length;
      
      return {
        start: start,
        end: start + range.toString().length
      };
    }
  }
  return null;
}

// Helper function to restore a saved selection state
function restoreSelection(containerEl, savedSel) {
  if (window.getSelection && document.createRange) {
    let charCount = 0;
    const range = document.createRange();
    range.setStart(containerEl, 0);
    range.collapse(true);
    
    const nodeStack = [containerEl];
    let node;
    let foundStart = false;
    let stop = false;
    
    while (!stop && (node = nodeStack.pop())) {
      if (node.nodeType === 3) {
        const nextCharCount = charCount + node.length;
        if (!foundStart && savedSel.start >= charCount && savedSel.start <= nextCharCount) {
          range.setStart(node, savedSel.start - charCount);
          foundStart = true;
        }
        if (foundStart && savedSel.end >= charCount && savedSel.end <= nextCharCount) {
          range.setEnd(node, savedSel.end - charCount);
          stop = true;
        }
        charCount = nextCharCount;
      } else {
        let i = node.childNodes.length;
        while (i--) {
          nodeStack.push(node.childNodes[i]);
        }
      }
    }
    
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// Set up a mutation observer to watch for link changes in an element
function setupLinkObserver(element) {
  // Check if we've already set up an observer for this element
  if (element._linkObserverSet) return;
  
  debugLog("Setting up link mutation observer");
  
  // Create a mutation observer to watch for changes to the element
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if (mutation.type === 'childList' || mutation.type === 'characterData') {
        // Look for any anchors that might be newly created or modified
        const anchors = element.querySelectorAll('a');
        
        anchors.forEach(anchor => {
          // Get the href
          const href = anchor.getAttribute('href');
          
          if (href && !anchor.hasAttribute('data-is-hub-custom-hyperlink')) {
            debugLog("Found link without proper attributes, fixing it");
            
            // This is a link that doesn't have the proper Google Chat attributes
            anchor.setAttribute('data-is-hub-custom-hyperlink', 'true');
            anchor.setAttribute('data-is-editable', 'true');
            
            // If this removes other attributes like target, that's fine as Google Chat
            // will handle the actual navigation 
          }
        });
      }
    });
  });
  
  // Start observing
  observer.observe(element, { 
    childList: true,
    subtree: true,
    characterData: true 
  });
  
  // Mark that we've set up an observer for this element
  element._linkObserverSet = true;
  
  // Clean up the observer when the element is removed from the DOM
  const cleanup = () => {
    observer.disconnect();
  };
  
  // Try to remove the observer when the element is removed
  // This is a best effort cleanup
  setTimeout(() => {
    if (!document.contains(element)) {
      cleanup();
    }
  }, 60000);
}

// Function to monitor the send button for message sending
function monitorSendButton() {
  // Find all potential send buttons in Google Chat
  const sendButtons = document.querySelectorAll('button[aria-label="Send message"]');
  
  for (const button of sendButtons) {
    // Check if we already added a listener
    if (!button.hasAttribute('data-jira-monitored')) {
      // Add a click listener
      button.addEventListener('click', () => {
        debugLog('Send button clicked, performing final cleanup');
        
        // Get the active message input element
        const activeElement = document.activeElement;
        
        // Update any pending links
        updatePendingLinks();
        
        // Find the input container (usually a parent of the active element)
        let inputContainer = activeElement;
        if (!inputContainer || !inputContainer.isContentEditable) {
          // Try to find a contentEditable element nearby
          const possibleInputs = document.querySelectorAll('[contenteditable="true"]');
          
          // Find the one closest to where we are
          if (possibleInputs.length > 0) {
            inputContainer = possibleInputs[possibleInputs.length - 1];
          }
        }
        
        if (inputContainer && inputContainer.isContentEditable) {
          // Perform a final sweep for URLs
          performFinalUrlCleanup(inputContainer);
        }
      });
      
      // Mark this button as monitored
      button.setAttribute('data-jira-monitored', 'true');
      
      debugLog('Send button monitoring added');
    }
  }
}

// Function to perform a final cleanup of any URLs in the element before sending
function performFinalUrlCleanup(element) {
  try {
    // Check all text nodes for Jira or Asana URLs
    const textNodes = getTextNodesIn(element);
    let found = false;
    
    // Determine the platform
    const platform = getCurrentPlatform();
    
    for (const node of textNodes) {
      // Look for anything that looks like a Jira URL
      const jiraUrlMatch = node.nodeValue.match(JIRA_URL_REGEX);
      if (jiraUrlMatch) {
        const url = jiraUrlMatch[0];
        
        // Get the issue key
        const issueKey = extractIssueKey(url);
        if (!issueKey) continue;
        
        // Get the cached title and issue type if available
        let displayText;
        let issueType = "Unknown";
        
        if (titleCache[url]) {
          displayText = titleCache[url].title;
          issueType = titleCache[url].issueType;
        } else {
          displayText = `${issueKey}: Jira Issue`;
        }
        
        displayText = cleanDisplayText(displayText, url, platform);
        
        // Create a range to replace just the URL
        const range = document.createRange();
        const startIndex = node.nodeValue.indexOf(url);
        range.setStart(node, startIndex);
        range.setEnd(node, startIndex + url.length);
        
        if (platform === 'asana') {
          // Use the markdown-style syntax that Asana will auto-convert
          const markdownText = document.createTextNode(`[${displayText}](${url})`);
          range.deleteContents();
          range.insertNode(markdownText);
        } else {
          // Create a Google Chat link element
          const linkElement = document.createElement('a');
          linkElement.href = url;
          linkElement.textContent = displayText;
          linkElement.setAttribute('data-is-hub-custom-hyperlink', 'true');
          linkElement.setAttribute('data-is-editable', 'true');
          linkElement.setAttribute('data-jira-extension-created', 'true');
          linkElement.setAttribute('data-issue-type', issueType);
          
          // Replace the URL with the link
          range.deleteContents();
          range.insertNode(linkElement);
        }
        
        found = true;
      }
      
      // Look for Asana URLs (only in Google Chat)
      if (platform === 'google-chat') {
        const asanaUrlMatch = node.nodeValue.match(ASANA_URL_REGEX);
        if (asanaUrlMatch) {
          const url = asanaUrlMatch[0];
          
          // Extract the task ID
          const taskIdMatch = url.match(ASANA_TASK_ID_REGEX);
          const taskId = taskIdMatch ? taskIdMatch[1] : null;
          if (!taskId) continue;
          
          // Get the cached title if available
          let displayText;
          
          if (titleCache[url]) {
            displayText = `✔️ ${titleCache[url].title}`;
          } else {
            displayText = `✔️ Asana Task ${taskId}`;
          }
          
          // Create a range to replace just the URL
          const range = document.createRange();
          const startIndex = node.nodeValue.indexOf(url);
          range.setStart(node, startIndex);
          range.setEnd(node, startIndex + url.length);
          
          // Create a Google Chat link element
          const linkElement = document.createElement('a');
          linkElement.href = url;
          linkElement.textContent = displayText;
          linkElement.setAttribute('data-is-hub-custom-hyperlink', 'true');
          linkElement.setAttribute('data-is-editable', 'true');
          linkElement.setAttribute('data-asana-extension-created', 'true');
          linkElement.setAttribute('data-issue-type', 'AsanaTask');
          
          // Replace the URL with the link
          range.deleteContents();
          range.insertNode(linkElement);
          
          found = true;
        }
      }
    }
    
    // For Asana, also look for plain text paragraphs that might contain Jira URLs
    if (platform === 'asana') {
      const paragraphs = element.querySelectorAll('p');
      for (const paragraph of paragraphs) {
        // Skip if this paragraph already has a link
        if (paragraph.querySelector('a')) continue;
        
        // Check if the paragraph text contains a Jira URL
        if (paragraph.textContent && paragraph.textContent.match(JIRA_URL_REGEX)) {
          const match = paragraph.textContent.match(JIRA_URL_REGEX);
          const url = match[0];
          const issueKey = extractIssueKey(url);
          
          if (issueKey) {
            // Get title and issue type
            let displayText;
            let issueType = "Unknown";
            
            if (titleCache[url]) {
              displayText = titleCache[url].title;
              issueType = titleCache[url].issueType;
            } else {
              displayText = `${issueKey}: Jira Issue`;
            }
            
            displayText = cleanDisplayText(displayText, url, 'asana');
            
            // Replace with markdown-style link
            paragraph.innerHTML = `[${displayText}](${url})`;
            paragraph.setAttribute('data-issue-type', issueType);
            
            found = true;
          }
        }
      }
    }
    
    // Also check for links that might have URLs as their text
    const links = element.querySelectorAll('a');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;
      
      // Check if this is a Jira link
      if (JIRA_URL_REGEX.test(link.textContent) && titleCache[href]) {
        const displayText = cleanDisplayText(titleCache[href].title, href, platform);
        const issueType = titleCache[href].issueType || "Unknown";
        
        // Replace the link text with the better title
        link.textContent = displayText;
        link.setAttribute('data-issue-type', issueType);
        
        // Ensure the link has the proper attributes based on platform
        if (platform === 'asana') {
          link.className = 'ProsemirrorEditor-link';
        } else {
          // Google Chat attributes
          link.setAttribute('data-is-hub-custom-hyperlink', 'true');
          link.setAttribute('data-is-editable', 'true');
        }
        
        found = true;
      }
      // Check if this is an Asana link in Google Chat
      else if (platform === 'google-chat' && ASANA_URL_REGEX.test(link.textContent) && titleCache[href]) {
        const displayText = `✔️ ${titleCache[href].title}`;
        
        // Replace the link text with the better title
        link.textContent = displayText;
        link.setAttribute('data-issue-type', 'AsanaTask');
        
        // Google Chat attributes
        link.setAttribute('data-is-hub-custom-hyperlink', 'true');
        link.setAttribute('data-is-editable', 'true');
        
        found = true;
      }
    }
    
    if (found) {
      // Dispatch events to ensure the platform recognizes the changes
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (error) {
    // Ignore errors
  }
}

// Function to deduplicate existing links in an element
function deduplicateExistingLinks(element) {
  if (!element || !element.querySelectorAll) return;
  
  try {
    // Step 1: Group links by their issue key or URL
    const linkGroups = new Map();
    
    const links = element.querySelectorAll('a');
    for (const link of links) {
      const href = link.getAttribute('href');
      const text = link.textContent;
      
      // Skip links without href
      if (!href) continue;
      
      // Try to extract issue key from URL or text
      let issueKey = extractIssueKey(href);
      if (!issueKey) {
        // Try to extract from text
        const match = text.match(ISSUE_KEY_REGEX);
        issueKey = match ? match[1] : null;
      }
      
      // Skip if we can't identify the issue
      if (!issueKey) continue;
      
      // Add to group
      if (!linkGroups.has(issueKey)) {
        linkGroups.set(issueKey, []);
      }
      linkGroups.get(issueKey).push(link);
    }
    
    // Step 2: Process each group that has duplicates
    for (const [issueKey, groupLinks] of linkGroups.entries()) {
      if (groupLinks.length <= 1) continue;
      
      debugLog(`Found ${groupLinks.length} duplicate links for ${issueKey}`);
      
      // Find the best link to keep (prefer those with proper attributes)
      let bestLinkIndex = 0;
      for (let i = 0; i < groupLinks.length; i++) {
        const link = groupLinks[i];
        if (link.getAttribute('data-is-hub-custom-hyperlink') === 'true') {
          bestLinkIndex = i;
          break;
        }
      }
      
      // Keep the best link, check others for proximity and remove if close
      const bestLink = groupLinks[bestLinkIndex];
      const bestRect = bestLink.getBoundingClientRect();
      
      for (let i = 0; i < groupLinks.length; i++) {
        if (i === bestLinkIndex) continue;
        
        const link = groupLinks[i];
        const rect = link.getBoundingClientRect();
        
        // Calculate distance
        const distance = Math.sqrt(
          Math.pow(bestRect.left - rect.left, 2) + Math.pow(bestRect.top - rect.top, 2)
        );
        
        // If they're close (within 200px) or on the same line
        if (distance < 200 || Math.abs(bestRect.top - rect.top) < 20) {
          debugLog(`Removing duplicate link: ${link.textContent}`);
          
          // If the link is inside a span or other container, we might need to
          // remove the container to avoid empty elements
          let nodeToRemove = link;
          const parent = link.parentNode;
          
          // Only handle simple cases to avoid breaking the interface
          if (parent && parent.childNodes.length === 1 && 
              (parent.tagName === 'SPAN' || parent.tagName === 'DIV')) {
            nodeToRemove = parent;
          }
          
          if (nodeToRemove.parentNode) {
            nodeToRemove.parentNode.removeChild(nodeToRemove);
          }
        }
      }
    }
  } catch (error) {
    debugLog(`Error deduplicating links: ${error.message}`);
  }
}

// Function to replace the last pasted Jira link with a properly formatted one
function replaceLastPastedJiraLink(element, oldText, url, newText, issueType = "Unknown") {
  debugLog(`Replacing: "${oldText}" with "${newText}" for URL: ${url}, type: ${issueType}`);
  
  // Platform-specific handling
  const platform = getCurrentPlatform();
  if (platform === 'asana') {
    return replaceLastPastedJiraLinkAsana(element, oldText, url, newText, issueType);
  }
  
  try {
    // Clean the URL for use in selectors by removing newlines and properly escaping
    const sanitizedUrl = url.replace(/\r?\n/g, '').replace(/"/g, '\\"');
    
    // Method 1: Find by URL in href attribute
    let links = element.querySelectorAll(`a[href="${sanitizedUrl}"]`);
    debugLog(`Found ${links.length} links with matching href`);
    
    // Continue with the rest of the function...
    if (links.length > 0) {
      for (const link of links) {
        // If we already have the right text, skip
        if (link.textContent === newText) continue;
        
        link.textContent = newText;
        link.setAttribute('data-issue-type', issueType);
        debugLog(`Updated link text via href match to: ${newText}`);
        return true;
      }
    }
    
    // Method 2: Try to find by ID if href failed
    links = element.querySelectorAll('a[data-jira-link-beautifier]');
    for (const link of links) {
      if (link.href === url || link.textContent === oldText || 
          (oldText && link.textContent.includes(oldText))) {
        link.textContent = newText;
        link.href = url;
        link.setAttribute('data-issue-type', issueType);
        debugLog(`Updated link text via data attribute to: ${newText}`);
        return true;
      }
    }
    
    // Method 3: More general query for links with loading text
    links = element.querySelectorAll('a');
    for (const link of links) {
      if (link.textContent === oldText || 
          (oldText && link.textContent.includes(oldText))) {
        link.textContent = newText;
        link.href = url;
        link.setAttribute('data-is-hub-custom-hyperlink', 'true');
        link.setAttribute('data-is-editable', 'true');
        link.setAttribute('data-issue-type', issueType);
        debugLog(`Updated link text via content match to: ${newText}`);
        return true;
      }
    }
    
    // Method 4: Last resort - extract issue key and look for loading pattern
    const issueKey = extractIssueKey(url);
    if (issueKey) {
      const loadingPattern = `${issueKey}: Loading...`;
      links = element.querySelectorAll('a');
      for (const link of links) {
        if (link.textContent.includes(loadingPattern)) {
          link.textContent = newText;
          link.href = url;
          link.setAttribute('data-is-hub-custom-hyperlink', 'true');
          link.setAttribute('data-is-editable', 'true');
          link.setAttribute('data-issue-type', issueType);
          debugLog(`Updated link via issue key loading pattern to: ${newText}`);
          return true;
        }
      }
    }
    
    debugLog(`Failed to find and update link for: ${url}`);
    return false;
  } catch (error) {
    debugLog(`Error replacing link: ${error.message}`);
    return false;
  }
}

// Record load time for tracking potential duplicate initialization
window._jiraLinkScriptLoadTime = Date.now();

// Create a unified initialization function that handles everything
function initializeJiraLinkBeautifier() {
  // First check if we're on a supported platform
  const platform = getCurrentPlatform();
  if (platform === 'unknown') {
    return;
  }
  
  // Check if we've already initialized - multiple levels of protection
  if (window._jiraLinkExtensionInitialized) {
    return;
  }
  
  // Initialize paste listeners for main document
  initPasteListeners(document);
  
  // Set up iframe handling
  setupIframeListeners();
  
  // Initialize the extension fully
  initializeExtension();
  
  // Listen for messages from the background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === 'titleUpdated') {
      const { url, title, issueType } = message;
      debugLog(`Received updated title for ${url}: ${title} (${issueType})`);
      
      // Update the cache
      titleCache[url] = { title, issueType };
      
      // Find any links with this URL that need updating
      const links = document.querySelectorAll(`a[href="${url}"]`);
      for (const link of links) {
        // Skip links that already have the updated title
        if (link.textContent === title) continue;
        
        // Check if this link appears to be one we created (Loading text, or generic task ID)
        const isOurLink = link.textContent.includes('loading') || 
                         link.textContent.includes('Task') ||
                         link.hasAttribute('data-asana-extension-created') ||
                         link.hasAttribute('data-jira-extension-created');
        
        if (isOurLink) {
          debugLog(`Updating link text from "${link.textContent}" to "${title}"`);
          
          // Format the display text appropriately
          let displayText = title;
          if (issueType === 'AsanaTask') {
            displayText = `✔️ ${title}`;
          } else if (issueType) {
            displayText = cleanDisplayText(title, url, getCurrentPlatform());
          }
          
          // Update the link text
          link.textContent = displayText;
          
          // Set appropriate attributes
          link.setAttribute('data-issue-type', issueType);
          if (issueType === 'AsanaTask') {
            link.setAttribute('data-asana-extension-created', 'true');
          } else {
            link.setAttribute('data-jira-extension-created', 'true');
          }
          
          // Ensure the link has the required Google Chat attributes
          if (getCurrentPlatform() === 'google-chat') {
            link.setAttribute('data-is-hub-custom-hyperlink', 'true');
            link.setAttribute('data-is-editable', 'true');
          }
        }
      }
      
      // Also update any tracked pending elements
      pendingElements.forEach((data, key) => {
        if (data.url === url) {
          // Try to update the element with the new title
          const { element, tempText } = data;
          if (issueType === 'AsanaTask') {
            const displayText = `✔️ ${title}`;
            replaceLastPastedJiraLink(element, tempText, url, displayText, issueType);
          } else {
            replaceLastPastedJiraLink(element, tempText, url, title, issueType);
          }
          
          // Remove this element from pending
          pendingElements.delete(key);
          
          debugLog(`Updated pending element with new title: ${title}`);
        }
      });
    }
    
    return true; // Keep the channel open for response if needed
  });
}

// Wait for the page to be fully loaded, then initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeJiraLinkBeautifier);
} else {
  initializeJiraLinkBeautifier();
}

// Also initialize on window load to be extra sure
window.addEventListener('load', () => {
  if (!window._jiraLinkExtensionInitialized) {
    initializeJiraLinkBeautifier();
  }
});

// Helper to clean up intervals and timeouts
function clearAllTimeoutsAndIntervals() {
  // Clear our known intervals
  if (window._jiraLinkUpdateInterval) {
    clearInterval(window._jiraLinkUpdateInterval);
    window._jiraLinkUpdateInterval = null;
  }
  
  if (window._jiraSendButtonInterval) {
    clearInterval(window._jiraSendButtonInterval);
    window._jiraSendButtonInterval = null;
  }
  
  if (window._jiraCleanupInterval) {
    clearInterval(window._jiraCleanupInterval);
    window._jiraCleanupInterval = null;
  }
  
  // If we have a mutation observer, disconnect it
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
}

// Execute initialization
initializeExtension();

// Helper function to clean display text
function cleanDisplayText(text, url, platform) {
  if (!text) return text;
  
  // Extract the issue key from the URL
  const issueKeyMatch = url ? url.match(ISSUE_KEY_REGEX) : null;
  const issueKey = issueKeyMatch ? issueKeyMatch[1] : null;
  
  if (!issueKey) return text;
  
  let cleanedText = text;
  
  // Get the current platform if not provided
  if (!platform) {
    platform = getCurrentPlatform();
  }
  
  // Get the issue type from cache if available
  let issueType = "Unknown";
  if (titleCache[url] && titleCache[url].issueType) {
    issueType = titleCache[url].issueType;
  }
  
  // First check if the text already has any emoji and remove it to start fresh
  cleanedText = cleanedText.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
  
  // Step 1: Check if the URL appears in the text (exact match)
  if (cleanedText.includes(url)) {
    // Remove the URL completely
    cleanedText = cleanedText.replace(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
  }
  
  // Step 2: Check for URL parts to remove any variation of the URL
  // Remove domain and paths that might be in the text
  const urlParts = url.split('/');
  for (let i = 2; i < urlParts.length; i++) {
    // Check if this part is substantial enough to remove (avoid small common words)
    if (urlParts[i] && urlParts[i].length > 5) {
      const partRegex = new RegExp(urlParts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      cleanedText = cleanedText.replace(partRegex, '');
    }
  }
  
  // Step 3: Check for and fix duplicated issue key
  // Remove any standalone occurrences of the issue key 
  // (but not the one that should be at the start of our title)
  const issueKeyRegex = new RegExp(`(?<!^)\\b${issueKey}\\b`, 'gi');
  cleanedText = cleanedText.replace(issueKeyRegex, '');
  
  // Step 4: Ensure the issue key is at the beginning
  if (!cleanedText.match(new RegExp(`^\\s*${issueKey}`, 'i'))) {
    cleanedText = `${issueKey}: ${cleanedText.replace(/^[\s:]+/, '')}`;
  }
  
  // Step 5: Clean up any artifacts left by our replacements
  // Remove any colons or whitespace at the beginning
  cleanedText = cleanedText.replace(/^[\s:]+/, '');
  // Fix multiple colons after issue key
  cleanedText = cleanedText.replace(new RegExp(`${issueKey}\\s*:+\\s*`, 'i'), `${issueKey}: `);
  // Remove multiple consecutive whitespaces
  cleanedText = cleanedText.replace(/\s+/g, ' ');
  // Remove any standalone colons
  cleanedText = cleanedText.replace(/\s+:\s+/g, ' ');
  
  // Final cleanup and trim
  cleanedText = cleanedText.trim();
  
  // Create a clean format with the issue key at the beginning and the title after
  const titlePart = cleanedText.replace(new RegExp(`^${issueKey}:\\s*`, 'i'), '');
  
  // Get the appropriate icon based on issue type - ensure exact case matching
  // Normalize issue type to handle case variations
  const normalizedType = issueType.toLowerCase();
  let icon = '🔵'; // Default blue circle
  
  // Set specific icons based on issue type
  if (normalizedType.includes('epic')) {
    icon = '🟣'; // Purple circle for Epics
  } else if (normalizedType.includes('bug')) {
    icon = '🔴'; // Red circle for Bugs
  } else if (normalizedType.includes('task')) {
    icon = '🔹'; // Blue diamond for Tasks
  } else if (normalizedType.includes('story') || normalizedType.includes('user story')) {
    icon = '🟢'; // Green circle for Stories
  } else if (normalizedType.includes('confluence')) {
    icon = '📄'; // Document for Confluence pages
  }
  
  // Add the appropriate icon at the beginning for both Google Chat and Asana
  cleanedText = `${icon} ${issueKey}: ${titlePart}`;
  
  return cleanedText;
}

// Function to update any pending link elements
function updatePendingLinks() {
  if (pendingElements.size === 0) {
    return;
  }
  
  pendingElements.forEach((data, key) => {
    const { element, url, tempText, attempts, platform = 'google-chat'} = data;
    
    // Skip if this element doesn't have a valid URL
    if (!url) {
      pendingElements.delete(key);
      return;
    }
    
    // If we've tried too many times, give up
    if (attempts >= 5) {
      pendingElements.delete(key);
      return;
    }
    
    // Check if we have a new title
    if (titleCache[url] && titleCache[url].title && titleCache[url].title !== tempText) {
      // Try to update the element
      try {
        let success = false;
        if (platform === 'asana') {
          // For Asana, we're now replacing text directly with a link
          const issueKey = extractIssueKey(url);
          const cleanedTitle = cleanDisplayText(titleCache[url].title, url, platform);
          success = replaceTextWithLink(element, issueKey, url, cleanedTitle, titleCache[url].issueType);
        } else {
          success = replaceLastPastedJiraLink(element, tempText, url, titleCache[url].title, titleCache[url].issueType);
        }
        
        if (success) {
          pendingElements.delete(key);
          
          // Check for leftover URLs
          setTimeout(() => {
            cleanupLeftoverUrls(element, url);
          }, 100);
        } else {
          // Increment attempts
          pendingElements.set(key, {...data, attempts: attempts + 1});
        }
      } catch (e) {
        // Increment attempts
        pendingElements.set(key, {...data, attempts: attempts + 1});
      }
    } else {
      // No new title yet, try to get one
      debugLog(`No updated title for ${url} yet, fetching again (attempt ${attempts + 1})`);
      chrome.runtime.sendMessage({
        action: 'fetchJiraTitle',
        url: url,
        forceRefresh: FORCE_REFRESH
      }, response => {
        if (response && response.title && response.title !== tempText) {
          titleCache[url] = {
            title: response.title,
            issueType: response.issueType
          };
        }
      });
      
      // Increment attempts
      pendingElements.set(key, {...data, attempts: attempts + 1});
    }
  });
}

// Function to set up a mutation observer to watch for changes to the active element
function setupMutationObserver(element) {
  // If we already have a mutation observer, disconnect it
  if (mutationObserver) {
    mutationObserver.disconnect();
  }
  
  // Create a new mutation observer
  mutationObserver = new MutationObserver((mutations) => {
    // Check if any of the mutations involve link elements
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // If nodes were added, check if any pending links need updating
        updatePendingLinks();
      }
    }
  });
  
  // Start observing the element
  mutationObserver.observe(element, {
    childList: true,
    subtree: true,
    characterData: true
  });
  
  debugLog('Mutation observer set up for active element');
}

// Function to clean up any leftover URLs in text nodes
function cleanupLeftoverUrls(element, url) {
  if (!element || !url) return;
  
  try {
    // Sanitize the URL by removing newlines
    const sanitizedUrl = url.replace(/\r?\n/g, '');
    
    // Look for text nodes that might contain the URL
    const textNodes = getTextNodesIn(element);
    let found = false;
    
    // Determine the platform
    const platform = getCurrentPlatform();
    
    for (const node of textNodes) {
      if (node.nodeValue.includes(sanitizedUrl)) {
        // Check if the URL is part of an existing link
        let isInLink = false;
        let parent = node.parentNode;
        while (parent && parent !== element) {
          if (parent.tagName === 'A') {
            isInLink = true;
            break;
          }
          parent = parent.parentNode;
        }
        
        if (isInLink) {
          continue;
        }
        
        // Determine if this is a Jira or Asana URL
        const isJiraUrl = JIRA_URL_REGEX.test(sanitizedUrl);
        const isAsanaUrl = ASANA_URL_REGEX.test(sanitizedUrl);
        
        // Handle Jira URLs
        if (isJiraUrl) {
          // Extract the issue key from the URL
          const issueKey = extractIssueKey(sanitizedUrl);
          if (!issueKey) continue;
          
          // Get the cached title and issue type if available
          let displayText;
          let issueType = "Unknown";
          
          if (titleCache[sanitizedUrl]) {
            displayText = titleCache[sanitizedUrl].title;
            issueType = titleCache[sanitizedUrl].issueType;
          } else {
            displayText = `${issueKey}: Jira Issue`;
          }
          
          displayText = cleanDisplayText(displayText, sanitizedUrl, platform);
          
          // Create a range to replace just the URL text
          const range = document.createRange();
          const startIndex = node.nodeValue.indexOf(sanitizedUrl);
          range.setStart(node, startIndex);
          range.setEnd(node, startIndex + sanitizedUrl.length);
          
          if (platform === 'asana') {
            // Use the markdown-style syntax that Asana will auto-convert
            const markdownText = document.createTextNode(`[${displayText}](${sanitizedUrl})`);
            range.deleteContents();
            range.insertNode(markdownText);
          } else {
            // Create a Google Chat link element with the proper attributes
            const linkElement = document.createElement('a');
            linkElement.href = sanitizedUrl;
            linkElement.textContent = displayText;
            linkElement.setAttribute('data-is-hub-custom-hyperlink', 'true');
            linkElement.setAttribute('data-is-editable', 'true');
            linkElement.setAttribute('data-jira-extension-created', 'true');
            linkElement.setAttribute('data-issue-type', issueType);
            
            // Replace the URL with the link
            range.deleteContents();
            range.insertNode(linkElement);
          }
          
          found = true;
        }
        // Handle Asana URLs (only in Google Chat)
        else if (isAsanaUrl && platform === 'google-chat') {
          // Extract the task ID from the URL
          const taskIdMatch = sanitizedUrl.match(ASANA_TASK_ID_REGEX);
          const taskId = taskIdMatch ? taskIdMatch[1] : null;
          if (!taskId) continue;
          
          // Get the cached title if available
          let displayText;
          
          if (titleCache[sanitizedUrl]) {
            displayText = `✔️ ${titleCache[sanitizedUrl].title}`;
          } else {
            displayText = `✔️ Asana Task ${taskId}`;
          }
          
          // Create a range to replace just the URL text
          const range = document.createRange();
          const startIndex = node.nodeValue.indexOf(sanitizedUrl);
          range.setStart(node, startIndex);
          range.setEnd(node, startIndex + sanitizedUrl.length);
          
          // Create a Google Chat link element with the proper attributes
          const linkElement = document.createElement('a');
          linkElement.href = sanitizedUrl;
          linkElement.textContent = displayText;
          linkElement.setAttribute('data-is-hub-custom-hyperlink', 'true');
          linkElement.setAttribute('data-is-editable', 'true');
          linkElement.setAttribute('data-asana-extension-created', 'true');
          linkElement.setAttribute('data-issue-type', 'AsanaTask');
          
          // Replace the URL with the link
          range.deleteContents();
          range.insertNode(linkElement);
          
          found = true;
        }
      }
    }
    
    // For Asana, also look for plain text paragraphs that might contain Jira URLs
    if (platform === 'asana') {
      const paragraphs = element.querySelectorAll('p');
      for (const paragraph of paragraphs) {
        // Skip if this paragraph already has a link
        if (paragraph.querySelector('a')) continue;
        
        // Check if the paragraph text contains a Jira URL
        if (paragraph.textContent && paragraph.textContent.match(JIRA_URL_REGEX)) {
          const match = paragraph.textContent.match(JIRA_URL_REGEX);
          const url = match[0];
          const issueKey = extractIssueKey(url);
          
          if (issueKey) {
            // Get title and issue type
            let displayText;
            let issueType = "Unknown";
            
            if (titleCache[url]) {
              displayText = titleCache[url].title;
              issueType = titleCache[url].issueType;
            } else {
              displayText = `${issueKey}: Jira Issue`;
            }
            
            displayText = cleanDisplayText(displayText, url, 'asana');
            
            // Replace with markdown-style link
            paragraph.innerHTML = `[${displayText}](${url})`;
            paragraph.setAttribute('data-issue-type', issueType);
            
            found = true;
          }
        }
      }
    }
    
    if (found) {
      // Trigger events to ensure changes are recognized
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (error) {
    // Ignore errors
  }
}

// Function to initialize the extension
function initializeExtension() {
  // Prevent multiple initializations
  if (window._jiraLinkExtensionInitialized) {
    return;
  }
  
  const initTime = Date.now();
  const platform = getCurrentPlatform();
  
  if (platform === 'unknown') {
    return;
  }
  
  // Clear any existing timeouts and intervals to avoid duplicate handlers
  clearAllTimeoutsAndIntervals();
  
  // Remove any existing paste event listeners before adding a new one
  try {
    document.removeEventListener('paste', handlePasteEvent, true);
    document.removeEventListener('paste', handlePasteEvent, false);
  } catch (e) {
    // Ignore errors
  }
  
  // Add event listener for paste events on the document
  document.addEventListener('paste', handlePasteEvent, true);
  
  // Set up a periodic check for any pending elements that need updating
  const updateInterval = setInterval(updatePendingLinks, 250);
  window._jiraLinkUpdateInterval = updateInterval;
  
  // Set up periodic monitoring of the send button (only needed for Google Chat)
  if (platform === 'google-chat') {
    const sendButtonInterval = setInterval(monitorSendButton, 2000);
    window._jiraSendButtonInterval = sendButtonInterval;
  }
  
  // Add a visual indicator if in debug mode
  if (DEBUG) {
    addVisibleIndicator();
  }
  
  // Set up cleanup on page unload
  window.addEventListener('beforeunload', () => {
    clearAllTimeoutsAndIntervals();
  });
  
  // Do an initial cleanup after a short delay to catch any links that might exist
  // at startup (e.g., when refreshing the page with existing links)
  setTimeout(() => {
    // Find all editable elements
    const editableElements = document.querySelectorAll('[contenteditable="true"]');
    for (const el of editableElements) {
      // Check for any bare URLs that might need to be converted to links
      const textNodes = getTextNodesIn(el);
      for (const node of textNodes) {
        const text = node.nodeValue;
        const jiraUrlMatch = text.match(JIRA_URL_REGEX);
        if (jiraUrlMatch) {
          const url = jiraUrlMatch[0];
          // Cleanup the URL in place
          cleanupLeftoverUrls(el, url);
        }
      }
    }
  }, 1000);
  
  // Mark as initialized with timestamp
  window._jiraLinkExtensionInitialized = true;
  window._jiraLinkExtensionInitializedAt = initTime;
}

// Handle iframes - need to wait for them to load
function setupIframeListeners() {
  // Function to handle new iframes
  const handleIframe = (iframe) => {
    try {
      // Skip if already processed
      if (iframe._jiraLinkIframeProcessed) return;
      iframe._jiraLinkIframeProcessed = true;
      
      // Wait for iframe to load
      if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
        initPasteListeners(iframe.contentDocument);
      } else {
        iframe.addEventListener('load', () => {
          try {
            initPasteListeners(iframe.contentDocument);
          } catch (err) {
            // This might fail due to cross-origin restrictions
          }
        });
      }
    } catch (err) {
      // Probably a cross-origin iframe, can't access
    }
  };
  
  // Handle existing iframes
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach(handleIframe);
  
  // Observer for new iframes
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if (mutation.addedNodes) {
        mutation.addedNodes.forEach(node => {
          if (node.tagName === 'IFRAME') {
            handleIframe(node);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Check for iframes inside the added node
            const childIframes = node.querySelectorAll('iframe');
            childIframes.forEach(iframe => {
              handleIframe(iframe);
            });
          }
        });
      }
    });
  });
  
  // Start observing
  observer.observe(document.body, { childList: true, subtree: true });
}

// Function to paste a formatted link specifically for Asana
function pasteFormattedLinkAsana(element, url, displayText, issueType = "Unknown") {
  const pasteId = Date.now() + Math.random().toString(36).substring(2, 8);
  debugLog(`[${pasteId}] Pasting formatted link in Asana with text: ${displayText}`);
  
  // Thoroughly clean the display text to remove URLs and fix duplicate issue keys
  displayText = cleanDisplayText(displayText, url, 'asana');
  
  debugLog(`[${pasteId}] Using cleaned display text for Asana: ${displayText}`);
  
  try {
    // Most direct approach - use Asana's Markdown-like syntax to force link creation
    const markdownLink = `[${displayText}](${url})`;
    debugLog(`[${pasteId}] Trying Markdown approach: ${markdownLink}`);
    
    // First focus the element
    element.focus();
    
    // Use execCommand to insert the text
    document.execCommand('insertText', false, markdownLink);
    
    // Trigger events
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Asana should automatically convert this to a proper link
    
    // If Markdown approach might not work immediately, try alternative direct HTML insertion
    setTimeout(() => {
      // Check if our link was properly created
      const links = element.querySelectorAll('a.ProsemirrorEditor-link');
      const justCreated = Array.from(links).some(link => 
        link.href === url || link.href.includes(url)
      );
      
      if (!justCreated) {
        debugLog(`[${pasteId}] Markdown approach may not have worked, trying HTML approach`);
        
        // Try direct HTML approach as a fallback
        try {
          // Use execCommand to insert HTML
          const html = `<p class="ProsemirrorEditor-paragraph"><a href="${url}" class="ProsemirrorEditor-link">${displayText}</a></p>`;
          document.execCommand('insertHTML', false, html);
          
          // Trigger events again
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
          debugLog(`[${pasteId}] HTML fallback failed: ${e.message}`);
        }
      }
    }, 50);
    
    return true;
  } catch (error) {
    debugLog(`[${pasteId}] Error pasting formatted link in Asana: ${error.message}`);
    
    // Last resort - try using a Markdown-like syntax directly
    try {
      const markdownLink = `[${displayText}](${url})`;
      element.focus();
      document.execCommand('insertText', false, markdownLink);
      
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      debugLog(`[${pasteId}] Last resort failed: ${e.message}`);
      return false;
    }
  }
}

// Function to replace the last pasted Jira link in Asana
function replaceLastPastedJiraLinkAsana(element, oldText, url, newText, issueType = "Unknown") {
  debugLog(`Replacing in Asana: "${oldText}" with "${newText}" for URL: ${url}, type: ${issueType}`);
  
  // Clean the new text to ensure no URLs or duplicate issue keys
  newText = cleanDisplayText(newText, url, 'asana');
  
  debugLog(`Using cleaned new text for Asana: ${newText}`);
  
  try {
    // Look for the issue with partial links in Asana paragraphs
    const paragraphs = element.querySelectorAll('p.ProsemirrorEditor-paragraph');
    for (const paragraph of paragraphs) {
      // Check if this paragraph has a partial link - where the link doesn't contain the full text
      const links = paragraph.querySelectorAll('a.ProsemirrorEditor-link');
      if (links.length > 0) {
        for (const link of links) {
          // Check if this is our link (by URL) but the text is incomplete
          if ((link.href === url || link.href.includes(url)) && 
              (link.textContent !== newText && paragraph.textContent.includes(newText.split(':')[0]))) {
            
            debugLog(`Found partial link that needs fixing`);
            
            // Save selection state
            const selection = window.getSelection();
            let savedSelection = null;
            if (selection.rangeCount > 0) {
              savedSelection = selection.getRangeAt(0).cloneRange();
            }
            
            // Replace the entire paragraph content with proper markdown link
            paragraph.innerHTML = `[${newText}](${url})`;
            
            // Also add the issue type as a data attribute
            paragraph.setAttribute('data-issue-type', issueType);
            
            debugLog(`Fixed partial link by replacing entire paragraph with markdown link`);
            
            // Trigger events to ensure Asana processes the change
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            
            // Restore selection if we saved it
            if (savedSelection) {
              selection.removeAllRanges();
              selection.addRange(savedSelection);
            }
            
            return true;
          }
        }
      }
    }
    
    // First try to find and update existing links properly created by Asana
    const asanaLinks = element.querySelectorAll('a.ProsemirrorEditor-link');
    if (asanaLinks.length > 0) {
      for (const link of asanaLinks) {
        if (link.href === url || 
            link.href.includes(url) || 
            link.textContent === oldText || 
            link.textContent.includes(oldText) ||
            link.textContent.includes(newText.split(':')[0])) {
          // Look for partial links - check if link is inside paragraph with more text
          const parentParagraph = link.closest('p.ProsemirrorEditor-paragraph');
          if (parentParagraph && parentParagraph.textContent !== link.textContent) {
            // This is likely a partial link, fix the entire paragraph
            parentParagraph.innerHTML = `[${newText}](${url})`;
            parentParagraph.setAttribute('data-issue-type', issueType);
            debugLog(`Fixed partial link in paragraph`);
          } else {
            // Just update the link text normally
            link.textContent = newText;
            link.setAttribute('data-issue-type', issueType);
            debugLog(`Updated existing Asana link text`);
          }
          
          // Trigger events
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }
    
    // If no paragraphs found with the temporary text, look for text nodes
    const textNodes = getTextNodesIn(element);
    for (const node of textNodes) {
      if (node.nodeValue.includes(oldText) || node.nodeValue.includes(url)) {
        // Create a range to replace the text
        const range = document.createRange();
        let startIndex;
        if (node.nodeValue.includes(oldText)) {
          startIndex = node.nodeValue.indexOf(oldText);
          range.setStart(node, startIndex);
          range.setEnd(node, startIndex + oldText.length);
        } else {
          startIndex = node.nodeValue.indexOf(url);
          range.setStart(node, startIndex);
          range.setEnd(node, startIndex + url.length);
        }
        
        // Delete the existing content
        range.deleteContents();
        
        // Insert the markdown-style link
        const linkText = document.createTextNode(`[${newText}](${url})`);
        range.insertNode(linkText);
        
        // Try to add the issue type attribute to the parent element
        let parent = node.parentNode;
        if (parent) {
          parent.setAttribute('data-issue-type', issueType);
        }
        
        debugLog(`Replaced text node with markdown-style link text, type: ${issueType}`);
        
        // Trigger events
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        
        return true;
      }
    }
    
    // Last resort - extract the issue key and look for any elements containing it
    const issueKey = extractIssueKey(url);
    if (issueKey) {
      // Find any elements containing the issue key
      const elements = element.querySelectorAll('*');
      for (const el of elements) {
        if (el.textContent.includes(issueKey)) {
          // Clear the element and insert the markdown-style link
          el.innerHTML = `[${newText}](${url})`;
          el.setAttribute('data-issue-type', issueType);
          
          debugLog(`Last resort: Replaced element containing issue key with markdown link, type: ${issueType}`);
          
          // Trigger events
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          
          return true;
        }
      }
    }
    
    debugLog(`Failed to find element to update in Asana`);
    return false;
  } catch (error) {
    debugLog(`Error replacing link in Asana: ${error.message}`);
    return false;
  }
} 

// Function to replace plain text with a fully formatted link in Asana
function replaceTextWithLink(element, textToReplace, url, displayText, issueType = "Unknown") {
  try {
    // Sanitize the URL by removing newlines
    const sanitizedUrl = url.replace(/\r?\n/g, '');
    
    // First find all text nodes or elements that might contain our text
    const paragraphs = element.querySelectorAll('p.ProsemirrorEditor-paragraph');
    let found = false;
    
    // First check paragraphs that directly contain our text
    for (const paragraph of paragraphs) {
      if (paragraph.textContent && paragraph.textContent.includes(textToReplace)) {
        // Create the markdown-style link
        const markdownLink = `[${displayText}](${sanitizedUrl})`;
        
        // Remember selection state
        const selection = window.getSelection();
        let savedRange = null;
        if (selection.rangeCount > 0) {
          savedRange = selection.getRangeAt(0).cloneRange();
        }
        
        // Replace the entire paragraph content to ensure a clean link
        paragraph.innerHTML = markdownLink;
        paragraph.setAttribute('data-issue-type', issueType);
        
        // Dispatch events to ensure Asana processes the change
        paragraph.dispatchEvent(new Event('input', { bubbles: true }));
        paragraph.dispatchEvent(new Event('change', { bubbles: true }));
        
        // If we had a selection, try to restore it
        if (savedRange) {
          try {
            selection.removeAllRanges();
            selection.addRange(savedRange);
          } catch (e) {
            // Ignore error
          }
        }
        
        found = true;
        break;
      }
    }
    
    // If we didn't find it in paragraphs, look for text nodes
    if (!found) {
      const textNodes = getTextNodesIn(element);
      for (const node of textNodes) {
        if (node.nodeValue && node.nodeValue.includes(textToReplace)) {
          // Create a range for replacement
          const range = document.createRange();
          const startIndex = node.nodeValue.indexOf(textToReplace);
          range.setStart(node, startIndex);
          range.setEnd(node, startIndex + textToReplace.length);
          
          // Delete the existing content
          range.deleteContents();
          
          // Create a text node with the markdown link
          const markdownText = document.createTextNode(`[${displayText}](${sanitizedUrl})`);
          range.insertNode(markdownText);
          
          // Try to add the issue type to a parent element
          let parent = node.parentNode;
          if (parent) {
            parent.setAttribute('data-issue-type', issueType);
          }
          
          // Dispatch events to ensure Asana processes the change
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          
          found = true;
          break;
        }
      }
    }
    
    // If we still haven't found it, try a broader approach with all elements
    if (!found) {
      // Last resort - look through all elements for any containing our text
      const allElements = element.querySelectorAll('*');
      for (const el of allElements) {
        if (el.textContent && el.textContent.includes(textToReplace)) {
          // Replace with markdown link
          el.innerHTML = `[${displayText}](${sanitizedUrl})`;
          el.setAttribute('data-issue-type', issueType);
          
          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          
          found = true;
          break;
        }
      }
    }
    
    return found;
  } catch (error) {
    return false;
  }
}

// Helper function to track elements for title updates
function trackElementForTitleUpdate(element, url, tempText, platform) {
  // Sanitize the URL by removing newlines
  const sanitizedUrl = url ? url.replace(/\r?\n/g, '') : url;
  
  const key = getElementKey(element);
  pendingElements.set(key, {
    element: element,
    url: sanitizedUrl,
    tempText: tempText,
    timestamp: Date.now(),
    attempts: 0,
    platform: platform
  });
}