import { Account } from '../src/services/auth';
import { loadAccounts, saveAccount } from '../src/services/auth';
import { 
  startNotificationPolling, 
  stopNotificationPolling, 
  updateNotificationBadge, 
  resetNotificationCount 
} from '../src/services/notifications';
import {
  initializeOAuth,
  startOAuthSignIn,
  oauthSessionToAccount,
  refreshOAuthToken,
  setupOAuthListeners
} from '../src/services/atproto-oauth';

// Store for authenticated accounts
let accounts: Record<string, Account> = {};
// Polling intervals for each account
const pollingIntervals: Record<string, number> = {};

// Start notification polling for an account
function startPollingForAccount(account: Account): void {
  if (pollingIntervals[account.did]) {
    stopNotificationPolling(pollingIntervals[account.did]);
  }
  
  pollingIntervals[account.did] = startNotificationPolling(account);
  console.log(`Started polling for ${account.handle} (${account.did})`);
}

// Stop notification polling for an account
function stopPollingForAccount(did: string): void {
  if (pollingIntervals[did]) {
    stopNotificationPolling(pollingIntervals[did]);
    delete pollingIntervals[did];
    console.log(`Stopped polling for ${did}`);
  }
}

// Handle login flow
async function initiateLogin(handle: string): Promise<void> {
  try {
    // Start the OAuth sign-in process
    await startOAuthSignIn(handle);
    
    // Note: The function should not return here as the user will be redirected
  } catch (error) {
    console.error('Error during OAuth login:', error);
  }
}

// Handle OAuth callback
async function handleOAuthCallback(session: any): Promise<void> {
  try {
    // Convert the OAuth session to our account type
    const account = await oauthSessionToAccount(session);
    
    if (account) {
      // Add the account to our local cache
      accounts[account.did] = account;
      
      // Save the account
      await saveAccount(account);
      
      // Start polling for this account
      startPollingForAccount(account);
      
      // Update the badge
      updateNotificationBadge();
    } else {
      console.error('Failed to convert OAuth session to account');
    }
  } catch (error) {
    console.error('Error handling OAuth callback:', error);
  }
}

// Initialize all accounts and start polling
async function initializeAccounts(): Promise<void> {
  try {
    // Initialize the OAuth client first
    const session = await initializeOAuth();
    if (session) {
      // If we have a session from the OAuth flow, handle it
      await handleOAuthCallback(session);
    }
    
    // Load accounts from storage
    accounts = await loadAccounts();
    
    // Start polling for all accounts
    Object.values(accounts).forEach(account => {
      startPollingForAccount(account);
    });
    
    // Update the badge
    updateNotificationBadge();
    
    // Set up listeners for OAuth session events
    setupOAuthListeners(async (event: CustomEvent) => {
      const { sub, cause } = event.detail;
      console.log(`Session for ${sub} was deleted due to: ${cause}`);
      
      // Remove the account if it exists
      if (accounts[sub]) {
        stopPollingForAccount(sub);
        delete accounts[sub];
        updateNotificationBadge();
      }
    });
  } catch (error) {
    console.error('Error initializing accounts', error);
  }
}

export default defineBackground({
  main() {
    console.log('Notisky background service started', { id: browser.runtime.id });

    // Initialize notifications permission
    browser.notifications.getPermissionLevel((level) => {
      console.log('Notification permission level:', level);
    });

    // Setup message handlers for communication with popup and content script
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('Received message', message, 'from', sender);
      
      // Handle login initiation
      if (message.type === 'INITIATE_LOGIN') {
        const { handle } = message.data || {};
        if (!handle) {
          sendResponse({ success: false, error: 'Handle is required' });
          return false;
        }
        
        initiateLogin(handle)
          .then(() => sendResponse({ success: true }))
          .catch(error => {
            console.error('Login failed', error);
            sendResponse({ success: false, error: error.message });
          });
        return true; // Indicate async response
      }
      
      // Return accounts list
      if (message.type === 'GET_ACCOUNTS') {
        sendResponse({ accounts: Object.values(accounts) });
        return false; // Synchronous response
      }
      
      // Handle notification view events
      if (message.type === 'NOTIFICATION_VIEW') {
        const { did } = message.data || {};
        if (did && accounts[did]) {
          resetNotificationCount(did);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Account not found' });
        }
        return false;
      }
      
      // Handle account removal
      if (message.type === 'REMOVE_ACCOUNT') {
        const { did } = message.data || {};
        if (did && accounts[did]) {
          stopPollingForAccount(did);
          delete accounts[did];
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Account not found' });
        }
        return false;
      }
      
      return false;
    });

    // Setup notification click handler
    browser.notifications.onClicked.addListener((notificationId) => {
      // Open Bluesky notifications tab when the desktop notification is clicked
      browser.tabs.create({ url: 'https://bsky.app/notifications' });
    });

    // Listen for storage changes to update accounts
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.accounts) {
        const newAccounts = changes.accounts.newValue || {};
        
        // Check for new accounts
        Object.entries(newAccounts).forEach(([did, account]) => {
          if (!accounts[did]) {
            // New account added
            startPollingForAccount(account as Account);
          }
        });
        
        // Update local accounts cache
        accounts = newAccounts;
        
        // Update badge
        updateNotificationBadge();
      }
    });

    // Initialize accounts when the extension starts
    initializeAccounts();
  }
});
