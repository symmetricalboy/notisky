import React, { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import BskyAgent from '@atproto/api'; // Linter ignored
import { Account } from '../../src/services/auth'; 
// Removed unused BLUESKY_SERVICE import

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


// --- Constants for Auth Server Flow ---
const AUTH_SERVER_BASE_URL = 'https://notisky.symm.app'; 
const AUTH_INITIATE_ENDPOINT = `${AUTH_SERVER_BASE_URL}/api/auth/ext-auth`;

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

  // Handle initiating the OAuth flow via the AUTH SERVER
  const handleLoginViaServer = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[Login Page - Server Flow] Started');
    setError(null);
    setInfo('Preparing secure login...');
    setLoading(true);
    let generatedState = null; 
    let verifierStorageKey = null; 

    try {
        // 1. Generate PKCE values and state
        const state = crypto.randomUUID();
        generatedState = state; // Keep for potential future cleanup (though unlikely needed now)
        const codeVerifier = await generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        console.log(`[Login Page - Server Flow] State: ${state.substring(0,5)}...`); 
        // console.log(`[Login Page - Server Flow] Verifier: ${codeVerifier}`); // Don't log verifier
        console.log(`[Login Page - Server Flow] Challenge: ${codeChallenge}`);

        // 2. Store verifier in session storage (accessible by background)
        verifierStorageKey = `pkce_${state}`;
        await browser.storage.session.set({ [verifierStorageKey]: codeVerifier });
        console.log('[Login Page - Server Flow] Stored PKCE verifier in session storage.');

        // 3. Construct URL for the auth server's initiation endpoint
        const extensionId = browser.runtime.id; 
        const authServerUrlParams = new URLSearchParams({
            extension_id: extensionId,
            state: state, // Send the state
            code_challenge: codeChallenge // Send the challenge
        });
        const authServerInitiateUrl = `${AUTH_INITIATE_ENDPOINT}?${authServerUrlParams.toString()}`;
        console.log('[Login Page - Server Flow] Constructed Auth Server URL:', authServerInitiateUrl);

        // 4. Open the auth server URL in a new tab
        console.log('[Login Page - Server Flow] Opening auth server URL in new tab...');
        setInfo('Redirecting via server to Bluesky for authorization...');
        await browser.tabs.create({ url: authServerInitiateUrl, active: true });

        // 5. Wait passively for background script message
        console.log('[Login Page - Server Flow] Waiting for OAUTH_COMPLETE message from background...');
        // UI waits for the OAUTH_COMPLETE message via the useEffect listener

    } catch (err: any) {
      console.error('[Login Page - Server Flow] Error during initiation:', err);
      // Clean up verifier only if error happened before redirecting (e.g., storage error)
      if (verifierStorageKey) {
           try { await browser.storage.session.remove(verifierStorageKey); } catch (e) { console.warn('Error during cleanup:', e)}
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
      
      {/* Use the server flow handler */}
      <form onSubmit={handleLoginViaServer} className="login-form">
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