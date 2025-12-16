// Cache for storing fetched Jira titles and issue types
const titleCache = {}; // URL -> { title, issueType }

// Debug flag - set to false for production
const DEBUG = false;

// Force refresh of titles (for testing purposes)
const FORCE_REFRESH = false;

// Background script startup
// console.log("BACKGROUND SCRIPT STARTED - Jira Link Beautifier");

// Clear the cache on startup if in debug mode
if (DEBUG && FORCE_REFRESH) {
  // console.log("DEBUG MODE: Clearing title cache on startup");
  Object.keys(titleCache).forEach(key => {
    delete titleCache[key];
  });
}

// Track authentication status for different services
const authStatus = {
  asana: {
    authenticated: false,
    pendingTasks: new Map(), // Map of URLs to callbacks waiting for authentication
    lastAuthAttempt: 0
  },
  jira: {
    authenticated: false,
    pendingTasks: new Map(),
    lastAuthAttempt: 0
  }
};

// Function to retry pending fetch tasks after authentication
function retryPendingTasks(service) {
  console.log(`Retrying pending ${service} tasks after authentication`);
  const pendingTasks = authStatus[service].pendingTasks;
  
  // Clone the map to avoid modification during iteration
  const tasks = new Map(pendingTasks);
  
  // Clear pending tasks
  pendingTasks.clear();
  
  // Set authenticated status
  authStatus[service].authenticated = true;
  authStatus[service].lastAuthAttempt = Date.now();
  
  // Retry each task
  tasks.forEach((callback, url) => {
    console.log(`Retrying fetch for ${url}`);
    callback();
  });
}

// Listen for tab updates to detect when authentication is complete
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try {
    // Check if a tab has completed loading
    if (changeInfo.status === 'complete' && tab.url) {
      // For Asana authentication
      if (tab.url.includes('app.asana.com')) {
        // If we're on a task page and not a login page, we're authenticated
        if (!tab.url.includes('login') && 
            (tab.url.includes('/0/') || tab.url.match(/\/\d+\/\d+$/))) {
          console.log('Detected authenticated Asana tab loaded:', tab.url);
          retryPendingTasks('asana');
          
          // After a short delay, check if the tab title contains useful information
          setTimeout(() => {
            chrome.tabs.get(tabId, updatedTab => {
              if (updatedTab.title && 
                  !updatedTab.title.includes('Redirecting') && 
                  !updatedTab.title.includes('Asana')) {
                console.log(`Found task title in tab: "${updatedTab.title}"`);
                
                // Extract the task ID from the URL
                const taskIdMatch = tab.url.match(/\/(\d+)(?:\/f)?$/);
                if (taskIdMatch && taskIdMatch[1]) {
                  const taskId = taskIdMatch[1];
                  
                  // Store this title in our cache
                  titleCache[tab.url] = {
                    title: updatedTab.title,
                    issueType: 'AsanaTask'
                  };
                  
                  // Notify content scripts about the new title
                  chrome.tabs.query({}, allTabs => {
                    allTabs.forEach(contentTab => {
                      try {
                        chrome.tabs.sendMessage(contentTab.id, {
                          action: 'titleUpdated',
                          url: tab.url,
                          title: updatedTab.title,
                          issueType: 'AsanaTask'
                        });
                      } catch (err) {
                        // Ignore errors when sending to tabs
                      }
                    });
                  });
                }
              }
            });
          }, 1000);
        }
      } 
      // For Jira authentication
      else if (tab.url.includes('atlassian.net')) {
        if (!tab.url.includes('login') && 
            (tab.url.includes('/browse/') || tab.url.includes('/issues/'))) {
          console.log('Detected authenticated Jira tab loaded:', tab.url);
          retryPendingTasks('jira');
        }
      }
    }
  } catch (error) {
    console.error('Error in tab update listener:', error);
  }
});

function debugLog(message) {
  if (DEBUG) {
    console.log(`[Jira Link Beautifier BG] ${message}`);
    // Also try error console for visibility
    console.error(`[Jira Link Beautifier BG] ${message}`);
  }
}

// Helper function to extract the issue key from a URL
function extractIssueKeyFromUrl(url) {
  // Try to match selectedIssue query parameter first
  const selectedIssueMatch = url.match(/[?&]selectedIssue=([A-Z]+-\d+)/i);
  if (selectedIssueMatch) return selectedIssueMatch[1];

  // Try to match both /browse/KEY-123 and /issues/KEY-123 patterns
  const match = url.match(/\/(?:browse|issues)\/([A-Z]+-\d+)(?:\?|$|\/)/);
  if (match) return match[1];

  // Fallback: Match any pattern that looks like an issue key
  const simpleMatch = url.match(/([A-Z]+-\d+)/);
  return simpleMatch ? simpleMatch[1] : null;
}

