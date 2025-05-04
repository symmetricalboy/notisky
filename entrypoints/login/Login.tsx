import React, { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import BskyAgent from '@atproto/api'; // Linter ignored
// Removed unused Account import and BLUESKY_SERVICE import

// --- PKCE Helper Functions ---
// (Keep generateCodeVerifier and generateCodeChallenge as they were)
async function generateCodeVerifier(): Promise<string> {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...randomBytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

// --- Constants ---
// URL for the auth server endpoint that starts the flow
const AUTH_SERVER_INITIATE_URL = 'https://notisky.symm.app/api/auth/start-extension-flow';
// Client ID remains the same
const CLIENT_ID = 'https://notisky.symm.app/client-metadata/client.json'; 

// --- Login Component ---
function Login() {
  const [handle, setHandle] = useState(''); // Keep for consistency?
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  // Listener for completion message from background script
  useEffect(() => {
    const handleMessage = (message: any, sender: browser.runtime.MessageSender) => {
       if (sender.id !== browser.runtime.id) return; // Only listen to self

       if (message.type === 'OAUTH_COMPLETE') { // Listen for the final outcome
          console.log('[Login] Received OAUTH_COMPLETE from background:', message);
          setLoading(false);
          if (message.success) {
            setInfo('Login successful! You can close this window.');
            setError(null);
            setTimeout(() => window.close(), 1500); 
          } else {
            setError(`Login failed: ${message.error || 'Unknown error from background.'}`);
            setInfo(null);
          }
       }
    };
    browser.runtime.onMessage.addListener(handleMessage);
    return () => browser.runtime.onMessage.removeListener(handleMessage);
  }, []);
  
  // Reverted: Initiate OAuth flow via the Auth Server
  const handleLoginViaAuthServer = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[Login Page - Auth Server Flow] Started');
    setError(null);
    setInfo('Preparing secure login...');
    setLoading(true);
    let generatedState: string | null = null;
    let verifierStorageKey: string | null = null;

    try {
      // 1. Generate PKCE values and state
      const state = crypto.randomUUID();
      generatedState = state;
      const codeVerifier = await generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      console.log(`[Login Page - Auth Server Flow] State: ${state.substring(0, 5)}...`);
      console.log(`[Login Page - Auth Server Flow] Challenge: ${codeChallenge}`);

      if (!CLIENT_ID) {
          throw new Error("Client ID is not set.");
      }

      // 2. Store verifier temporarily (background script will retrieve and remove it)
      verifierStorageKey = `pkce_${state}`;
      await browser.storage.session.set({ [verifierStorageKey]: codeVerifier });
      console.log('[Login Page - Auth Server Flow] Stored PKCE verifier in session storage.');

      // 3. Construct URL for the Auth Server's initiation endpoint
      const authServerUrlParams = new URLSearchParams({
        client_id: CLIENT_ID, // Pass client ID to auth server
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256', // Pass method too
        // The auth server will add its own redirect_uri when calling Bluesky
      });
      const authServerInitiateFullUrl = `${AUTH_SERVER_INITIATE_URL}?${authServerUrlParams.toString()}`;
      console.log('[Login Page - Auth Server Flow] Constructed Auth Server Initiate URL:', authServerInitiateFullUrl);

      // 4. Open the Auth Server URL in a new tab/window
      setInfo('Redirecting via authentication server...');
      console.log('[Login Page - Auth Server Flow] Opening Auth Server URL using browser.tabs.create...');
      
      // Use browser.tabs.create instead of window.open
      await browser.tabs.create({ url: authServerInitiateFullUrl, active: true });
      /* 
      const authWindow = window.open(authServerInitiateFullUrl, '_blank', 'width=600,height=700,noopener,noreferrer');
      if (!authWindow) {
          // Fallback or error if window opening failed (e.g., popup blocker)
          console.warn('[Login Page - Auth Server Flow] window.open failed, falling back to browser.tabs.create');
          // Clear verifier if we can't even open the window
          if (verifierStorageKey) { await browser.storage.session.remove(verifierStorageKey); }
          throw new Error('Failed to open authentication window. Please check your popup blocker settings.');
          // Alternative: await browser.tabs.create({ url: authServerInitiateFullUrl, active: true });
      }
      */

      console.log('[Login Page - Auth Server Flow] Auth tab should be opening. Waiting for OAUTH_COMPLETE message from background...');
      // Login page now waits passively for the OAUTH_COMPLETE message from the background via the useEffect listener
      // It doesn't interact with launchWebAuthFlow or parse URLs itself anymore.

    } catch (err: any) {
      console.error('[Login Page - Auth Server Flow] Error during login initiation:', err);
      // Attempt to clean up stored verifier on error
      if (verifierStorageKey) {
           try { await browser.storage.session.remove(verifierStorageKey); } catch (e) { console.warn('Error during cleanup on error:', e)}
      }
      setError(`Login initiation failed: ${err.message || 'Unknown error'}`);
      setLoading(false);
      setInfo(null);
    }
  };

  return (
    <div className="login-container">
      <div className="login-header">
        <img src="../icon/128.png" alt="Notisky Logo" style={{width: 48, height: 48, marginBottom: 10}}/>
        <h1>Sign in via Bluesky</h1>
        <p>Connect your Bluesky account securely using OAuth</p>
      </div>
      
      {/* Ensure the form uses the correct handler */}
      <form onSubmit={handleLoginViaAuthServer} className="login-form">
        {error && <div className="error-message">{error}</div>}
        {info && !error && <div className="info-message">{info}</div>}
                        
        <button type="submit" disabled={loading}>
          {loading ? 'Processing...' : 'Sign in with Bluesky'}
        </button>
      </form>
      
      <div className="login-footer">
        <p>
           A new window will open to authorize Notisky with Bluesky.
        </p>
      </div>
    </div>
  );
}

export default Login; 