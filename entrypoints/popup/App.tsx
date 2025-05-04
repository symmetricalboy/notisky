import React, { useState, useEffect } from 'react';
import './App.css';

// --- Constants for Auth Server Flow ---
const AUTH_SERVER_BASE_URL = 'https://notisky.symm.app'; // Updated URL
// const AUTH_SERVER_BASE_URL = 'http://localhost:3001'; // For local testing
const AUTH_INITIATE_ENDPOINT = `${AUTH_SERVER_BASE_URL}/api/auth/ext-auth`;

interface AccountInfo {
  did: string;
  handle: string;
}

function PopupApp() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null); // null = loading
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Check auth status and load accounts on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        console.log('[Popup] Checking authentication status...');
        const statusResponse = await browser.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });
        console.log('[Popup] Auth status response:', statusResponse);
        setIsAuthenticated(statusResponse?.isAuthenticated || false);

        if (statusResponse?.isAuthenticated) {
          console.log('[Popup] Fetching account details...');
          const accountsResponse = await browser.runtime.sendMessage({ type: 'GET_ACCOUNTS' });
          console.log('[Popup] Accounts response:', accountsResponse);
          setAccounts(accountsResponse?.accounts || []);
        }
      } catch (err: any) {
        console.error('[Popup] Error checking auth status or getting accounts:', err);
        setError(`Error loading status: ${err.message}`);
        setIsAuthenticated(false); // Assume not authenticated on error
      }
    };
    checkAuth();
  }, []);

  // Listener for completion message from background (if login finishes while popup is open)
  useEffect(() => {
    const handleMessage = (message: any, sender: browser.runtime.MessageSender) => {
       if (sender.id !== browser.runtime.id || sender.url?.includes('/popup.html')) return;
       
       console.log('[Popup] Received message:', message);
       if (message.type === 'OAUTH_COMPLETE') {
          if (message.success && message.account) {
            // Login succeeded, update UI
            setIsAuthenticated(true);
            // Avoid duplicates if account is already listed (though GET_ACCOUNTS should handle this)
            setAccounts(prev => prev.some(a => a.did === message.account.did) ? prev : [...prev, message.account]);
            setError(null);
            // Optionally close popup after success
            // setTimeout(() => window.close(), 1500);
          } else if (!message.success) {
            // Login failed
            setError(`Login failed: ${message.error || 'Unknown error'}`);
            setIsAuthenticated(false);
          }
       }
       // Optional: Listen for REMOVE_ACCOUNT if needed
    };
    browser.runtime.onMessage.addListener(handleMessage);
    return () => browser.runtime.onMessage.removeListener(handleMessage);
  }, []);

  const handleOpenLogin = () => {
    console.log('[Popup] Opening login page...');
    const loginUrl = browser.runtime.getURL("/login.html");
    browser.tabs.create({ url: loginUrl, active: true });
    window.close(); // Close the popup after opening the login tab
  };

  const handleLogout = async (did: string) => {
    try {
      console.log(`[Popup] Requesting logout for ${did}`);
      await browser.runtime.sendMessage({ type: 'REMOVE_ACCOUNT', data: { removeDid: did } });
      // Update UI immediately
      setAccounts(prev => prev.filter(acc => acc.did !== did));
      if (accounts.length === 1) { // If it was the last account
          setIsAuthenticated(false);
      }
      console.log(`[Popup] Logout request sent for ${did}`);
    } catch (err: any) {
        console.error('[Popup] Error sending logout request:', err);
        setError(`Logout failed: ${err.message}`);
    }
  };

  // Render Logic
  const renderContent = () => {
    if (isAuthenticated === null) {
      return <p>Loading...</p>;
    }

    if (error) {
      return <div className="error-message">{error}</div>;
    }

    if (isAuthenticated && accounts.length > 0) {
      return (
        <div>
          <h2>Authenticated Accounts:</h2>
          <ul className="account-list">
            {accounts.map(acc => (
              <li key={acc.did}>
                <span>{acc.handle}</span>
                <button onClick={() => handleLogout(acc.did)} className="logout-button">Logout</button>
              </li>
            ))}
          </ul>
        </div>
      );
    } else {
      return (
        <div className="login-prompt">
          <p>Please sign in to enable Notisky features.</p>
          <button onClick={handleOpenLogin} className="login-button">
            Sign in with Bluesky
          </button>
        </div>
      );
    }
  };

  return (
    <div className="App">
      <div className="header">
          <img src="../icon/48.png" alt="Notisky Logo" style={{ width: 24, height: 24, marginRight: 8 }} />
          <h1>Notisky</h1>
      </div>
      <div className="content">
         {renderContent()}
      </div>
    </div>
  );
}

export default PopupApp;