// Helper function to normalize Jira URL by removing query parameters
// This helps with cache lookups when the same issue is accessed via different routes
function normalizeJiraUrl(url) {
  if (!url) return url;
  
  // Extract the issue key
  const issueKey = extractIssueKeyFromUrl(url);
  if (!issueKey) return url;
  
  // For Jira URLs, construct a clean URL without query params
  if (url.includes('/browse/') || url.includes('/issues/')) {
    try {
      const urlObj = new URL(url);
      const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      // Determine which path format is used
      if (url.includes('/browse/')) {
        return `${baseUrl}/browse/${issueKey}`;
      } else if (url.includes('/issues/')) {
        return `${baseUrl}/issues/${issueKey}`;
      }
    } catch (e) {
      // If URL parsing fails, return original
      return url;
    }
  }
  
  return url;
}

// Clean the title to ensure it doesn't contain the URL
function cleanTitle(title, url, issueKey) {
  if (!title) return null;
  
  // If the title contains the URL, remove it
  if (title.includes(url)) {
    title = title.replace(url, '').trim();
    // If that results in text starting with a colon or whitespace, clean it up
    title = title.replace(/^[\s:]+/, '');
  }
  
  // Also check for the domain part without protocol
  const domainPart = url.replace(/^https?:\/\//, '');
  if (title.includes(domainPart)) {
    title = title.replace(domainPart, '').trim();
    title = title.replace(/^[\s:]+/, '');
  }
  
  // If we have an issue key, check for duplicate issue keys
  if (issueKey) {
    // Check for issue key at the beginning and in the middle
    const doubleKeyPattern = new RegExp(`${issueKey}\\s*${issueKey}`, 'i');
    if (doubleKeyPattern.test(title)) {
      title = title.replace(doubleKeyPattern, issueKey);
    }
    
    // Make sure the title starts with the issue key
    if (!title.match(new RegExp(`^\\s*${issueKey}`, 'i'))) {
      title = `${issueKey}: ${title.replace(/^[\s:]+/, '')}`;
    }
  }
  
  return title.trim();
}

// Function to fetch a Jira title via the REST API
async function fetchJiraTitleViaAPI(url) {
  try {
    // Extract the issue key from the URL
    const issueKey = extractIssueKeyFromUrl(url);
    if (!issueKey) {
      console.log('Could not extract issue key from URL:', url);
      return { title: null, issueType: "Unknown" };
    }
    
    // Construct the API URL - this works for both Atlassian Cloud and Server instances
    // We need to handle both /browse/ and /issues/ paths
    let baseUrl;
    if (url.includes('/browse/')) {
      baseUrl = url.split('/browse/')[0];
    } else if (url.includes('/issues/')) {
      baseUrl = url.split('/issues/')[0];
    } else {
      // If we can't determine the base URL, try to extract it from the domain
      const urlObj = new URL(url);
      baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
    }
    
    const apiUrl = `${baseUrl}/rest/api/2/issue/${issueKey}`;
    debugLog(`Constructed API URL: ${apiUrl} from base URL: ${baseUrl} and issue key: ${issueKey}`);
    
    // Make the request
    const response = await fetch(apiUrl);
    
    // Check if we're authenticated
    if (response.status === 401 || response.status === 403) {
      console.log('Not authenticated for Jira API, opening auth tab');
      // Open a new tab for authentication - this will prompt the user to login
      chrome.tabs.create({ url: url, active: false });
      // Return a simple title with the issue key
      return { 
        title: `${issueKey}: Jira Issue`, 
        issueType: "Unknown"
      };
    }
    
    // Check if the response is ok
    if (!response.ok) {
      console.log('API request failed with status:', response.status);
      return { title: null, issueType: "Unknown" };
    }
    
    // Parse the JSON response
    const data = await response.json();
    
    // Extract the issue type from the API response with more detailed logging
    let issueType = "Unknown";
    
    try {
      if (data.fields && data.fields.issuetype) {
        if (data.fields.issuetype.name) {
          issueType = data.fields.issuetype.name;
          debugLog(`Extracted issue type name from API: "${issueType}"`);
        } else {
          debugLog(`issuetype exists but has no name property: ${JSON.stringify(data.fields.issuetype)}`);
        }
      } else {
        debugLog(`No issuetype field found in API response: ${JSON.stringify(data.fields).substring(0, 200)}...`);
      }
    } catch (e) {
      debugLog(`Error extracting issue type from API: ${e.message}`);
    }
    
    debugLog(`Final issue type from API: ${issueType}`);
    
    // Extract the summary field which contains the issue title
    const summary = data.fields?.summary;
    
    if (summary) {
      // Construct a title with the issue key and summary
      const title = `${issueKey}: ${summary}`;
      return { 
        title: cleanTitle(title, url, issueKey),
        issueType
      };
    }
    
    return { title: null, issueType };
  } catch (error) {
    console.error('Error fetching Jira title via API:', error);
    return { title: null, issueType: "Unknown" };
  }
}

// Function to fetch the title via a regular HTML request
async function fetchJiraTitleViaHTML(url) {
  try {
    // Try to extract issue key from URL first - we'll need it regardless
    const urlIssueKey = extractIssueKeyFromUrl(url);
    if (!urlIssueKey) {
      debugLog(`Could not extract issue key from URL: ${url}`);
      return { title: "Jira Issue", issueType: "Unknown" };
    }
    
    debugLog(`Extracted issue key from URL: ${urlIssueKey}`);
    
    // Normalize URL to browse format which is more reliable
    let apiBaseUrl;
    if (url.includes('/browse/')) {
      apiBaseUrl = url.split('/browse/')[0];
    } else if (url.includes('/issues/')) {
      apiBaseUrl = url.split('/issues/')[0];
      // Change URL to browse format for more reliable title extraction
      url = `${apiBaseUrl}/browse/${urlIssueKey}`;
      debugLog(`Normalized URL to browse format: ${url}`);
    } else {
      // Extract domain if we can't determine base URL
      const urlObj = new URL(url);
      apiBaseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      url = `${apiBaseUrl}/browse/${urlIssueKey}`;
      debugLog(`Constructed browse URL: ${url}`);
    }
    
    // Make the request
    const response = await fetch(url);
    
    // Check if we're authenticated
    if (response.status === 401 || response.status === 403) {
      console.log('Not authenticated for Jira, opening auth tab');
      // Open a new tab for authentication
      chrome.tabs.create({ url: url, active: false });
      // Extract the issue key from the URL as a fallback
      const issueKey = extractIssueKeyFromUrl(url);
      return { 
        title: issueKey ? `${issueKey}: Jira Issue` : "Jira Issue", 
        issueType: "Unknown"
      };
    }
    
    // Check if the response is ok
    if (!response.ok) {
      console.log('HTML request failed with status:', response.status);
      return { title: null, issueType: "Unknown" };
    }
    
    // Get the response text
    const html = await response.text();
    
    // Extract the issue type from the HTML
    const issueType = detectIssueType(html);
    debugLog(`Detected issue type: ${issueType}`);
    
    // Extract the title
    const titleMatch = html.match(/<title>(?:\[([A-Z]+-\d+)\])?(.+?)(?: - .+)?<\/title>/i);
    if (titleMatch) {
      let titleIssueKey = titleMatch[1];
      let pageTitle = titleMatch[2].trim();
      
      // Check if the title is "Issue navigator" or similar generic titles
      // and avoid using them as the actual issue title
      if (pageTitle === "Issue navigator" || 
          pageTitle === "Dashboard" || 
          pageTitle === "Issues" || 
          pageTitle.includes("Issue Search")) {
        
        debugLog(`Found generic page title: "${pageTitle}" - will use issue key and fetch from API instead`);
        
        // Always use the issue key from the URL since we've verified it exists
        return { 
          title: `${urlIssueKey}: Jira Issue`, 
          issueType 
        };
      }
      
      // If the title didn't have the issue key in brackets, use the one from the URL
      if (!titleIssueKey) {
        titleIssueKey = urlIssueKey;
      }
      
      // Construct the full title
      const title = `${titleIssueKey}: ${pageTitle}`;
      return { 
        title: cleanTitle(title, url, titleIssueKey),
        issueType
      };
    }
    
    // Fallback to using the issue key from the URL
    return { 
      title: `${urlIssueKey}: Jira Issue`, 
      issueType
    };
  } catch (error) {
    console.error('Error fetching Jira title via HTML:', error);
    return { title: null, issueType: "Unknown" };
  }
}

// Function to detect the issue type from HTML
function detectIssueType(html) {
  try {
    // Check if it's a Confluence page first (different from Jira issues)
    if (html.includes('<meta name="application-name" content="Confluence"') || 
        html.includes('id="com-atlassian-confluence"') ||
        html.includes('confluence-dashboard-container')) {
      return "Confluence Page";
    }
    
    // Look for the issue type button with aria-label - most reliable method
    const changeTypeButtonMatch = html.match(/aria-label="([^"]+) - Change issue type"/i);
    if (changeTypeButtonMatch && changeTypeButtonMatch[1]) {
      const detectedType = changeTypeButtonMatch[1];
      debugLog(`Detected issue type from aria-label: ${detectedType}`);
      return detectedType; // Could be "Story", "Epic", "Task", "Bug", etc.
    }
    
    // Look for alt attribute in issue type image - second best method
    const imgAltMatch = html.match(/<img[^>]*alt="(Story|Epic|Task|Bug|Subtask)"[^>]*>/i);
    if (imgAltMatch && imgAltMatch[1]) {
      debugLog(`Detected issue type from img alt: ${imgAltMatch[1]}`);
      return imgAltMatch[1];
    }
    
    // Look for data-testid with issue type
    const testIdMatch = html.match(/data-testid="issue\.views\.issue-base\.foundation\.issue-type\.issue-type-([^"]+)"/i);
    if (testIdMatch && testIdMatch[1]) {
      // Convert dash case to proper case (e.g., "user-story" to "User Story")
      const type = testIdMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      debugLog(`Detected issue type from data-testid: ${type}`);
      return type;
    }
    
    // Check for API response patterns in embedded JSON
    if (html.includes('"issuetype-field-value":"Epic"') || 
        html.includes('data-issue-type="Epic"') ||
        html.includes('"issuetype":{"name":"Epic"')) {
      debugLog('Detected Epic from embedded JSON/attributes');
      return "Epic";
    } else if (html.includes('"issuetype-field-value":"Story"') || 
               html.includes('data-issue-type="Story"') ||
               html.includes('"issuetype":{"name":"Story"') ||
               html.includes('"issuetype":{"name":"User Story"')) {
      debugLog('Detected Story from embedded JSON/attributes');
      return "Story";
    } else if (html.includes('"issuetype-field-value":"Bug"') || 
               html.includes('data-issue-type="Bug"') ||
               html.includes('"issuetype":{"name":"Bug"')) {
      debugLog('Detected Bug from embedded JSON/attributes');
      return "Bug";
    } else if (html.includes('"issuetype-field-value":"Task"') || 
               html.includes('data-issue-type="Task"') ||
               html.includes('"issuetype":{"name":"Task"')) {
      debugLog('Detected Task from embedded JSON/attributes');
      return "Task";
    }
    
    // If we can't determine the type, look for secondary indicators
    if (html.includes('bug') && html.includes('issue-type')) {
      debugLog('Detected Bug from secondary indicators');
      return "Bug";
    } else if (html.includes('epic') && html.includes('issue-type')) {
      debugLog('Detected Epic from secondary indicators');
      return "Epic";
    } else if (html.includes('story') && html.includes('issue-type')) {
      debugLog('Detected Story from secondary indicators');
      return "Story";
    } else if (html.includes('task') && html.includes('issue-type')) {
      debugLog('Detected Task from secondary indicators');
      return "Task";
    }
    
    // If we can't determine the type, return Unknown
    debugLog('Could not detect issue type, returning Unknown');
    return "Unknown";
  } catch (error) {
    console.error("Error detecting issue type:", error);
    return "Unknown";
  }
}

