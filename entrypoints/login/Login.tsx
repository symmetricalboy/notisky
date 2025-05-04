import React, { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import BskyAgent from '@atproto/api'; // Linter ignored
import { Account } from '../../src/services/auth'; 
import { BLUESKY_SERVICE } from '../../src/services/atproto-oauth';

// --- OAuth Configuration ---
// Use the client metadata URL hosted by the server
const CLIENT_METADATA_URL = 'https://notisky.symm.app/client-metadata/client.json'; 
const AUTHORIZATION_ENDPOINT = `${BLUESKY_SERVICE}/oauth/authorize`; 

// PKCE Helper functions
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

// --- Login Component ---
function Login() {
  const [handle, setHandle] = useState(''); // Keep for potential future use?
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [extensionRedirectUri, setExtensionRedirectUri] = useState<string | null>(null);

  // Get the extension's redirect URI on component mount
  useEffect(() => {
    try {
      // WXT might provide a helper, but browser.identity is standard
      const redirectUri = browser.identity.getRedirectURL(); 
      console.log('[Login] Determined Extension Redirect URI:', redirectUri);
      if (!redirectUri) {
          throw new Error('Could not determine extension redirect URI.');
      }
      setExtensionRedirectUri(redirectUri);
    } catch (err: any) {
       console.error('[Login] Error getting redirect URI:', err);
       setError(`Initialization failed: ${err.message}`);
    }
  }, []);

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


  // Handle initiating the OAuth sign-in flow using launchWebAuthFlow
  const handleOAuthLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[Login Flow] Started');
    
    if (!extensionRedirectUri) {
        setError('Error: Extension Redirect URI not available.');
        return;
    }

    setError(null);
    setInfo('Preparing secure login...');
    setLoading(true);
    let generatedState = null; 
    let verifierStorageKey = null; 

    try {
        const state = crypto.randomUUID();
        generatedState = state;
        const codeVerifier = await generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        const codeChallengeMethod = 'S256';

        // Store verifier in session storage (accessible by background)
        verifierStorageKey = `pkce_${state}`;
        await browser.storage.session.set({ [verifierStorageKey]: codeVerifier });
        console.log('[Login Flow] Stored PKCE verifier in session storage for state:', state);

        // Define scopes needed
        const scope = 'atproto transition:generic transition:chat.bsky'; // Match client.json

        const authParams = new URLSearchParams({
            response_type: 'code',
            client_id: CLIENT_METADATA_URL, // Use the hosted metadata URL
            redirect_uri: extensionRedirectUri, // Use the EXTENSION'S redirect URI
            scope: scope,
            state: state,
            code_challenge: codeChallenge,
            code_challenge_method: codeChallengeMethod,
        });
        const authorizationUrl = `${AUTHORIZATION_ENDPOINT}?${authParams.toString()}`;
        console.log('[Login Flow] Constructed Bluesky Auth URL:', authorizationUrl);

        setInfo('Waiting for Bluesky authorization...');
        console.log('[Login Flow] Calling browser.identity.launchWebAuthFlow...');
        
        // Use launchWebAuthFlow - it will handle the redirect back to the extension URI
        const resultUrl = await browser.identity.launchWebAuthFlow({
            url: authorizationUrl,
            interactive: true
        });

        console.log('[Login Flow] launchWebAuthFlow finished. Result URL:', resultUrl);

        // --- Process Result URL (captured by launchWebAuthFlow) --- 
        if (!resultUrl) {
            console.log('[Login Flow] Flow cancelled by user (no result URL).');
            throw new Error('Authentication flow was cancelled.');
        }

        const url = new URL(resultUrl);
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const errorCode = url.searchParams.get('error');
        const errorDesc = url.searchParams.get('error_description');

        if (errorCode) {
             console.error('[Login Flow] OAuth Error in callback URL:', errorCode, errorDesc);
             // Clean up verifier before throwing
             if (verifierStorageKey) await browser.storage.session.remove(verifierStorageKey);
             throw new Error(`OAuth Error: ${errorDesc || errorCode}`);
        }
        if (!code) {
            console.error('[Login Flow] Code not found in callback URL:', resultUrl);
             if (verifierStorageKey) await browser.storage.session.remove(verifierStorageKey);
            throw new Error('Authorization code not found in callback URL.');
        }
        if (returnedState !== state) {
             if (verifierStorageKey) await browser.storage.session.remove(verifierStorageKey); 
             console.error('[Login Flow] State mismatch! Expected:', state, 'Received:', returnedState);
             throw new Error('OAuth state mismatch. Security check failed.');
        }

        // --- Send Code to Background for Exchange --- 
        setInfo('Authentication approved! Finalizing login with background service...');
        console.log('[Login Flow] Sending code and state to background for token exchange...');
        // Background will use the state to find the verifier in session storage
        await browser.runtime.sendMessage({
            type: 'EXCHANGE_OAUTH_CODE', 
            data: { code, state: returnedState } // Send code and state
        });
        // Background script is now responsible for token exchange and cleanup of PKCE state.
        // We wait for the 'OAUTH_COMPLETE' message (handled by useEffect listener).
        console.log('[Login Flow] Waiting for OAUTH_COMPLETE message from background...');

    } catch (err: any) {
      console.error('[Login Flow] Overall flow error:', err);
       // Ensure verifier is cleaned up on error IF it was stored and not yet handled by background
      if (verifierStorageKey && !(err.message?.includes('OAuth Error') || err.message?.includes('Code not found') || err.message?.includes('State mismatch'))) {
            // Attempt cleanup if error happened before sending to background or if background failed unexpectedly
            try { await browser.storage.session.remove(verifierStorageKey); } catch (e) { console.warn('Error during cleanup:', e)}
      }
      if (err.message?.includes('cancelled') || err.message?.includes('closed by the user') || err.message?.includes('Invalid redirect URI')) {
           setError(`Login cancelled or failed: ${err.message}`);
      } else {
           setError(`Login failed: ${err.message || 'Unknown error'}`);
      }
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
      
      <form onSubmit={handleOAuthLogin} className="login-form">
        {error && <div className="error-message">{error}</div>}
        {info && !error && <div className="info-message">{info}</div>}
                        
        <button type="submit" disabled={loading || !extensionRedirectUri}>
          {loading ? 'Processing...' : (extensionRedirectUri ? 'Sign in with Bluesky' : 'Initializing...')}
        </button>
        {!extensionRedirectUri && !error && <div className="info-message">Determining redirect URI...</div>}
      </form>
      
      <div className="login-footer">
        <p>
           A new window will open to authorize Notisky with Bluesky.
        </p>
         {extensionRedirectUri && <p style={{fontSize: '0.8em', color: '#aaa', marginTop: '10px'}}>Redirect URI: {extensionRedirectUri}</p>}
      </div>
    </div>
  );
}

export default Login; 