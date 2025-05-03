import React, { useState, useEffect } from 'react';
import './App.css';

// --- PKCE Helper Functions ---
async function generateRandomString(length: number): Promise<string> {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const randomValues = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    result += charset[randomValues[i] % charset.length];
  }
  return result;
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  // Base64url encode
  // @ts-ignore - Incorrect type inference for fromCharCode with spread
  return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// --- Constants --- MUST MATCH SERVER CONFIG
const AUTH_SERVER_BASE_URL = 'https://us-central1-symm-gemini.cloudfunctions.net/notiskyAuth'; // Use env var for dev/prod
// const AUTH_SERVER_BASE_URL = 'http://localhost:3000'; // Example for local dev
const AUTH_INITIATE_ENDPOINT = `${AUTH_SERVER_BASE_URL}/api/auth/ext-auth`;

function Login() {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Listener for completion message from background script
  useEffect(() => {
    const handleMessage = (message: any, sender: Browser.runtime.MessageSender) => {
       // Only listen to messages from our own extension's background
       if (sender.id !== browser.runtime.id || sender.url?.includes('/popup.html')) {
          return;
       }
       console.log('[Popup] Received message:', message);
       if (message.type === 'OAUTH_COMPLETE') {
          setIsLoading(false);
          if (message.success) {
            setStatusMessage('Login successful! You can close this popup.');
            setError(null);
            // Maybe close popup automatically after a delay?
             setTimeout(() => window.close(), 2000);
          } else {
            setError(`Login failed: ${message.error || 'Unknown error from background.'}`);
            setStatusMessage(null);
          }
       }
    };

    browser.runtime.onMessage.addListener(handleMessage);

    // Cleanup listener on component unmount
    return () => {
      browser.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    console.log('[Login Start]');
    setError(null);
    setStatusMessage('Preparing secure login...');
    setIsLoading(true);

    try {
      const state = await generateRandomString(32); // Generate secure random state
      const verifier = await generateRandomString(128); // Generate PKCE verifier
      const challenge = await generateCodeChallenge(verifier); // Generate PKCE challenge

      console.log('[Login] Generated State:', state.substring(0,5)+'...');
      console.log('[Login] Generated Verifier:', verifier.substring(0,5)+'...');
      console.log('[Login] Generated Challenge:', challenge.substring(0,5)+'...');

      // 1. Send verifier and state to background script for storage
      console.log('[Login] Storing PKCE state in background...');
      // IMPORTANT: Need to ensure background has a listener for 'STORE_PKCE'
      await browser.runtime.sendMessage({
          type: 'STORE_PKCE',
          data: { state: state, verifier: verifier }
      });
      console.log('[Login] PKCE state sent to background.');

      // 2. Construct URL for the auth server's initiation endpoint
      const extensionId = browser.runtime.id;
      const authServerUrlParams = new URLSearchParams({
          extension_id: extensionId,
          state: state,
          code_challenge: challenge
          // Note: No redirect_uri or client_id needed here, server handles it
      });
      const authServerUrl = `${AUTH_INITIATE_ENDPOINT}?${authServerUrlParams.toString()}`;

      console.log('[Login] Constructed Auth Server URL:', authServerUrl);

      // 3. Open the auth server URL in a new tab
      console.log('[Login] Opening auth server URL in new tab...');
      setStatusMessage('Redirecting to Bluesky for authorization...');
      await browser.tabs.create({ url: authServerUrl, active: true });

      // 4. Wait for the background script to message us back (handled by useEffect listener)
      console.log('[Login] Waiting for completion message from background...');
      // Note: UI is now passive, waiting for background message or user interaction

    } catch (e: any) {
      console.error('[Login] Error during initiation:', e);
      // Check if error is because background script isn't listening for STORE_PKCE
      if (e.message?.includes('Could not establish connection')) {
         setError('Error communicating with background service. Is the extension enabled correctly?');
      } else {
         setError(`Login failed: ${e.message || 'Unknown error'}`);
      }
      setIsLoading(false);
      setStatusMessage(null);
    }
  };

  return (
    <div className="login-container">
      <div className="login-header">
        <img src="../icon/128.png" alt="Notisky Logo" style={{ width: 48, height: 48, marginBottom: 10 }} />
        <h1>Sign in via Bluesky</h1>
        <p>Connect your Bluesky account securely using OAuth</p>
      </div>
      <form onSubmit={handleLogin} className="login-form">
        {error && <div className="error-message">{error}</div>}
        {statusMessage && !error && <div className="info-message">{statusMessage}</div>}
        <button type="submit" disabled={isLoading}>
          {isLoading ? 'Processing...' : 'Sign in with Bluesky'}
        </button>
      </form>
      <div className="login-footer">
        <p>A new window will open to authorize Notisky with Bluesky.</p>
      </div>
    </div>
  );
}

// Keep the App component simple
function App() {
  return (
    <div className="App">
      <Login />
    </div>
  );
}

export default App;