// Function to fetch Asana task title via HTML
async function fetchAsanaTaskTitle(url, taskId) {
  try {
    console.log(`Fetching Asana task title for URL: ${url}, task ID: ${taskId}`);
    
    // Try a more direct approach to get the task name via Asana API
    let baseUrl;
    
    // Check the URL format to determine the base URL
    if (url.includes('app.asana.com')) {
      // For all Asana URLs, just use the base domain
      baseUrl = 'https://app.asana.com';
    } else {
      // Fallback - use domain from URL
      baseUrl = url.split('/').slice(0, 3).join('/');
    }
    
    const apiUrl = `${baseUrl}/api/1.0/tasks/${taskId}`;
    
    console.log(`Trying to fetch Asana task data from API endpoint: ${apiUrl}`);
    try {
      const apiResponse = await fetch(apiUrl, {
        credentials: 'include', // Include cookies for authentication
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      
      if (apiResponse.ok) {
        const data = await apiResponse.json();
        console.log('API response data:', data);
        
        if (data && data.data && data.data.name) {
          const title = data.data.name.trim();
          console.log(`Successfully fetched Asana task title via API: "${title}"`);
          return { title, issueType: "AsanaTask" };
        }
      } else {
        console.log(`API request failed with status: ${apiResponse.status}`);
      }
    } catch (apiError) {
      console.log(`Error fetching from API endpoint: ${apiError.message}`);
    }
    
    // If the API approach fails, try the standard HTML approach
    // Construct a direct task URL to improve the chances of getting the title
    let directUrl = url;
    if (url.includes('/project/') && url.includes('/task/')) {
      // For project/task URLs, construct a simpler URL
      directUrl = `${baseUrl}/0/0/${taskId}`;
      console.log(`Constructed direct task URL: ${directUrl}`);
    }
    
    // Make the request to the Asana task URL with redirect follow
    const response = await fetch(directUrl, {
      redirect: 'follow',
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml',
        'User-Agent': 'Mozilla/5.0 Chrome Extension'
      }
    });
    
    // Check if we're being redirected to a login page
    if (response.status === 301 || response.status === 302 || response.status === 303 || 
        response.status === 307 || response.status === 308 || 
        response.url.includes('login') || response.url.includes('auth')) {
      console.log('Detected redirect to authentication page');
      return openAuthTab(url, taskId);
    }
    
    // Check if we're not authorized
    if (response.status === 401 || response.status === 403) {
      console.log('Not authenticated for Asana');
      return openAuthTab(url, taskId);
    }
    
    // Check if the response is ok
    if (!response.ok) {
      console.log(`HTML request failed with status: ${response.status}`);
      return openAuthTab(url, taskId);
    }
    
    // Get the response text
    const html = await response.text();
    console.log(`Received HTML response, length: ${html.length} characters`);
    
    // If the response contains terms related to redirection or login, trigger authentication
    if (html.includes('redirecting') || html.includes('Redirecting') || 
        html.includes('login') || html.includes('Log in') || 
        html.includes('Sign in') || html.includes('authentication')) {
      console.log('HTML content indicates authentication required');
      return openAuthTab(url, taskId);
    }
    
    // Look for JSON data in the page that might contain the task name
    const jsonDataMatch = html.match(/\bwindow\.asana\s*=\s*(\{.+?\});/s) || 
                          html.match(/\bASANA\s*=\s*(\{.+?\});/s) ||
                          html.match(/\bdata\s*=\s*(\{.+?\});/s);
    
    if (jsonDataMatch && jsonDataMatch[1]) {
      try {
        const jsonData = JSON.parse(jsonDataMatch[1]);
        console.log('Found JSON data in page:', jsonData);
        
        // Try to find the task name in the extracted JSON
        if (jsonData.resources && jsonData.resources.tasks) {
          const task = jsonData.resources.tasks[taskId];
          if (task && task.name) {
            console.log(`Found task name in JSON data: "${task.name}"`);
            return { title: task.name, issueType: "AsanaTask" };
          }
        }
      } catch (jsonError) {
        console.log(`Error parsing JSON data: ${jsonError.message}`);
      }
    }
    
    // Try to extract the task title
    // First look for title tag
    let titleMatch = html.match(/<title>([^<]+)(?:\s*\|\s*Asana)?<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      const title = titleMatch[1].trim();
      // Skip if the title is just "Redirecting" or similar
      if (title.toLowerCase().includes('redirect') || title.length < 5) {
        console.log(`Found a redirect title: "${title}"`);
        return openAuthTab(url, taskId);
      }
      console.log(`Found Asana task title from title tag: "${title}"`);
      return { title, issueType: "AsanaTask" };
    }
    
    // Try to find task name in the page content using common patterns
    const patterns = [
      /name":"([^"]+?)","notes/i,
      /task-name[^>]*>([^<]+)</,
      /task_name[^:]*:"([^"]+)"/,
      /"name":"([^"]+?)"/,
      /"Task Name"[^>]*>([^<]+)</,
      /data-task-name="([^"]+)"/
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const title = match[1].trim();
        // Skip titles that are too short or generic
        if (title.length < 3 || title.toLowerCase().includes('redirect')) {
          continue;
        }
        console.log(`Found Asana task title using pattern ${pattern}: "${title}"`);
        return { title, issueType: "AsanaTask" };
      }
    }
    
    // If still no match, look for any JSON data that might contain the task name
    const jsonMatch = html.match(/\{"data":[^\}]+,"name":"([^"]+?)"/);
    if (jsonMatch && jsonMatch[1]) {
      const title = jsonMatch[1].trim();
      console.log(`Found Asana task title from JSON data: "${title}"`);
      return { title, issueType: "AsanaTask" };
    }
    
    // If we couldn't extract a title, open an auth tab
    console.log(`Could not extract task title, may need authentication.`);
    return openAuthTab(url, taskId);
  } catch (error) {
    console.error('Error fetching Asana task title:', error);
    console.log('Opening auth tab due to error');
    return openAuthTab(url, taskId);
  }
}

