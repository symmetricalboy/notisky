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
      if (browser && browser.runtime && browser.runtime.sendMessage) {
        browser.runtime.sendMessage({
          type: 'OAUTH_CALLBACK',
          data: { error, error_description: errorDescription }
        }).catch(function(err) {
          console.error('[auth-finalize-cs] Error sending error message:', err);
        });
      } else {
        console.error('[auth-finalize-cs] Browser runtime API not available');
      }
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
    
    // Send the auth data to background script for token retrieval
    if (browser && browser.runtime && browser.runtime.sendMessage) {
      // Let extension know we received the code and state, extension will respond with the verifier
      browser.runtime.sendMessage({
        type: 'GET_CODE_VERIFIER',
        data: { state: state }
      }).then(function(response) {
        if (!response || !response.verifier) {
          console.error('[auth-finalize-cs] Failed to get verifier from extension');
          updateUI(false, 'Authentication failed: Could not retrieve verifier');
          return;
        }
        
        console.log('[auth-finalize-cs] Retrieved verifier from extension, sending to auth server...');
        
        // Now send the code, state, and verifier to the auth server's token exchange endpoint
        fetch('https://notisky.symm.app/api/auth/token-exchange', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            code: code,
            state: state,
            code_verifier: response.verifier,
            redirect_uri: 'https://notisky.symm.app/api/auth/extension-callback',
            client_id: 'https://notisky.symm.app/client-metadata/client.json'
          })
        })
        .then(function(fetchResponse) {
          return fetchResponse.json();
        })
        .then(function(tokenResponseData) {
          // Check for errors from the auth server token exchange
          if (tokenResponseData.error) {
            console.error('[auth-finalize-cs] Error from auth server token exchange:', tokenResponseData);
            updateUI(false, `Authentication failed: ${tokenResponseData.error_description || tokenResponseData.error}`);
            // Send error details to background?
             browser.runtime.sendMessage({ type: 'OAUTH_TOKEN_RECEIVED', data: { error: tokenResponseData.error, error_description: tokenResponseData.error_description } });
            return;
          }
          
          // Send the received token data (including potentially DPoP keys) to the background script
          console.log('[auth-finalize-cs] Token exchange successful, sending data to background script:', tokenResponseData);
          updateUI(true, 'Authentication successful! Processing session...');
          
          browser.runtime.sendMessage({ type: 'OAUTH_TOKEN_RECEIVED', data: tokenResponseData })
            .then(function(bgResponse) {
              if (bgResponse && bgResponse.success) {
                 console.log('[auth-finalize-cs] Background script processed tokens successfully.');
                 updateUI(true, 'Authentication complete! You can close this window.');
                 setTimeout(window.close, 1500);
              } else {
                 console.error('[auth-finalize-cs] Background script reported error:', bgResponse?.error);
                 updateUI(false, `Authentication finalization failed: ${bgResponse?.error || 'Unknown error from extension'}`);
              }
            })
            .catch(function(err) {
              console.error('[auth-finalize-cs] Error communicating with background script:', err);
              updateUI(false, 'Authentication failed: Error contacting extension background.');
            });
        })
        .catch(function(err) {
          console.error('[auth-finalize-cs] Error during token exchange with auth server:', err);
          updateUI(false, 'Error during token exchange with server');
        });
      }).catch(function(error) {
        console.error('[auth-finalize-cs] Error retrieving verifier:', error);
        updateUI(false, 'Error communicating with extension');
      });
    } else {
      console.error('[auth-finalize-cs] Browser runtime API not available');
      updateUI(false, 'Browser API not available. Please make sure extension permissions are granted.');
    }
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