// auth-finalize-cs.js
// This is a pure JavaScript content script that runs on the auth-finalize.html page

// Define browser namespace for WebExtension compatibility
var browser = window.browser || window.chrome;

console.log('[auth-finalize-cs] Content script loaded');

// Process the OAuth callback parameters and communicate with background script
function processCallback() {
  console.log('[auth-finalize-cs] Processing callback');
  
  try {
    // Extract URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');
    const errorDescription = urlParams.get('error_description');
    
    // Update the status in the page
    const statusEl = document.getElementById('auth-status');
    const messageEl = document.getElementById('auth-message');
    
    // Helper to update UI elements
    function updateUI(isSuccess, message) {
      if (statusEl) {
        statusEl.textContent = isSuccess ? 'Success!' : 'Error';
        statusEl.className = `status ${isSuccess ? 'success' : 'error'}`;
      }
      
      if (messageEl) {
        messageEl.textContent = message;
      }
    }
    
    // Handle errors from the OAuth provider
    if (error) {
      console.error(`[auth-finalize-cs] Error from OAuth: ${error} - ${errorDescription || 'No details'}`);
      updateUI(false, `Authentication failed: ${errorDescription || error}`);
      
      // Send error to background script
      // Use browser namespace for WebExtension compatibility (including Firefox)
      browser.runtime.sendMessage({
        type: 'OAUTH_CALLBACK',
        data: { error, error_description: errorDescription }
      });
      return;
    }
    
    // Validate required parameters
    if (!code || !state) {
      console.error('[auth-finalize-cs] Missing code or state in callback URL');
      updateUI(false, 'Missing authentication data in the callback');
      return;
    }
    
    // Update UI for success case
    console.log(`[auth-finalize-cs] Received code and state: ${state.substring(0, 5)}...`);
    if (statusEl) {
      statusEl.textContent = 'Processing...';
      statusEl.className = 'status';
    }
    if (messageEl) {
      messageEl.textContent = 'Authentication successful! Processing details...';
    }
    
    // Send the auth data to background script
    // Use browser namespace for WebExtension compatibility
    browser.runtime.sendMessage({
      type: 'OAUTH_CALLBACK',
      data: { code, state }
    }).then(function(response) {
      console.log('[auth-finalize-cs] Background script response:', response);
      
      if (response && response.success) {
        updateUI(true, 'Successfully authenticated! You can close this window.');
        // Auto-close after a delay
        setTimeout(function() {
          window.close();
        }, 3000);
      } else {
        updateUI(false, (response && response.error) || 'Unknown error during authentication process');
      }
    }).catch(function(error) {
      console.error('[auth-finalize-cs] Error sending message:', error);
      updateUI(false, 'Error communicating with extension');
    });
  } catch (err) {
    console.error('[auth-finalize-cs] Error in content script:', err);
  }
}

// Process the callback when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', processCallback);
} else {
  processCallback();
} 