// Function to show a notification to the user
function showNotification(title, message) {
  // Check if the notifications permission is granted
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'images/icon128.png',
    title: title,
    message: message,
    priority: 2
  });
}

// Function to open authentication tab with notification
function openAuthTab(url, taskId, service = 'asana') {
  console.log(`Opening authentication tab for: ${url}`);
  
  // Check if we've recently attempted authentication
  const now = Date.now();
  const lastAttempt = authStatus[service].lastAuthAttempt;
  
  // If we've tried to authenticate in the last 30 seconds, don't open another tab
  if (now - lastAttempt < 30000) {
    console.log(`Authentication attempt already in progress for ${service}, not opening another tab`);
  } else {
    // Open a new tab for authentication
    chrome.tabs.create({ url: url, active: false });
    
    // Show a notification to the user
    showNotification(
      'Authentication Required',
      `A tab has been opened for ${service} authentication. Please sign in to load task titles.`
    );
    
    // Update last auth attempt time
    authStatus[service].lastAuthAttempt = now;
  }
  
  // Register this task for retry after authentication
  const retryCallback = () => {
    console.log(`Retrying fetch for ${url} after authentication`);
    
    // Wait a bit for authentication to fully process
    setTimeout(() => {
      if (service === 'asana') {
        fetchAsanaTaskTitle(url, taskId)
          .then(result => {
            if (result && result.title && !result.title.startsWith(`${service} Task`)) {
              console.log(`Successfully fetched title after authentication: ${result.title}`);
              
              // Check if it's just a generic "Asana" title
              if (result.title === "Asana" || 
                  result.title === "Asana Task" || 
                  result.title === "Asana Project" ||
                  result.title === "Redirecting") {
                
                console.log(`Got generic Asana title "${result.title}", using fallback with task ID`);
                const fallbackTitle = `Asana Task ${taskId}`;
                
                // Cache the fallback title
                titleCache[url] = {
                  title: fallbackTitle,
                  issueType: "AsanaTask"
                };
                
                sendResponse({ 
                  title: fallbackTitle, 
                  issueType: "AsanaTask" 
                });
                return;
              }
              
              // Cache the title
              titleCache[url] = {
                title: result.title,
                issueType: result.issueType
              };
              
              // Notify the content script about the new title
              chrome.tabs.query({}, tabs => {
                tabs.forEach(tab => {
                  try {
                    chrome.tabs.sendMessage(tab.id, {
                      action: 'titleUpdated',
                      url: url,
                      title: result.title,
                      issueType: result.issueType
                    });
                  } catch (error) {
                    // Ignore errors when sending messages to tabs that don't have our content script
                    console.log(`Error sending message to tab ${tab.id}: ${error.message}`);
                  }
                });
              });
            }
          });
      }
    }, 2000);
  };
  
  // Store the callback for retry
  authStatus[service].pendingTasks.set(url, retryCallback);
  
  return { 
    title: `${service.charAt(0).toUpperCase() + service.slice(1)} Task ${taskId}`, 
    issueType: `${service}Task`
  };
}

// Function to fix any already cached "Issue navigator" titles
function cleanIncorrectTitlesInCache() {
  let count = 0;
  for (const url in titleCache) {
    if (titleCache[url] && 
        titleCache[url].title && 
        (titleCache[url].title.includes("Issue navigator") || 
         titleCache[url].title.includes("Dashboard") ||
         titleCache[url].title.includes("Issue Search"))) {
      
      debugLog(`Clearing incorrect title for ${url}: "${titleCache[url].title}"`);
      delete titleCache[url];
      count++;
    }
  }
  
  if (count > 0) {
    debugLog(`Cleared ${count} incorrect titles from cache`);
  }
}

// Function to fix any already cached incorrect Asana titles
function cleanIncorrectAsanaTitlesInCache() {
  let count = 0;
  for (const url in titleCache) {
    if (titleCache[url] && 
        titleCache[url].title && 
        url.includes('asana.com') &&
        (titleCache[url].title === "Asana" || 
         titleCache[url].title === "Asana Task" ||
         titleCache[url].title === "Asana Project" ||
         titleCache[url].title === "Redirecting")) {
      
      console.log(`Clearing incorrect Asana title for ${url}: "${titleCache[url].title}"`);
      delete titleCache[url];
      count++;
    }
  }
  
  if (count > 0) {
    console.log(`Cleared ${count} incorrect Asana titles from cache`);
  }
}

// Run both cleanup functions on initialization
cleanIncorrectTitlesInCache();
cleanIncorrectAsanaTitlesInCache();

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchAsanaTitle') {
    // Sanitize the URL by removing newlines
    const url = request.url ? request.url.replace(/\r?\n/g, '') : request.url;
    let taskId = request.taskId;
    const forceRefresh = request.forceRefresh || FORCE_REFRESH;
    
    console.log(`Received fetchAsanaTitle request for URL: ${url}`);
    console.log(`Task ID provided: ${taskId}`);
    
    // Extract task ID from URL if not provided or invalid
    let finalTaskId = taskId;
    if (!finalTaskId || !/^\d+$/.test(finalTaskId)) {
      finalTaskId = extractAsanaTaskIdFromUrl(url);
    }
    
    if (!finalTaskId) {
      console.log(`Could not extract task ID from URL: ${url}`);
      sendResponse({
        title: "Asana Task",
        issueType: "AsanaTask"
      });
      return true;
    }
    
    // Check if we have a cached title and we're not forcing a refresh
    if (titleCache[url] && !forceRefresh) {
      console.log(`Using cached Asana title for: ${url}`);
      console.log(`Cached title: ${titleCache[url].title}`);
      sendResponse({ 
        title: titleCache[url].title, 
        issueType: "AsanaTask" 
      });
      return true; // Keep the messaging channel open for async response
    }
    
    // Otherwise fetch the title
    console.log(`Fetching Asana title for: ${url} with task ID: ${finalTaskId}`);
    
    fetchAsanaTaskTitle(url, finalTaskId)
      .then(result => {
        if (result.title) {
          console.log(`Got Asana title: ${result.title}`);
          
          // Check if it's just a generic "Asana" title
          if (result.title === "Asana" || 
              result.title === "Asana Task" || 
              result.title === "Asana Project" ||
              result.title === "Redirecting") {
            
            console.log(`Got generic Asana title "${result.title}", using fallback with task ID`);
            const fallbackTitle = `Asana Task ${finalTaskId}`;
            
            // Cache the fallback title
            titleCache[url] = {
              title: fallbackTitle,
              issueType: "AsanaTask"
            };
            
            sendResponse({ 
              title: fallbackTitle, 
              issueType: "AsanaTask" 
            });
            return;
          }
          
          // Cache the title
          titleCache[url] = {
            title: result.title,
            issueType: "AsanaTask"
          };
          
          sendResponse({ 
            title: result.title, 
            issueType: "AsanaTask" 
          });
        } else {
          // Use a fallback title
          const fallbackTitle = `Asana Task ${finalTaskId}`;
          console.log(`Using fallback Asana title: ${fallbackTitle}`);
          
          // Cache the fallback
          titleCache[url] = {
            title: fallbackTitle,
            issueType: "AsanaTask"
          };
          
          sendResponse({ 
            title: fallbackTitle, 
            issueType: "AsanaTask" 
          });
        }
      })
      .catch(error => {
        console.error('Error fetching Asana title:', error);
        
        // Use a fallback title in case of error
        const fallbackTitle = `Asana Task ${finalTaskId}`;
        console.log(`Using fallback Asana title after error: ${fallbackTitle}`);
        
        sendResponse({ 
          title: fallbackTitle, 
          issueType: "AsanaTask" 
        });
      });
    
    return true; // Keep the messaging channel open for async response
  }
  
  if (request.action === 'fetchJiraTitle') {
    // Sanitize the URL by removing newlines
    const url = request.url ? request.url.replace(/\r?\n/g, '') : request.url;
    const forceRefresh = request.forceRefresh || FORCE_REFRESH;
    
    // Normalize URL for cache lookup (removes query params like ?search_id=...)
    const normalizedUrl = normalizeJiraUrl(url);
    
    // Detect and clear incorrect "Issue navigator" titles from cache
    const cachedEntry = titleCache[url] || titleCache[normalizedUrl];
    if (cachedEntry && 
        cachedEntry.title && 
        cachedEntry.title.includes("Issue navigator")) {
      
      debugLog(`Found cached "Issue navigator" title for ${url} - clearing to force refresh`);
      delete titleCache[url];
      if (normalizedUrl !== url) {
        delete titleCache[normalizedUrl];
      }
    }
    
    // Check if we have a cached title and we're not forcing a refresh
    const cachedData = titleCache[url] || titleCache[normalizedUrl];
    if (cachedData && !forceRefresh) {
      console.log('Using cached title for:', url);
      debugLog(`Cached issue type: ${cachedData.issueType}`);
      
      // Extract the issue key from the URL for cleaning
      const issueKey = extractIssueKeyFromUrl(url);
      
      // Clean the cached title just to be sure
      const cleanedTitle = cleanTitle(cachedData.title, url, issueKey);
      
      sendResponse({ 
        title: cleanedTitle, 
        issueType: cachedData.issueType 
      });
      return true; // Keep the messaging channel open for async response
    }
    
    // Otherwise fetch the title (try API first, then fallback to HTML)
    if (forceRefresh) {
      console.log('Force refreshing title for:', url);
    } else {
      console.log('Fetching title for:', url);
    }
    
    fetchJiraTitleViaAPI(url)
      .then(apiResult => {
        if (apiResult.title) {
          // We got a title from the API
          console.log('Got title from API:', apiResult.title);
          debugLog(`Got issue type from API: ${apiResult.issueType}`);
          
          // Cache both title and issue type under both original and normalized URL
          const cacheData = {
            title: apiResult.title,
            issueType: apiResult.issueType
          };
          titleCache[url] = cacheData;
          if (normalizedUrl !== url) {
            titleCache[normalizedUrl] = cacheData;
          }
          
          sendResponse({ 
            title: apiResult.title, 
            issueType: apiResult.issueType 
          });
        } else {
          // Fallback to HTML method
          return fetchJiraTitleViaHTML(url);
        }
      })
      .then(htmlResult => {
        if (htmlResult && htmlResult.title) {
          console.log('Got title from HTML:', htmlResult.title);
          debugLog(`Got issue type from HTML: ${htmlResult.issueType}`);
          
          // Cache both title and issue type under both original and normalized URL
          const cacheData = {
            title: htmlResult.title,
            issueType: htmlResult.issueType
          };
          titleCache[url] = cacheData;
          if (normalizedUrl !== url) {
            titleCache[normalizedUrl] = cacheData;
          }
          
          sendResponse({ 
            title: htmlResult.title, 
            issueType: htmlResult.issueType 
          });
        } else {
          // If both methods failed, use a simple fallback
          const issueKey = extractIssueKeyFromUrl(url);
          const fallbackTitle = issueKey ? `${issueKey}: Jira Issue` : "Jira Issue";
          
          console.log('Using fallback title:', fallbackTitle);
          
          // Cache the fallback information under both original and normalized URL
          const cacheData = {
            title: fallbackTitle,
            issueType: "Unknown"
          };
          titleCache[url] = cacheData;
          if (normalizedUrl !== url) {
            titleCache[normalizedUrl] = cacheData;
          }
          
          sendResponse({ 
            title: fallbackTitle, 
            issueType: "Unknown" 
          });
        }
      })
      .catch(error => {
        console.error('Error fetching title:', error);
        
        // Use a fallback title in case of error
        const issueKey = extractIssueKeyFromUrl(url);
        const fallbackTitle = issueKey ? `${issueKey}: Jira Issue` : "Jira Issue";
        
        console.log('Using fallback title after error:', fallbackTitle);
        sendResponse({ 
          title: fallbackTitle, 
          issueType: "Unknown" 
        });
      });
    
    return true; // Keep the messaging channel open for async response
  }
});

// Function to extract Asana task ID from URL
function extractAsanaTaskIdFromUrl(url) {
  try {
    if (!url) return null;
    
    // Priority 1: Check for /item/ format (specific to inbox/search views)
    if (url.includes('/item/')) {
      const itemPart = url.split('/item/')[1];
      if (itemPart) {
        const digits = itemPart.match(/(\d+)/);
        if (digits && digits[1]) {
          console.log(`Extracted Asana task ID from /item/ path: ${digits[1]}`);
          return digits[1];
        }
      }
    }
    
    // Priority 2: Try to find task ID in /task/ format
    if (url.includes('/task/')) {
      const taskPart = url.split('/task/')[1];
      if (taskPart) {
        // Extract digits after /task/
        const digits = taskPart.match(/(\d+)/);
        if (digits && digits[1]) {
          console.log(`Extracted Asana task ID from /task/ path: ${digits[1]}`);
          return digits[1];
        }
      }
    }
    
    // Next, try standard regex for numeric ID
    const taskIdMatch = url.match(/(?:\/|task\/)(\d+)(?:\/f|[?#&].*|\s|$)/i);
    if (taskIdMatch && taskIdMatch[1]) {
      console.log(`Extracted Asana task ID via regex: ${taskIdMatch[1]}`);
      return taskIdMatch[1];
    }
    
    // If that fails, try extracting the numeric IDs and use the one that looks like a task ID
    // (Asana task IDs are usually longer than project IDs)
    const numericIds = [];
    const urlParts = url.split('/');
    for (const part of urlParts) {
      if (/^\d+$/.test(part)) {
        numericIds.push(part);
      }
    }
    
    // Sort by length descending - usually the task ID is the longest number
    numericIds.sort((a, b) => b.length - a.length);
    
    if (numericIds.length > 0) {
      console.log(`Extracted potential Asana task ID from numeric segments: ${numericIds[0]}`);
      return numericIds[0];
    }
    
    console.log(`Could not extract Asana task ID from URL: ${url}`);
    return null;
  } catch (error) {
    console.error(`Error extracting Asana task ID: ${error.message}`);
    return null;
  }
}

// Function to extract Jira issue key from URL
function extractJiraIssueKeyFromUrl(url) {
  // Try to match both /browse/KEY-123 and /issues/KEY-123 patterns
  const match = url.match(/\/(?:browse|issues)\/([A-Z]+-\d+)(?:\?|$|\/)/);
  return match ? match[1] : null;
} 